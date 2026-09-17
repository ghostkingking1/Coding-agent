import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";

export interface OAuthCredential {
  readonly accessToken: string;
  readonly refreshToken?: string;
  readonly tokenType: string;
  readonly expiresAt?: string;
  readonly scope?: readonly string[];
}

export interface CredentialStore {
  get(key: string): Promise<OAuthCredential | undefined>;
  set(key: string, credential: OAuthCredential): Promise<void>;
  delete(key: string): Promise<void>;
}

export class MemoryCredentialStore implements CredentialStore {
  private readonly values = new Map<string, OAuthCredential>();
  async get(key: string): Promise<OAuthCredential | undefined> { return this.values.get(key); }
  async set(key: string, credential: OAuthCredential): Promise<void> { this.values.set(key, credential); }
  async delete(key: string): Promise<void> { this.values.delete(key); }
}

/** 凭据文件位于用户目录而非 workspace，避免仓库内容影响授权边界。 */
export class FileCredentialStore implements CredentialStore {
  private readonly filePath: string;
  private loaded?: Record<string, OAuthCredential>;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(filePath = defaultCredentialPath()) { this.filePath = path.resolve(filePath); }

  async get(key: string): Promise<OAuthCredential | undefined> { return (await this.read())[key]; }
  async set(key: string, credential: OAuthCredential): Promise<void> {
    await this.mutate(async (values) => { values[key] = credential; });
  }
  async delete(key: string): Promise<void> {
    await this.mutate(async (values) => { delete values[key]; });
  }

  private async read(): Promise<Record<string, OAuthCredential>> {
    if (this.loaded) return this.loaded;
    try {
      const parsed: unknown = JSON.parse(await fs.readFile(this.filePath, "utf8"));
      if (!isRecord(parsed)) throw new Error("credential store must be an object");
      if (!Object.values(parsed).every((value) => isRecord(value))) throw new Error("credential store contains invalid credentials");
      this.loaded = parsed as Record<string, OAuthCredential>;
      for (const credential of Object.values(this.loaded)) validateCredential(credential);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("Unable to read OAuth credential store", { cause: error });
      this.loaded = {};
    }
    return this.loaded;
  }

  private async mutate(action: (values: Record<string, OAuthCredential>) => Promise<void>): Promise<void> {
    this.writeChain = this.writeChain.then(async () => {
      const values = await this.read();
      await action(values);
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      const temporary = `${this.filePath}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
      await fs.writeFile(temporary, `${JSON.stringify(values)}\n`, { encoding: "utf8", mode: 0o600 });
      try { await fs.chmod(temporary, 0o600); } catch { /* Windows 权限模型不支持 POSIX mode，文件仍不在 workspace 内。 */ }
      await fs.rename(temporary, this.filePath);
    });
    await this.writeChain;
  }
}

export interface OAuthAuthorizationServerMetadata {
  readonly authorizationEndpoint: string;
  readonly tokenEndpoint: string;
  readonly registrationEndpoint?: string;
  readonly scopesSupported?: readonly string[];
}

export interface OAuthProtectedResourceMetadata {
  readonly authorizationServers?: readonly string[];
  readonly scopesSupported?: readonly string[];
}

export interface BrowserLauncher { open(url: string): Promise<void> | void; }
export interface OAuthLoginOptions {
  readonly serverId: string;
  readonly endpoint: string;
  readonly clientId?: string;
  readonly scopes?: readonly string[];
  readonly authorizationServer?: string;
  readonly resource?: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly browserLauncher?: BrowserLauncher;
  readonly waitForAuthorizationCode?: (authorizationUrl: string, redirectUri: string) => Promise<{ readonly code: string; readonly state: string }>;
  readonly signal?: AbortSignal;
}

export interface OAuthTokenResponse {
  readonly access_token: string;
  readonly token_type?: string;
  readonly refresh_token?: string;
  readonly expires_in?: number;
  readonly scope?: string;
}

/** OAuth 元数据发现、PKCE 登录和 token refresh 的最小实现。 */
export class OAuthAuthenticator {
  private readonly store: CredentialStore;
  private readonly fetch: typeof globalThis.fetch;
  private readonly refreshes = new Map<string, Promise<OAuthCredential | undefined>>();

  constructor(store: CredentialStore = new MemoryCredentialStore(), fetchImpl: typeof globalThis.fetch = globalThis.fetch) { this.store = store; this.fetch = fetchImpl; }

  credentialKey(serverId: string, endpoint: string): string {
    return `${serverId}:${new URL(endpoint).origin}`;
  }

  async getAccessToken(serverId: string, endpoint: string, metadata: OAuthAuthorizationServerMetadata | undefined, oauth: Pick<OAuthLoginOptions, "clientId" | "resource" | "scopes"> = {}, signal?: AbortSignal): Promise<OAuthCredential | undefined> {
    const key = this.credentialKey(serverId, endpoint);
    const current = await this.store.get(key);
    if (!current) return undefined;
    validateCredential(current);
    if (!isExpired(current)) return current;
    if (!current.refreshToken || !metadata) { await this.store.delete(key); return undefined; }
    const existing = this.refreshes.get(key);
    if (existing) return existing;
    const refresh = this.refreshToken(key, current, metadata, oauth, signal);
    this.refreshes.set(key, refresh);
    try { return await refresh; } finally { this.refreshes.delete(key); }
  }

  async login(options: OAuthLoginOptions): Promise<OAuthCredential> {
    const fetchImpl = options.fetch ?? globalThis.fetch;
    const metadata = await discoverAuthorizationServerMetadata(options.authorizationServer ?? new URL(options.endpoint).origin, options.signal, fetchImpl);
    const verifier = base64Url(crypto.randomBytes(32));
    const challenge = base64Url(crypto.createHash("sha256").update(verifier).digest());
    const state = base64Url(crypto.randomBytes(32));
    // 动态注册必须使用实际 loopback 端口，否则授权服务器会拒绝回调 URI。
    const callback = await createLoopbackCallback(state, options.waitForAuthorizationCode);
    const redirectUri = callback.redirectUri;
    const clientId = options.clientId ?? await dynamicallyRegisterClient(metadata, options.endpoint, redirectUri, fetchImpl, options.signal);
    if (!clientId) throw new Error("OAuth client ID is required for MCP login");
    const authorizationUrl = new URL(metadata.authorizationEndpoint);
    authorizationUrl.searchParams.set("response_type", "code");
    authorizationUrl.searchParams.set("client_id", clientId);
    authorizationUrl.searchParams.set("redirect_uri", redirectUri);
    authorizationUrl.searchParams.set("code_challenge", challenge);
    authorizationUrl.searchParams.set("code_challenge_method", "S256");
    authorizationUrl.searchParams.set("state", state);
    if (options.scopes?.length) authorizationUrl.searchParams.set("scope", options.scopes.join(" "));
    if (options.resource) authorizationUrl.searchParams.set("resource", options.resource);
    await options.browserLauncher?.open(authorizationUrl.toString());
    const callbackResult = await callback.wait(authorizationUrl.toString(), options.signal);
    if (callbackResult.state !== state) throw new Error("OAuth state mismatch");
    const response = await fetchImpl(metadata.tokenEndpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({ grant_type: "authorization_code", code: callbackResult.code, redirect_uri: redirectUri, client_id: clientId, code_verifier: verifier }).toString(),
      signal: options.signal,
      redirect: "error",
    });
    const token = await parseTokenResponse(response);
    const credential = toCredential(token);
    validateCredential(credential);
    await this.store.set(this.credentialKey(options.serverId, options.endpoint), credential);
    return credential;
  }

  async logout(serverId: string, endpoint: string): Promise<void> {
    await this.store.delete(this.credentialKey(serverId, endpoint));
  }

  async refreshAccessToken(serverId: string, endpoint: string, metadata: OAuthAuthorizationServerMetadata, oauth: Pick<OAuthLoginOptions, "clientId" | "resource" | "scopes">, signal?: AbortSignal): Promise<OAuthCredential | undefined> {
    const key = this.credentialKey(serverId, endpoint);
    const current = await this.store.get(key);
    if (!current?.refreshToken) return undefined;
    const existing = this.refreshes.get(key);
    if (existing) return existing;
    const refresh = this.refreshToken(key, current, metadata, oauth, signal);
    this.refreshes.set(key, refresh);
    try { return await refresh; } finally { this.refreshes.delete(key); }
  }

  private async refreshToken(key: string, current: OAuthCredential, metadata: OAuthAuthorizationServerMetadata, oauth: Pick<OAuthLoginOptions, "clientId" | "resource" | "scopes">, signal?: AbortSignal): Promise<OAuthCredential | undefined> {
    if (!oauth.clientId) { await this.store.delete(key); return undefined; }
    try {
      const response = await this.fetch(metadata.tokenEndpoint, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
        body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: current.refreshToken!, client_id: oauth.clientId, ...(oauth.resource ? { resource: oauth.resource } : {}) }).toString(),
        signal,
        redirect: "error",
      });
      const token = await parseTokenResponse(response);
      const credential = toCredential(token, current);
      validateCredential(credential);
      await this.store.set(key, credential);
      return credential;
    } catch (error) {
      if (signal?.aborted) throw error;
      await this.store.delete(key);
      return undefined;
    }
  }
}

export async function discoverAuthorizationServerMetadata(issuer: string, signal?: AbortSignal, fetchImpl: typeof globalThis.fetch = globalThis.fetch): Promise<OAuthAuthorizationServerMetadata> {
  const url = safeOAuthUrl(new URL("/.well-known/oauth-authorization-server", issuer));
  const response = await fetchImpl(url, { headers: { accept: "application/json" }, signal, redirect: "error" });
  if (!response.ok) throw new Error("OAuth authorization server metadata request failed");
  const value: unknown = await response.json();
  if (!isRecord(value) || typeof value.authorization_endpoint !== "string" || typeof value.token_endpoint !== "string") throw new Error("Invalid OAuth authorization server metadata");
  const authorizationEndpoint = safeOAuthUrl(new URL(value.authorization_endpoint));
  const tokenEndpoint = safeOAuthUrl(new URL(value.token_endpoint));
  const registrationEndpoint = typeof value.registration_endpoint === "string" ? safeOAuthUrl(new URL(value.registration_endpoint)).toString() : undefined;
  return { authorizationEndpoint: authorizationEndpoint.toString(), tokenEndpoint: tokenEndpoint.toString(), ...(registrationEndpoint ? { registrationEndpoint } : {}), ...(Array.isArray(value.scopes_supported) ? { scopesSupported: value.scopes_supported.filter((scope): scope is string => typeof scope === "string" && scope.length <= 256) } : {}) };
}

/** 从受保护资源元数据中选择授权服务器，且元数据地址同样只允许安全 origin。 */
export async function discoverProtectedResourceMetadata(resourceEndpoint: string, signal?: AbortSignal, fetchImpl: typeof globalThis.fetch = globalThis.fetch, explicitMetadataUrl?: string): Promise<OAuthProtectedResourceMetadata> {
  const resource = new URL(resourceEndpoint);
  // 401 的 WWW-Authenticate 可以提供明确 metadata 地址；没有时才按资源 origin 推导。
  const metadataUrl = explicitMetadataUrl ? safeOAuthUrl(new URL(explicitMetadataUrl)) : safeOAuthUrl(new URL("/.well-known/oauth-protected-resource", resource.origin));
  const response = await fetchImpl(metadataUrl, { headers: { accept: "application/json" }, signal, redirect: "error" });
  if (!response.ok) throw new Error("OAuth protected resource metadata request failed");
  const value: unknown = await response.json();
  if (!isRecord(value)) throw new Error("Invalid OAuth protected resource metadata");
  const authorizationServers = Array.isArray(value.authorization_servers) ? value.authorization_servers.filter((item): item is string => {
    if (typeof item !== "string") return false;
    try { safeOAuthUrl(new URL(item)); return true; } catch { return false; }
  }) : undefined;
  return { ...(authorizationServers?.length ? { authorizationServers } : {}), ...(Array.isArray(value.scopes_supported) ? { scopesSupported: value.scopes_supported.filter((scope): scope is string => typeof scope === "string" && scope.length <= 256) } : {}) };
}

async function dynamicallyRegisterClient(metadata: OAuthAuthorizationServerMetadata, endpoint: string, redirectUri: string, fetchImpl: typeof globalThis.fetch, signal?: AbortSignal): Promise<string | undefined> {
  if (!metadata.registrationEndpoint) return undefined;
  const response = await fetchImpl(safeOAuthUrl(new URL(metadata.registrationEndpoint)), { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify({ client_name: "coding-agent", redirect_uris: [redirectUri], grant_types: ["authorization_code"], token_endpoint_auth_method: "none", response_types: ["code"], client_uri: new URL(endpoint).origin }), signal, redirect: "error" });
  if (!response.ok) throw new Error("OAuth dynamic client registration failed");
  const value: unknown = await response.json();
  if (!isRecord(value) || typeof value.client_id !== "string") throw new Error("Invalid OAuth client registration response");
  return value.client_id;
}

async function parseTokenResponse(response: Response): Promise<OAuthTokenResponse> {
  const value: unknown = await response.json().catch(() => undefined);
  if (!response.ok || !isRecord(value) || typeof value.access_token !== "string") throw new Error("OAuth token request failed");
  return value as unknown as OAuthTokenResponse;
}

function toCredential(token: OAuthTokenResponse, previous?: OAuthCredential): OAuthCredential {
  return { accessToken: token.access_token, tokenType: token.token_type ?? "Bearer", ...(token.refresh_token ?? previous?.refreshToken ? { refreshToken: token.refresh_token ?? previous?.refreshToken } : {}), ...(Number.isFinite(token.expires_in) ? { expiresAt: new Date(Date.now() + Number(token.expires_in) * 1000).toISOString() } : {}), ...(token.scope ? { scope: token.scope.split(/\s+/).filter(Boolean) } : previous?.scope ? { scope: previous.scope } : {}) };
}

interface LoopbackCallback { readonly redirectUri: string; wait(authorizationUrl: string, signal?: AbortSignal): Promise<{ readonly code: string; readonly state: string }>; }
async function createLoopbackCallback(expectedState: string, manual?: OAuthLoginOptions["waitForAuthorizationCode"]): Promise<LoopbackCallback> {
  if (manual) {
    const server = http.createServer();
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Unable to start OAuth callback listener");
    const redirectUri = `http://127.0.0.1:${address.port}/callback`;
    return { redirectUri, wait: async (authorizationUrl: string, _signal?: AbortSignal) => { try { const result = await manual(authorizationUrl, redirectUri); if (result.state !== expectedState) throw new Error("OAuth state mismatch"); return result; } finally { await new Promise<void>((resolve) => server.close(() => resolve())); } } };
  }
  const server = http.createServer();
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Unable to start OAuth callback listener");
  const redirectUri = `http://127.0.0.1:${address.port}/callback`;
  let settled = false;
  const wait = (_authorizationUrl: string, signal?: AbortSignal) => new Promise<{ readonly code: string; readonly state: string }>((resolve, reject) => {
    const finish = (error?: Error, result?: { readonly code: string; readonly state: string }) => { if (settled) return; settled = true; server.close(); signal?.removeEventListener("abort", abort); error ? reject(error) : resolve(result!); };
    const abort = () => finish(new Error("OAuth callback aborted"));
    signal?.addEventListener("abort", abort, { once: true });
    server.on("request", (request, response) => {
      const requestUrl = new URL(request.url ?? "/", redirectUri);
      if (requestUrl.pathname !== "/callback") { response.writeHead(404); response.end(); return; }
      const code = requestUrl.searchParams.get("code");
      const state = requestUrl.searchParams.get("state");
      const callbackError = requestUrl.searchParams.get("error");
      response.writeHead(code && state && !callbackError ? 200 : 400, { "content-type": "text/plain; charset=utf-8" });
      response.end(code && state && !callbackError ? "Authorization received. You may close this window." : "Authorization failed.");
      if (callbackError) finish(new Error("OAuth authorization was denied"));
      else if (!code || !state) finish(new Error("OAuth callback did not contain code and state"));
      else finish(undefined, { code, state });
    });
  });
  return { redirectUri, wait };
}

function isExpired(credential: OAuthCredential): boolean {
  if (!credential.expiresAt) return false;
  const timestamp = Date.parse(credential.expiresAt);
  return !Number.isFinite(timestamp) || timestamp <= Date.now() + 30_000;
}
function base64Url(value: Buffer): string { return value.toString("base64").replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", ""); }
function defaultCredentialPath(): string { return process.env.APPDATA ? path.join(process.env.APPDATA, "veil", "credentials.json") : path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config"), "veil", "credentials.json"); }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }

function safeOAuthUrl(url: URL): URL {
  const host = url.hostname.toLowerCase();
  const loopback = host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) throw new Error("OAuth endpoint must use HTTPS, except loopback development endpoints");
  if (url.username || url.password || url.hash) throw new Error("OAuth endpoint must not contain credentials or fragments");
  return url;
}


function validateCredential(credential: OAuthCredential): void {
  if (!credential || typeof credential.accessToken !== "string" || credential.accessToken.length === 0 || credential.accessToken.length > 16384 || /[\r\n]/.test(credential.accessToken)) throw new Error("Invalid OAuth credential");
  if (typeof credential.tokenType !== "string" || !/^[A-Za-z][A-Za-z0-9._~-]{0,63}$/.test(credential.tokenType)) throw new Error("Invalid OAuth token type");
  if (credential.refreshToken !== undefined && (typeof credential.refreshToken !== "string" || credential.refreshToken.length > 16384 || /[\r\n]/.test(credential.refreshToken))) throw new Error("Invalid OAuth refresh token");
  if (credential.expiresAt !== undefined && !Number.isFinite(Date.parse(credential.expiresAt))) throw new Error("Invalid OAuth expiration");
  if (credential.scope !== undefined && (!Array.isArray(credential.scope) || credential.scope.length > 128 || !credential.scope.every((scope) => typeof scope === "string" && scope.length <= 256 && !/[\r\n]/.test(scope)))) throw new Error("Invalid OAuth scope");
}
