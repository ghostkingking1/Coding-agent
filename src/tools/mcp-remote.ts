import crypto from "node:crypto";
import type { JsonObject, JsonSchema, ToolCapability } from "../agent/types.ts";
import { FetchHttpTransport, type HttpTransport, type HttpStreamResponse } from "../model/transport.ts";
import { ModelTransportError } from "../model/errors.ts";
import { McpProtocolError } from "./mcp.ts";
import { FileCredentialStore, OAuthAuthenticator, discoverAuthorizationServerMetadata, discoverProtectedResourceMetadata, type CredentialStore, type OAuthAuthorizationServerMetadata } from "./mcp-auth.ts";
import type { McpClient, McpListedTool, McpPrompt, McpPromptResult, McpResource, McpResourceResult, McpToolResult } from "./mcp-types.ts";

const MODERN_PROTOCOL_VERSIONS = ["2026-07-28"] as const;
const LEGACY_PROTOCOL_VERSIONS = ["2025-11-25"] as const;
const ACCEPTED_PROTOCOL_VERSIONS = ["2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25", "2026-07-28"] as const;
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_MESSAGE_BYTES = 256 * 1024;
const DEFAULT_MAX_TOOL_COUNT = 64;
const DEFAULT_MAX_RESOURCE_COUNT = 256;
const DEFAULT_MAX_PROMPT_COUNT = 128;
const DEFAULT_MAX_CONCURRENT_CALLS = 4;
const MAX_CURSOR_LENGTH = 4096;

export interface McpRemoteServerConfig {
  readonly id: string;
  readonly endpoint: string;
  readonly enabled?: boolean;
  /** 远程业务能力与本机用于连接 Server 的 network capability 分开计算。 */
  readonly remoteCapabilities: readonly ToolCapability[];
  readonly oauth?: {
    readonly clientId?: string;
    readonly scopes?: readonly string[];
    readonly authorizationServer?: string;
    readonly resource?: string;
  };
  readonly timeoutMs?: number;
  readonly maxMessageBytes?: number;
  readonly maxToolCount?: number;
  readonly maxResourceCount?: number;
  readonly maxPromptCount?: number;
  readonly maxConcurrentCalls?: number;
  readonly allowInsecureLocalhost?: boolean;
}

export interface McpRemoteClientOptions {
  readonly transport?: HttpTransport;
  readonly credentialStore?: CredentialStore;
  readonly authenticator?: OAuthAuthenticator;
  readonly fetch?: typeof globalThis.fetch;
  readonly userAgent?: string;
}

interface NormalizedRemoteConfig extends McpRemoteServerConfig {
  readonly endpointUrl: URL;
  readonly timeoutMs: number;
  readonly maxMessageBytes: number;
  readonly maxToolCount: number;
  readonly maxResourceCount: number;
  readonly maxPromptCount: number;
  readonly maxConcurrentCalls: number;
}
interface RpcResponse { readonly jsonrpc: "2.0"; readonly id: number; readonly result?: unknown; readonly error?: { readonly code?: number; readonly message?: string; readonly data?: unknown }; }
interface ParsedRpcResponse extends RpcResponse { readonly eventId?: string; }
interface PageResult<T> { readonly values: readonly T[]; readonly nextCursor?: string; }

/** 使用受限 HTTP transport 连接远程 Streamable HTTP MCP Server。 */
export class McpRemoteClient implements McpClient {
  readonly serverId: string;
  readonly capabilities: readonly ToolCapability[];
  private readonly config: NormalizedRemoteConfig;
  private readonly transport: HttpTransport;
  private readonly authenticator: OAuthAuthenticator;
  private readonly userAgent: string;
  private readonly fetch?: typeof globalThis.fetch;
  private readonly semaphore: Semaphore;
  private protocolVersion?: string;
  private mode?: "modern" | "legacy";
  private remoteSessionId?: string;
  private initialized = false;
  private initialization?: Promise<void>;
  private sequence = 0;
  private tools?: readonly McpListedTool[];
  private resources?: readonly McpResource[];
  private prompts?: readonly McpPrompt[];
  private oauthMetadata?: OAuthAuthorizationServerMetadata;
  private lastEventId?: string;
  private serverCapabilities?: { readonly tools: boolean; readonly resources: boolean; readonly prompts: boolean };
  private discoveredAuthorizationServer?: string;

  constructor(config: McpRemoteServerConfig, options: McpRemoteClientOptions = {}) {
    this.config = normalizeConfig(config);
    this.serverId = this.config.id;
    this.capabilities = ["network", ...this.config.remoteCapabilities.filter((capability) => capability !== "network")];
    this.transport = options.transport ?? new FetchHttpTransport({ defaultTimeoutMs: this.config.timeoutMs, defaultMaxResponseBytes: this.config.maxMessageBytes });
    this.authenticator = options.authenticator ?? new OAuthAuthenticator(options.credentialStore ?? new FileCredentialStore(), options.fetch);
    this.userAgent = options.userAgent ?? "coding-agent/0.1.0";
    this.fetch = options.fetch;
    this.semaphore = new Semaphore(this.config.maxConcurrentCalls);
  }

  get serverDigest(): string { return digest({ ...this.config, endpointUrl: this.config.endpointUrl.toString() }); }
  get endpointOrigin(): string { return this.config.endpointUrl.origin; }
  get protocol(): string | undefined { return this.protocolVersion; }
  get capabilitySnapshot() { return { backend: "remote-http", version: this.protocolVersion ?? "uninitialized", capabilities: ["network", "streamable-http", ...(this.serverCapabilities?.resources ? ["resources"] : []), ...(this.serverCapabilities?.prompts ? ["prompts"] : [])] as readonly string[] }; }
  get supportsTools(): boolean | undefined { return this.serverCapabilities?.tools; }
  get supportsResources(): boolean | undefined { return this.serverCapabilities?.resources; }
  get supportsPrompts(): boolean | undefined { return this.serverCapabilities?.prompts; }

  async connect(signal?: AbortSignal): Promise<void> {
    await this.ensureInitialized(signal);
  }

  async listTools(signal?: AbortSignal): Promise<readonly McpListedTool[]> {
    await this.ensureInitialized(signal);
    if (this.supportsTools === false) return [];
    if (this.tools) return this.tools;
    const page = await this.listPage<McpListedTool>("tools/list", "tools", signal);
    if (page.values.length > this.config.maxToolCount) throw new McpProtocolError("MCP tools/list result exceeds tool limit");
    this.tools = page.values;
    return this.tools;
  }

  async callTool(name: string, args: JsonObject, signal?: AbortSignal): Promise<McpToolResult> {
    await this.ensureInitialized(signal);
    if (this.supportsTools === false) throw new McpProtocolError("MCP server does not declare tools capability");
    const tools = await this.listTools(signal);
    if (!tools.some((tool) => tool.name === name)) throw new McpProtocolError(`MCP tool is not declared by server: ${name}`);
    const result = await this.request("tools/call", { name, arguments: args }, signal, true);
    if (!isRecord(result) || !Array.isArray(result.content)) throw new McpProtocolError("Invalid MCP tools/call result");
    return { content: result.content, isError: result.isError === true };
  }

  async listResources(signal?: AbortSignal): Promise<readonly McpResource[]> {
    await this.ensureInitialized(signal);
    if (this.supportsResources === false) return [];
    if (this.resources) return this.resources;
    const page = await this.listPage<McpResource>("resources/list", "resources", signal);
    if (page.values.length > this.config.maxResourceCount) throw new McpProtocolError("MCP resources/list result exceeds resource limit");
    this.resources = page.values;
    return this.resources;
  }

  async readResource(uri: string, signal?: AbortSignal): Promise<McpResourceResult> {
    if (!uri.trim() || uri.length > MAX_CURSOR_LENGTH) throw new McpProtocolError("Invalid MCP resource URI");
    await this.ensureInitialized(signal);
    if (this.supportsResources === false) throw new McpProtocolError("MCP server does not declare resources capability");
    const result = await this.request("resources/read", { uri }, signal, true);
    if (!isRecord(result) || !Array.isArray(result.contents)) throw new McpProtocolError("Invalid MCP resources/read result");
    return { contents: result.contents };
  }

  async listPrompts(signal?: AbortSignal): Promise<readonly McpPrompt[]> {
    await this.ensureInitialized(signal);
    if (this.supportsPrompts === false) return [];
    if (this.prompts) return this.prompts;
    const page = await this.listPage<McpPrompt>("prompts/list", "prompts", signal);
    if (page.values.length > this.config.maxPromptCount) throw new McpProtocolError("MCP prompts/list result exceeds prompt limit");
    this.prompts = page.values;
    return this.prompts;
  }

  async getPrompt(name: string, args: JsonObject = {}, signal?: AbortSignal): Promise<McpPromptResult> {
    await this.ensureInitialized(signal);
    if (this.supportsPrompts === false) throw new McpProtocolError("MCP server does not declare prompts capability");
    const prompts = await this.listPrompts(signal);
    if (!prompts.some((prompt) => prompt.name === name)) throw new McpProtocolError(`MCP prompt is not declared by server: ${name}`);
    const result = await this.request("prompts/get", { name, arguments: args }, signal, true);
    if (!isRecord(result) || !Array.isArray(result.messages)) throw new McpProtocolError("Invalid MCP prompts/get result");
    return { ...(typeof result.description === "string" ? { description: result.description } : {}), messages: result.messages };
  }

  async close(): Promise<void> {
    this.initialized = false;
    this.protocolVersion = undefined;
    this.mode = undefined;
    this.remoteSessionId = undefined;
    this.lastEventId = undefined;
    this.tools = undefined;
    this.resources = undefined;
    this.prompts = undefined;
    this.serverCapabilities = undefined;
    this.oauthMetadata = undefined;
    this.discoveredAuthorizationServer = undefined;
  }

  private async ensureInitialized(signal?: AbortSignal): Promise<void> {
    if (this.initialized) return;
    if (this.initialization) return this.initialization;
    this.initialization = this.initializeOnce(signal).finally(() => { this.initialization = undefined; });
    return this.initialization;
  }

  private async initializeOnce(signal?: AbortSignal): Promise<void> {
    try {
      let version: string = MODERN_PROTOCOL_VERSIONS[0];
      let result: unknown;
      try { result = await this.request("server/discover", {}, signal, true, version, true); }
      catch (error) {
        const supported = error instanceof ModelTransportError ? error.supportedProtocolVersions : error instanceof RemoteRpcError ? error.supportedProtocolVersions : undefined;
        const code = error instanceof ModelTransportError ? error.rpcErrorCode : error instanceof RemoteRpcError ? error.rpcErrorCode : undefined;
        if (code !== -32022) throw error;
        const compatible = supported?.find((candidate) => ACCEPTED_PROTOCOL_VERSIONS.includes(candidate as typeof ACCEPTED_PROTOCOL_VERSIONS[number]));
        if (!compatible || compatible === version) throw new McpProtocolError("MCP server does not support a compatible protocol version");
        version = compatible;
        result = await this.request("server/discover", {}, signal, true, version, true);
      }
      if (!isRecord(result) || !Array.isArray(result.supportedVersions)) throw new McpProtocolError("Invalid MCP server/discover response");
      const selected = result.supportedVersions.find((candidate): candidate is string => candidate === version);
      if (!selected) throw new McpProtocolError("MCP server does not support a compatible protocol version");
      const capabilities = isRecord(result.capabilities) ? result.capabilities : {};
      this.serverCapabilities = { tools: "tools" in capabilities, resources: "resources" in capabilities, prompts: "prompts" in capabilities };
      this.protocolVersion = selected;
      this.mode = "modern";
      this.initialized = true;
      return;
    } catch (error) {
      if (!(error instanceof ModelTransportError) || ![400, 404, 405].includes(error.status ?? 0) || error.rpcErrorCode === -32022) throw error;
    }
    let lastError: unknown;
    for (const version of LEGACY_PROTOCOL_VERSIONS) {
      try {
        const result = await this.request("initialize", { protocolVersion: version, capabilities: {}, clientInfo: { name: "coding-agent", version: "0.1.0" } }, signal, true, version);
        if (!isRecord(result) || typeof result.protocolVersion !== "string" || !isRecord(result.serverInfo) || typeof result.serverInfo.name !== "string") throw new McpProtocolError("Invalid MCP initialize response");
        if (!ACCEPTED_PROTOCOL_VERSIONS.includes(result.protocolVersion as typeof ACCEPTED_PROTOCOL_VERSIONS[number])) throw new McpProtocolError("MCP server returned an unsupported protocol version");
        const capabilities = isRecord(result.capabilities) ? result.capabilities : {};
        this.serverCapabilities = { tools: "tools" in capabilities, resources: "resources" in capabilities, prompts: "prompts" in capabilities };
        this.protocolVersion = result.protocolVersion;
        this.mode = "legacy";
        await this.notify("notifications/initialized", {}, signal);
        this.initialized = true;
        return;
      } catch (error) { lastError = error; this.remoteSessionId = undefined; this.protocolVersion = undefined; if (!isProtocolVersionRejection(error)) throw error; }
    }
    throw lastError instanceof Error ? lastError : new McpProtocolError("MCP initialization failed");
  }
  private async listPage<T>(method: string, field: string, signal?: AbortSignal): Promise<PageResult<T>> {
    const values: T[] = [];
    let cursor: string | undefined;
    const names = new Set<string>();
    const cursors = new Set<string>();
    do {
      if (cursor) {
        if (cursors.has(cursor)) throw new McpProtocolError("MCP pagination cursor repeated");
        cursors.add(cursor);
      }
      const result = await this.request(method, cursor ? { cursor } : {}, signal, true);
      if (!isRecord(result) || !Array.isArray(result[field])) throw new McpProtocolError(`Invalid MCP ${method} result`);
      for (const value of result[field]) {
         const parsed = parseSurface(field, value) as T & { readonly name?: string };
         if (typeof parsed.name === "string" && names.has(parsed.name)) throw new McpProtocolError(`Duplicate MCP ${field} name`);
         if (typeof parsed.name === "string") names.add(parsed.name);
         values.push(parsed);
       }
      if (values.length > this.maxFor(field)) throw new McpProtocolError(`MCP ${method} result exceeds resource limit`);
      const next = result.nextCursor;
      if (next !== undefined && (typeof next !== "string" || next.length > MAX_CURSOR_LENGTH)) throw new McpProtocolError("Invalid MCP pagination cursor");
      cursor = typeof next === "string" && next.length > 0 ? next : undefined;
    } while (cursor);
    return { values };
  }

  private maxFor(field: string): number { return field === "tools" ? this.config.maxToolCount : field === "resources" ? this.config.maxResourceCount : this.config.maxPromptCount; }

  private async notify(method: string, params: JsonObject, signal?: AbortSignal): Promise<void> {
    await this.send(method, params, signal, false, true);
  }

  private async request(method: string, params: JsonObject, signal: AbortSignal | undefined, retryAuth: boolean, protocolVersion = this.protocolVersion, modernProbe = false): Promise<unknown> {
    return this.send(method, params, signal, retryAuth, false, protocolVersion, method !== "tools/call", modernProbe);
  }

  private async send(method: string, params: JsonObject, signal: AbortSignal | undefined, retryAuth: boolean, notification: boolean, protocolVersion = this.protocolVersion, retrySafe = method !== "tools/call" && method !== "initialize" && method !== "notifications/initialized", modernProbe = false): Promise<unknown> {
    const release = await this.semaphore.acquire(signal);
    try {
      const id = notification ? undefined : ++this.sequence;
      let authRetried = false;
      let safeRetried = false;
      for (;;) {
        const headers: Record<string, string> = { accept: "application/json, text/event-stream", "content-type": "application/json", "user-agent": this.userAgent };
        if (protocolVersion) headers["mcp-protocol-version"] = protocolVersion;
        if (!modernProbe && this.mode !== "modern" && this.remoteSessionId) headers["mcp-session-id"] = this.remoteSessionId;
        if (!modernProbe && this.mode !== "modern" && this.lastEventId) headers["last-event-id"] = this.lastEventId;
        this.oauthMetadata ??= this.config.oauth?.authorizationServer
          ? await discoverAuthorizationServerMetadata(this.config.oauth.authorizationServer, signal, this.fetch)
          : undefined;
        const credential = await this.authenticator.getAccessToken(this.serverId, this.config.endpoint, this.oauthMetadata, { clientId: this.config.oauth?.clientId, resource: this.config.oauth?.resource, scopes: this.config.oauth?.scopes }, signal);
        if (credential) headers.authorization = `${credential.tokenType} ${credential.accessToken}`;
        const modern = modernProbe || this.mode === "modern";
        if (modern) {
          headers["mcp-method"] = method;
          if (typeof params.name === "string") headers["mcp-name"] = params.name;
        }
        const body = JSON.stringify({ jsonrpc: "2.0", ...(id === undefined ? {} : { id }), method, params: modern ? { ...params, _meta: { protocolVersion: protocolVersion ?? MODERN_PROTOCOL_VERSIONS[0], clientInfo: { name: "coding-agent", version: "0.1.0" }, clientCapabilities: {} } } : params });
        if (Buffer.byteLength(body, "utf8") > this.config.maxMessageBytes) throw new McpProtocolError("MCP request exceeds message limit");
        let response;
        try {
          response = await this.requestHttp({ url: this.config.endpointUrl, signal, timeoutMs: this.config.timeoutMs, maxResponseBytes: this.config.maxMessageBytes, init: { method: "POST", headers, redirect: "error", body } });
        } catch (error) {
          if (retryAuth && !authRetried && error instanceof ModelTransportError && error.code === "unauthorized" && credential?.refreshToken) {
            authRetried = true;
            await this.refreshAfterUnauthorized(signal, error);
            continue;
          }
          if (retrySafe && !safeRetried && isRetryableTransportError(error)) {
            safeRetried = true;
            await delay(retryDelay(error), signal);
            continue;
          }
          throw error;
        }
        const sessionId = modern ? null : response.headers.get("mcp-session-id");
        if (sessionId) this.remoteSessionId = sessionId;
        const responseEventId = modern ? null : response.headers.get("last-event-id");
        if (responseEventId) this.lastEventId = responseEventId.slice(0, MAX_CURSOR_LENGTH);
        if (notification) return undefined;
        const rpc = parseRpcResponse(response.bodyText, id!);
        if (!modern && rpc.eventId) this.lastEventId = rpc.eventId.slice(0, MAX_CURSOR_LENGTH);
        if (rpc.error) {
          if (retryAuth && !authRetried && isUnauthorizedRpcError(rpc.error.code) && credential?.refreshToken) {
            authRetried = true;
            await this.refreshAfterUnauthorized(signal);
            continue;
          }
          throw new RemoteRpcError(method, rpc.error.code, rpc.error.data);
        }
        if (!("result" in rpc)) throw new McpProtocolError(`MCP ${method} response has no result`);
        return rpc.result;
      }
    } finally {
      release();
    }
  }

  private async refreshAfterUnauthorized(signal?: AbortSignal, transportError?: ModelTransportError): Promise<void> {
    if (!this.config.oauth?.authorizationServer && transportError?.resourceMetadataUrl) {
      const protectedMetadata = await discoverProtectedResourceMetadata(this.config.endpoint, signal, this.fetch, transportError.resourceMetadataUrl);
      this.discoveredAuthorizationServer = protectedMetadata.authorizationServers?.[0];
    }
    const issuer = this.config.oauth?.authorizationServer ?? this.discoveredAuthorizationServer;
    if (!issuer) throw new McpProtocolError("MCP authentication expired and authorization metadata is unavailable");
    this.oauthMetadata ??= await discoverAuthorizationServerMetadata(issuer, signal, this.fetch);
    const credential = await this.authenticator.refreshAccessToken(this.serverId, this.config.endpoint, this.oauthMetadata, { clientId: this.config.oauth?.clientId, resource: this.config.oauth?.resource, scopes: this.config.oauth?.scopes }, signal);
    if (!credential) throw new McpProtocolError("MCP authentication expired; run /mcp login");
  }

  private async requestHttp(request: Parameters<HttpTransport["request"]>[0]): Promise<{ readonly status: number; readonly headers: Headers; readonly bodyText: string; readonly requestId?: string }> {
    if (!this.transport.requestStream) return this.transport.request(request);
    const response: HttpStreamResponse = await this.transport.requestStream(request);
    const chunks: Uint8Array[] = [];
    let length = 0;
    for await (const chunk of response.body) {
      length += chunk.byteLength;
      if (length > this.config.maxMessageBytes) throw new McpProtocolError("MCP response exceeds message limit");
      chunks.push(chunk);
    }
    const body = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
    return { status: response.status, headers: response.headers, bodyText: new TextDecoder().decode(body), requestId: response.requestId };
  }
}

function normalizeConfig(config: McpRemoteServerConfig): NormalizedRemoteConfig {
  if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(config.id)) throw new Error("MCP server id must be a safe identifier");
  let endpointUrl: URL;
  try { endpointUrl = new URL(config.endpoint); } catch { throw new Error("MCP endpoint must be a valid URL"); }
  const hostname = endpointUrl.hostname.toLowerCase();
  const localhost = hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]";
  if (endpointUrl.protocol !== "https:" && !(localhost && config.allowInsecureLocalhost && endpointUrl.protocol === "http:")) throw new Error("Remote MCP endpoint must use HTTPS, except explicitly allowed localhost");
  if (endpointUrl.username || endpointUrl.password || endpointUrl.hash || [...endpointUrl.searchParams.keys()].some((key) => /token|secret|authorization/i.test(key))) throw new Error("MCP endpoint must not contain credentials or token query parameters");
  if (!config.remoteCapabilities.length || config.remoteCapabilities.some((capability) => !["read", "write", "execute", "network"].includes(capability))) throw new Error("MCP remoteCapabilities must be explicitly declared");
  const timeoutMs = positive(config.timeoutMs ?? DEFAULT_TIMEOUT_MS, "timeoutMs");
  const maxMessageBytes = positive(config.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES, "maxMessageBytes");
  const maxToolCount = positive(config.maxToolCount ?? DEFAULT_MAX_TOOL_COUNT, "maxToolCount");
  const maxResourceCount = positive(config.maxResourceCount ?? DEFAULT_MAX_RESOURCE_COUNT, "maxResourceCount");
  const maxPromptCount = positive(config.maxPromptCount ?? DEFAULT_MAX_PROMPT_COUNT, "maxPromptCount");
  const maxConcurrentCalls = positive(config.maxConcurrentCalls ?? DEFAULT_MAX_CONCURRENT_CALLS, "maxConcurrentCalls");
  return { ...config, endpointUrl, timeoutMs, maxMessageBytes, maxToolCount, maxResourceCount, maxPromptCount, maxConcurrentCalls };
}
function positive(value: number, name: string): number { if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`); return value; }
function parseSurface(field: string, value: unknown): never | McpListedTool | McpResource | McpPrompt {
  if (!isRecord(value)) throw new McpProtocolError(`Invalid MCP ${field} entry`);
  if (field === "tools") {
    if (typeof value.name !== "string" || !/^[A-Za-z][A-Za-z0-9_-]{0,127}$/.test(value.name)) throw new McpProtocolError("Invalid MCP tool name");
    if (value.description !== undefined && typeof value.description !== "string") throw new McpProtocolError("Invalid MCP tool description");
    if (value.inputSchema !== undefined && (!isRecord(value.inputSchema) || !isJsonSchema(value.inputSchema))) throw new McpProtocolError("Invalid MCP tool input schema");
    return { name: value.name, ...(typeof value.description === "string" ? { description: value.description } : {}), ...(isRecord(value.inputSchema) ? { inputSchema: value.inputSchema as JsonSchema } : {}) };
  }
  if (field === "resources") {
    if (typeof value.uri !== "string" || !value.uri.trim() || value.uri.length > MAX_CURSOR_LENGTH || typeof value.name !== "string") throw new McpProtocolError("Invalid MCP resource");
    return { uri: value.uri, name: value.name, ...(typeof value.description === "string" ? { description: value.description } : {}), ...(typeof value.mimeType === "string" ? { mimeType: value.mimeType } : {}) };
  }
  if (typeof value.name !== "string" || !/^[A-Za-z][A-Za-z0-9_-]{0,127}$/.test(value.name)) throw new McpProtocolError("Invalid MCP prompt name");
  if (value.arguments !== undefined && (!Array.isArray(value.arguments) || value.arguments.length > 128)) throw new McpProtocolError("Invalid MCP prompt arguments");
  return { name: value.name, ...(typeof value.description === "string" ? { description: value.description } : {}), ...(Array.isArray(value.arguments) ? { arguments: value.arguments.filter(isRecord).map((arg) => ({ name: typeof arg.name === "string" ? arg.name : "argument", ...(typeof arg.description === "string" ? { description: arg.description } : {}), ...(typeof arg.required === "boolean" ? { required: arg.required } : {}) })) } : {}) };
}
class RemoteRpcError extends McpProtocolError {
  readonly rpcErrorCode?: number;
  readonly supportedProtocolVersions?: readonly string[];
  constructor(method: string, code?: number, data?: unknown) {
    super(`MCP ${method} failed with remote protocol error`);
    this.rpcErrorCode = code;
    const supported = isRecord(data) ? data.supported : undefined;
    if (code === -32022 && Array.isArray(supported) && supported.length <= 16 && supported.every((v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v))) this.supportedProtocolVersions = supported;
  }
}
function isProtocolVersionRejection(error: unknown): boolean {
  if (error instanceof ModelTransportError) return [400, 404, 405].includes(error.status ?? 0);
  return error instanceof RemoteRpcError && error.rpcErrorCode === -32022;
}

function parseRpcResponse(bodyText: string, id: number): ParsedRpcResponse {
  const trimmed = bodyText.trim();
  if (!trimmed) throw new McpProtocolError("Invalid MCP JSON-RPC response");
  const candidates: Array<{ readonly value: unknown; readonly eventId?: string }> = [];
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    const parsed = parseJson(trimmed);
    const values = Array.isArray(parsed) ? parsed : [parsed];
    for (const value of values) candidates.push({ value });
  } else if (trimmed.includes("data:")) {
    for (const event of trimmed.split(/\r?\n\r?\n/)) {
      const lines = event.split(/\r?\n/);
      const data = lines.filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("\n");
      if (!data) continue;
      const eventId = lines.find((line) => line.startsWith("id:"))?.slice(3).trim();
      const parsed = parseJson(data);
      const values = Array.isArray(parsed) ? parsed : [parsed];
      for (const value of values) candidates.push({ value, eventId });
    }
  }
  for (const candidate of candidates) {
    if (!isRecord(candidate.value) || candidate.value.jsonrpc !== "2.0") throw new McpProtocolError("Invalid MCP JSON-RPC response");
    if ("id" in candidate.value && candidate.value.id !== id) throw new McpProtocolError("MCP response has an unknown request id");
  }
  const match = candidates.find((candidate): candidate is { readonly value: RpcResponse; readonly eventId?: string } => isRecord(candidate.value) && candidate.value.jsonrpc === "2.0" && candidate.value.id === id);
  if (!match) throw new McpProtocolError("Invalid MCP JSON-RPC response");
  return { ...match.value, ...(match.eventId ? { eventId: match.eventId } : {}) };
}
function isUnauthorizedRpcError(code: number | undefined): boolean { return code === -32001 || code === 401; }

function parseJson(value: string): unknown { try { return JSON.parse(value); } catch { throw new McpProtocolError("Invalid MCP JSON response"); } }
function isRecord(value: unknown): value is Record<string, any> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function digest(value: unknown): string { return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex"); }

class Semaphore {
  private active = 0;
  private readonly limit: number;
  private readonly queue: { readonly resolve: (release: () => void) => void; readonly reject: (error: Error) => void; readonly signal?: AbortSignal }[] = [];
  constructor(limit: number) { this.limit = limit; }
  acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(signal.reason instanceof Error ? signal.reason : new McpProtocolError("MCP request aborted"));
    if (this.active < this.limit) { this.active++; return Promise.resolve(() => this.release()); }
    return new Promise((resolve, reject) => {
      const entry = { resolve, reject, signal };
      this.queue.push(entry);
      signal?.addEventListener("abort", () => { const index = this.queue.indexOf(entry); if (index >= 0) this.queue.splice(index, 1); reject(signal.reason instanceof Error ? signal.reason : new McpProtocolError("MCP request aborted")); }, { once: true });
    });
  }
  private release(): void { this.active--; const next = this.queue.shift(); if (!next) return; this.active++; next.resolve(() => this.release()); }
}


function isRetryableTransportError(error: unknown): error is ModelTransportError {
  return error instanceof ModelTransportError && ["network", "timeout", "rate_limited", "server_error"].includes(error.code);
}
function retryDelay(error: ModelTransportError): number {
  return Math.min(2000, Math.max(50, error.retryAfterMs ?? 250));
}
async function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new McpProtocolError("MCP request aborted");
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(done, milliseconds);
    const abort = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); reject(signal?.reason instanceof Error ? signal.reason : new McpProtocolError("MCP request aborted")); };
    function done() { signal?.removeEventListener("abort", abort); resolve(); }
    signal?.addEventListener("abort", abort, { once: true });
  });
}

function isJsonSchema(value: Record<string, unknown>, depth = 0): boolean {
  if (depth > 16 || Object.keys(value).length > 128) return false;
  if (value.type !== undefined && (typeof value.type !== "string" || !["object", "array", "string", "number", "integer", "boolean", "null"].includes(value.type))) return false;
  if (value.properties !== undefined) {
    if (!isRecord(value.properties) || !Object.entries(value.properties).every(([, child]) => isRecord(child) && isJsonSchema(child, depth + 1))) return false;
  }
  if (value.items !== undefined && (!isRecord(value.items) || !isJsonSchema(value.items, depth + 1))) return false;
  if (value.required !== undefined && (!Array.isArray(value.required) || !value.required.every((item) => typeof item === "string" && item.length <= 128))) return false;
  return true;
}
