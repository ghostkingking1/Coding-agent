import crypto from "node:crypto";
import { z } from "zod";
import type { ChildProcess } from "node:child_process";
import type { JsonObject, JsonSchema, JsonValue, Tool, ToolCapability, ToolContext } from "../agent/types.ts";
import type { McpClient, McpListedTool, McpPrompt, McpPromptResult, McpResource, McpResourceResult, McpToolResult } from "./mcp-types.ts";
export type { McpClient, McpListedTool, McpPrompt, McpPromptResult, McpResource, McpResourceResult, McpToolResult } from "./mcp-types.ts";
import { defineTool } from "./tool-schema.ts";
import type { SandboxBackend } from "./sandbox.ts";
import { WorkspacePolicy } from "./security.ts";

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_MESSAGE_BYTES = 256 * 1024;
const DEFAULT_MAX_TOOL_COUNT = 64;

/** 本地 MCP Server 的启动信息完全由宿主配置，模型永远不能传入这些字段。 */
export interface McpStdioServerConfig {
  readonly id: string;
  readonly executable: string;
  readonly args?: readonly string[];
  /** 相对于 WorkspacePolicy 根目录的固定 Server 工作目录。 */
  readonly cwd?: string;
  readonly env: Readonly<Record<string, string>>;
  readonly toolCapabilities: readonly ToolCapability[];
  readonly timeoutMs?: number;
  readonly maxMessageBytes?: number;
  readonly maxToolCount?: number;
}

export interface McpToolPreview {
  readonly serverId: string;
  readonly serverDigest: string;
  readonly mcpToolName: string;
  readonly arguments: JsonObject;
  readonly capabilitySnapshot: { readonly backend: string; readonly version: string; readonly capabilities: readonly string[] };
  readonly endpointOrigin?: string;
  readonly operation?: string;
  /** 覆盖 Server、工具、参数和能力快照的审批绑定摘要。 */
  readonly requestDigest: string;
}

interface NormalizedConfig extends Required<Omit<McpStdioServerConfig, "args" | "timeoutMs" | "maxMessageBytes" | "maxToolCount">> {
  readonly workspaceRoot: string;
  readonly args: readonly string[];
  readonly timeoutMs: number;
  readonly maxMessageBytes: number;
  readonly maxToolCount: number;
}

interface RpcSuccess { readonly jsonrpc: "2.0"; readonly id: number; readonly result: unknown; }

/** MCP 初始化、发现或调用失败时统一拒绝，防止协议异常退化为宿主进程访问。 */
export class McpProtocolError extends Error {
  constructor(message: string) { super(message); this.name = "McpProtocolError"; }
}

/** 连接一个固定的本地 stdio Server，并将其发现的 tools 适配为普通 Tool。 */
export class McpStdioClient {
  private readonly config: NormalizedConfig;
  private readonly sandbox: SandboxBackend;
  private child?: ChildProcess;
  private sequence = 0;
  private buffer = Buffer.alloc(0);
  private pending = new Map<number, { resolve(value: unknown): void; reject(reason: Error): void; timer: ReturnType<typeof setTimeout> }>();
  private initialized = false;
  private tools?: readonly McpListedTool[];

  constructor(config: McpStdioServerConfig, workspace: WorkspacePolicy, sandbox: SandboxBackend) {
    this.config = normalizeConfig(config, workspace);
    this.sandbox = sandbox;
    sandbox.assertAvailable(["process.spawn", "workspace.fs", "network.off", "os.isolation"]);
  }

  async connect(signal?: AbortSignal): Promise<void> {
    await this.initialize(signal);
  }

  async listResources(_signal?: AbortSignal): Promise<readonly McpResource[]> {
    return [];
  }

  async readResource(_uri: string, _signal?: AbortSignal): Promise<McpResourceResult> {
    throw new McpProtocolError("MCP stdio server does not expose resources");
  }

  async listPrompts(_signal?: AbortSignal): Promise<readonly McpPrompt[]> {
    return [];
  }

  async getPrompt(_name: string, _args?: JsonObject, _signal?: AbortSignal): Promise<McpPromptResult> {
    throw new McpProtocolError("MCP stdio server does not expose prompts");
  }

  async listTools(signal?: AbortSignal): Promise<readonly McpListedTool[]> {
    await this.initialize(signal);
    if (this.tools) return this.tools;
    const result = await this.request("tools/list", {}, signal);
    if (!isRecord(result) || !Array.isArray(result.tools) || result.tools.length > this.config.maxToolCount) throw new McpProtocolError("Invalid or oversized MCP tools/list result");
    const names = new Set<string>();
    this.tools = result.tools.map((value) => parseListedTool(value, names));
    return this.tools;
  }

  async callTool(name: string, args: JsonObject, signal?: AbortSignal): Promise<McpToolResult> {
    const tools = await this.listTools(signal);
    if (!tools.some((tool) => tool.name === name)) throw new McpProtocolError(`MCP tool is not declared by server: ${name}`);
    const result = await this.request("tools/call", { name, arguments: args }, signal);
    if (!isRecord(result) || !Array.isArray(result.content)) throw new McpProtocolError("Invalid MCP tools/call result");
    const serialized = JSON.stringify(result);
    if (Buffer.byteLength(serialized, "utf8") > this.config.maxMessageBytes) throw new McpProtocolError("MCP tool result exceeds message limit");
    return { content: result.content, isError: result.isError === true };
  }

  async close(): Promise<void> {
    const child = this.child;
    this.child = undefined;
    this.initialized = false;
    this.tools = undefined;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new McpProtocolError("MCP client closed")); }
    this.pending.clear();
    if (!child || child.exitCode !== null) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 1_000);
      child.once("exit", () => { clearTimeout(timer); resolve(); });
      child.kill();
    });
  }

  private async initialize(signal?: AbortSignal): Promise<void> {
    if (this.initialized) return;
    this.start();
    const result = await this.request("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "coding-agent", version: "0.1.0" } }, signal);
    if (!isRecord(result) || typeof result.protocolVersion !== "string" || !isRecord(result.serverInfo) || typeof result.serverInfo.name !== "string") throw new McpProtocolError("Invalid MCP initialize response");
    this.notify("notifications/initialized", {});
    this.initialized = true;
  }

  private start(): void {
    if (this.child && this.child.exitCode === null) return;
    this.sandbox.assertAvailable(["process.spawn", "workspace.fs", "network.off", "os.isolation"]);
    const child = this.sandbox.spawn({ executionId: crypto.randomUUID(), workspaceRoot: this.config.workspaceRoot, executable: this.config.executable, args: this.config.args, cwd: this.config.cwd, env: this.config.env, timeoutMs: this.config.timeoutMs, maxStdoutBytes: this.config.maxMessageBytes, maxStderrBytes: this.config.maxMessageBytes, network: "off", cpuTimeMs: this.config.timeoutMs, memoryBytes: 512 * 1024 * 1024, maxProcesses: 64, stdio: ["pipe", "pipe", "pipe"] });
    this.child = child;
    child.stdout?.on("data", (chunk: Buffer) => this.receive(chunk));
    child.stderr?.on("data", (chunk: Buffer) => { if (Buffer.byteLength(chunk) > this.config.maxMessageBytes) this.fail(new McpProtocolError("MCP stderr exceeds message limit")); });
    child.on("error", (error) => this.fail(new McpProtocolError(`MCP server failed: ${error.message}`)));
    child.on("exit", () => this.fail(new McpProtocolError("MCP server exited")));
  }

  private request(method: string, params: JsonObject, signal?: AbortSignal): Promise<unknown> {
    if (signal?.aborted) return Promise.reject(signal.reason ?? new McpProtocolError("MCP call aborted"));
    const id = ++this.sequence;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new McpProtocolError(`MCP ${method} timed out`)); }, this.config.timeoutMs);
      const abort = () => { clearTimeout(timer); this.pending.delete(id); reject(signal?.reason ?? new McpProtocolError("MCP call aborted")); };
      signal?.addEventListener("abort", abort, { once: true });
      this.pending.set(id, { resolve: (value) => { signal?.removeEventListener("abort", abort); resolve(value); }, reject: (error) => { signal?.removeEventListener("abort", abort); reject(error); }, timer });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  private notify(method: string, params: JsonObject): void { this.write({ jsonrpc: "2.0", method, params }); }
  private write(message: unknown): void {
    const text = JSON.stringify(message);
    if (Buffer.byteLength(text, "utf8") > this.config.maxMessageBytes) throw new McpProtocolError("MCP request exceeds message limit");
    if (!this.child?.stdin?.writable) throw new McpProtocolError("MCP server stdin is unavailable");
    this.child.stdin.write(`${text}\n`);
  }
  private receive(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    if (this.buffer.byteLength > this.config.maxMessageBytes) { this.fail(new McpProtocolError("MCP response exceeds message limit")); return; }
    let newline: number;
    while ((newline = this.buffer.indexOf(0x0a)) >= 0) {
      const line = this.buffer.subarray(0, newline).toString("utf8").trim(); this.buffer = this.buffer.subarray(newline + 1);
      if (!line) continue;
      let message: unknown; try { message = JSON.parse(line); } catch { this.fail(new McpProtocolError("Invalid MCP JSON-RPC message")); return; }
      if (!isRpcSuccess(message)) { this.fail(new McpProtocolError("Invalid MCP JSON-RPC response")); return; }
      const pending = this.pending.get(message.id); if (!pending) continue;
      this.pending.delete(message.id); clearTimeout(pending.timer); pending.resolve(message.result);
    }
  }
  private fail(error: Error): void { for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); } this.pending.clear(); }

  get serverDigest(): string { return digest(this.config); }
  get capabilitySnapshot(): McpToolPreview["capabilitySnapshot"] { return this.sandbox.capabilities; }
  get serverId(): string { return this.config.id; }
  get capabilities(): readonly ToolCapability[] { return this.config.toolCapabilities; }
}

/** 发现 Server 的工具并以稳定的前缀注册，避免与内建工具发生名称冲突。 */
export async function createMcpTools(client: McpClient): Promise<readonly Tool[]> {
  if (client.supportsTools === false) return [];
  const listed = await client.listTools();
  return listed.map((listedTool) => {
    const inputSchema = z.record(z.string(), z.unknown());
    return defineTool({
      name: `mcp_${client.serverId}_${listedTool.name}`,
      description: listedTool.description ?? `MCP tool ${listedTool.name}`,
      capabilities: client.capabilities,
      inputSchema,
      modelInputSchema: listedTool.inputSchema ?? { type: "object", additionalProperties: true },
      preview(input): McpToolPreview {
        const base = { serverId: client.serverId, serverDigest: client.serverDigest, mcpToolName: listedTool.name, arguments: canonicalObject(input), capabilitySnapshot: client.capabilitySnapshot, ...(client.endpointOrigin ? { endpointOrigin: client.endpointOrigin, operation: "tools/call" } : {}) };
        return { ...base, requestDigest: digest(base) };
      },
      async execute(input, context: ToolContext) {
        const base = { serverId: client.serverId, serverDigest: client.serverDigest, mcpToolName: listedTool.name, arguments: canonicalObject(input), capabilitySnapshot: client.capabilitySnapshot, ...(client.endpointOrigin ? { endpointOrigin: client.endpointOrigin, operation: "tools/call" } : {}) };
        const requestDigest = digest(base);
        try {
          const result = await client.callTool(listedTool.name, base.arguments, context.signal);
          await context.auditSink?.record({ sessionId: context.sessionId, runId: context.runId, eventType: "mcp_tool_call", toolName: `mcp_${client.serverId}_${listedTool.name}`, status: result.isError ? "error_result" : "completed", metadata: { serverId: client.serverId, serverDigest: client.serverDigest, requestDigest } });
          return result;
        } catch (error) {
          await context.auditSink?.record({ sessionId: context.sessionId, runId: context.runId, eventType: "mcp_tool_call", toolName: `mcp_${client.serverId}_${listedTool.name}`, status: "failed", metadata: { serverId: client.serverId, serverDigest: client.serverDigest, requestDigest } });
          throw error;
        }
      },
    });
  });
}

function normalizeConfig(config: McpStdioServerConfig, workspace: WorkspacePolicy): NormalizedConfig {
  if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(config.id)) throw new Error("MCP server id must be a safe identifier");
  if (!config.executable.trim()) throw new Error("MCP executable must be non-empty");
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS, maxMessageBytes = config.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES, maxToolCount = config.maxToolCount ?? DEFAULT_MAX_TOOL_COUNT;
  for (const [name, value] of [["timeoutMs", timeoutMs], ["maxMessageBytes", maxMessageBytes], ["maxToolCount", maxToolCount]] as const) if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  if (!config.toolCapabilities.length || config.toolCapabilities.includes("network")) throw new Error("MCP tools require explicit non-network capabilities");
  // Server cwd 与执行请求中的 workspaceRoot 都来自统一路径策略，防止配置的相对路径漂移出工作区。
  return { ...config, workspaceRoot: workspace.root, cwd: workspace.resolveDirectory(config.cwd ?? "."), args: config.args ?? [], timeoutMs, maxMessageBytes, maxToolCount };
}
function parseListedTool(value: unknown, names: Set<string>): McpListedTool { if (!isRecord(value) || typeof value.name !== "string" || !/^[A-Za-z][A-Za-z0-9_-]{0,127}$/.test(value.name) || names.has(value.name)) throw new McpProtocolError("Invalid or duplicate MCP tool name"); names.add(value.name); if (value.description !== undefined && typeof value.description !== "string") throw new McpProtocolError("Invalid MCP tool description"); if (value.inputSchema !== undefined && !isRecord(value.inputSchema)) throw new McpProtocolError("Invalid MCP tool input schema"); return { name: value.name, ...(typeof value.description === "string" ? { description: value.description } : {}), ...(isRecord(value.inputSchema) ? { inputSchema: value.inputSchema as JsonSchema } : {}) }; }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function isRpcSuccess(value: unknown): value is RpcSuccess { return isRecord(value) && value.jsonrpc === "2.0" && typeof value.id === "number" && "result" in value; }
function canonicalObject(value: Record<string, unknown>): JsonObject { return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right))) as JsonObject; }
function digest(value: unknown): string { return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex"); }


/** 为远程 resources 提供分页发现和受控读取入口；内容始终作为不可信 tool result 返回。 */
export async function createMcpResourceTools(client: McpClient): Promise<readonly Tool[]> {
  if (client.supportsResources === false) return [];
  return [
    defineTool({
      name: `mcp_${client.serverId}_list_resources`,
      description: `List resources exposed by MCP server ${client.serverId}`,
      capabilities: client.capabilities,
      inputSchema: z.object({}).strict(),
      modelInputSchema: { type: "object", additionalProperties: false },
      preview: () => surfacePreview(client, "resources/list"),
      execute: async (_input, context) => executeMcpOperation(client, "resources/list", {}, context, () => client.listResources(context.signal)),
    }),
    defineTool({
      name: `mcp_${client.serverId}_read_resource`,
      description: `Read a resource from MCP server ${client.serverId}`,
      capabilities: client.capabilities,
      inputSchema: z.object({ uri: z.string().min(1).max(4096) }).strict(),
      modelInputSchema: { type: "object", properties: { uri: { type: "string", minLength: 1, maxLength: 4096 } }, required: ["uri"], additionalProperties: false },
      preview: (input) => surfacePreview(client, "resources/read", { uri: input.uri }),
      execute: async (input, context) => executeMcpOperation(client, "resources/read", { uri: input.uri }, context, () => client.readResource(input.uri, context.signal)),
    }),
  ];
}

/** 为远程 prompts 提供受控发现和获取入口，不把远程返回内容提升为 system prompt。 */
export async function createMcpPromptTools(client: McpClient): Promise<readonly Tool[]> {
  if (client.supportsPrompts === false) return [];
  return [
    defineTool({
      name: `mcp_${client.serverId}_list_prompts`,
      description: `List prompts exposed by MCP server ${client.serverId}`,
      capabilities: client.capabilities,
      inputSchema: z.object({}).strict(),
      modelInputSchema: { type: "object", additionalProperties: false },
      preview: () => surfacePreview(client, "prompts/list"),
      execute: async (_input, context) => executeMcpOperation(client, "prompts/list", {}, context, () => client.listPrompts(context.signal)),
    }),
    defineTool({
      name: `mcp_${client.serverId}_get_prompt`,
      description: `Get a prompt from MCP server ${client.serverId}`,
      capabilities: client.capabilities,
      inputSchema: z.object({ name: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,127}$/), arguments: z.record(z.string(), z.unknown()).optional() }).strict(),
      modelInputSchema: { type: "object", properties: { name: { type: "string", pattern: "^[A-Za-z][A-Za-z0-9_-]{0,127}$" }, arguments: { type: "object", additionalProperties: true } }, required: ["name"], additionalProperties: false },
      preview: (input) => surfacePreview(client, "prompts/get", { name: input.name, ...(input.arguments ? { arguments: toJsonObject(input.arguments) } : {}) }),
      execute: async (input, context) => executeMcpOperation(client, "prompts/get", { name: input.name, ...(input.arguments ? { arguments: toJsonObject(input.arguments) } : {}) }, context, () => client.getPrompt(input.name, toJsonObject(input.arguments ?? {}), context.signal)),
    }),
  ];
}

export async function createMcpAgentTools(client: McpClient, options: { readonly includeResources?: boolean; readonly includePrompts?: boolean } = {}): Promise<readonly Tool[]> {
  const tools: Tool[] = [...await createMcpTools(client)];
  if (options.includeResources && client.supportsResources !== false) { await client.listResources(); tools.push(...await createMcpResourceTools(client)); }
  if (options.includePrompts && client.supportsPrompts !== false) { await client.listPrompts(); tools.push(...await createMcpPromptTools(client)); }
  return tools;
}

function surfacePreview(client: McpClient, operation: string, target: JsonObject = {}): McpToolPreview & { readonly operation: string } {
  const base = { serverId: client.serverId, serverDigest: client.serverDigest, mcpToolName: operation, arguments: canonicalObject(target), capabilitySnapshot: client.capabilitySnapshot, operation, ...(client.endpointOrigin ? { endpointOrigin: client.endpointOrigin } : {}) };
  return { ...base, requestDigest: digest(base) };
}



async function executeMcpOperation<T>(client: McpClient, operation: string, target: JsonObject, context: ToolContext, action: () => Promise<T>): Promise<T> {
  const requestDigest = digest({ serverId: client.serverId, serverDigest: client.serverDigest, endpointOrigin: client.endpointOrigin, operation, arguments: canonicalObject(target), capabilitySnapshot: client.capabilitySnapshot });
  try {
    const result = await action();
    await context.auditSink?.record({ sessionId: context.sessionId, runId: context.runId, eventType: "mcp_operation", toolName: `mcp_${client.serverId}_${operation.replace("/", "_")}`, status: "completed", metadata: { serverId: client.serverId, serverDigest: client.serverDigest, ...(client.endpointOrigin ? { endpointOrigin: client.endpointOrigin } : {}), operation, requestDigest } });
    return result;
  } catch (error) {
    await context.auditSink?.record({ sessionId: context.sessionId, runId: context.runId, eventType: "mcp_operation", toolName: `mcp_${client.serverId}_${operation.replace("/", "_")}`, status: "failed", metadata: { serverId: client.serverId, serverDigest: client.serverDigest, ...(client.endpointOrigin ? { endpointOrigin: client.endpointOrigin } : {}), operation, requestDigest, errorCode: error instanceof Error ? error.name : "unknown" } });
    throw error;
  }
}

function toJsonObject(value: Record<string, unknown>): JsonObject {
  const result: Record<string, JsonValue> = {};
  for (const [key, item] of Object.entries(value)) {
    if (!isJsonValue(item)) throw new McpProtocolError(`Invalid JSON value in MCP prompt arguments: ${key}`);
    result[key] = item;
  }
  return result;
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return true;
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (isRecord(value)) return Object.values(value).every(isJsonValue);
  return false;
}
