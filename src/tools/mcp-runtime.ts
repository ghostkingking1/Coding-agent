import type { AuditSink, Tool } from "../agent/types.ts";
import { createMcpAgentTools } from "./mcp.ts";
import { OAuthAuthenticator, FileCredentialStore, type CredentialStore, type BrowserLauncher } from "./mcp-auth.ts";
import { McpRemoteClient, type McpRemoteServerConfig, type McpRemoteClientOptions } from "./mcp-remote.ts";

export interface McpBootstrapRequest {
  readonly serverId: string;
  readonly serverDigest: string;
  readonly endpointOrigin: string;
  readonly capabilities: readonly string[];
}

export interface McpRuntimeOptions {
  readonly selectedServerIds?: readonly string[];
  readonly includeResources?: boolean;
  readonly includePrompts?: boolean;
  readonly approveBootstrap?: (request: McpBootstrapRequest) => Promise<boolean> | boolean;
  readonly credentialStore?: CredentialStore;
  readonly clientOptions?: Omit<McpRemoteClientOptions, "credentialStore" | "authenticator">;
  readonly auditSink?: AuditSink;
  readonly sessionId?: string;
  readonly runId?: string;
}

export interface McpRuntimeServerStatus {
  readonly id: string;
  readonly endpoint: string;
  readonly enabled: boolean;
  readonly selected: boolean;
  readonly connected: boolean;
  readonly error?: string;
}

/** 管理一次 CLI 会话中的远程 MCP client；session ID 只存在于 client 内存中。 */
export class McpRuntime {
  readonly clients: readonly McpRemoteClient[];
  readonly tools: readonly Tool[];
  readonly statuses: readonly McpRuntimeServerStatus[];
  private readonly configById: ReadonlyMap<string, McpRemoteServerConfig>;
  private readonly credentialStore: CredentialStore;

  private constructor(clients: readonly McpRemoteClient[], tools: readonly Tool[], statuses: readonly McpRuntimeServerStatus[], configs: readonly McpRemoteServerConfig[], credentialStore: CredentialStore) {
    this.clients = clients;
    this.tools = tools;
    this.statuses = statuses;
    this.configById = new Map(configs.map((config) => [config.id, config]));
    this.credentialStore = credentialStore;
  }

  static async create(configs: readonly McpRemoteServerConfig[], options: McpRuntimeOptions = {}): Promise<McpRuntime> {
    const selected = options.selectedServerIds ? new Set(options.selectedServerIds) : undefined;
    const credentialStore = options.credentialStore ?? new FileCredentialStore();
    const clients: McpRemoteClient[] = [];
    const tools: Tool[] = [];
    const statuses: McpRuntimeServerStatus[] = [];
    const configuredIds = new Set(configs.map((config) => config.id));
    if (selected) for (const id of selected) if (!configuredIds.has(id)) throw new Error(`Unknown MCP server: ${id}`);
    for (const config of configs) {
      const isSelected = selected === undefined || selected.has(config.id);
      const enabled = config.enabled === true;
      if (!enabled || !isSelected) {
        statuses.push({ id: config.id, endpoint: config.endpoint, enabled, selected: isSelected, connected: false });
        continue;
      }
      const client = new McpRemoteClient(config, { ...options.clientOptions, credentialStore });
      const bootstrap = { serverId: client.serverId, serverDigest: client.serverDigest, endpointOrigin: client.endpointOrigin, capabilities: client.capabilities };
      await recordAudit(options.auditSink, options, "mcp_bootstrap", "started", bootstrap);
      const approved = await options.approveBootstrap?.(bootstrap) ?? false;
      if (!approved) {
        await recordAudit(options.auditSink, options, "mcp_bootstrap", "denied", bootstrap);
        statuses.push({ id: config.id, endpoint: config.endpoint, enabled, selected: isSelected, connected: false, error: "bootstrap approval denied" });
        if (selected?.has(config.id)) throw new Error(`MCP bootstrap approval denied: ${config.id}`);
        continue;
      }
      try {
        await recordAudit(options.auditSink, options, "mcp_connect", "started", bootstrap);
        await client.connect();
        await recordAudit(options.auditSink, options, "mcp_connect", "completed", { ...bootstrap, protocolVersion: client.protocol ?? "unknown" });
        tools.push(...await createMcpAgentTools(client, { includeResources: options.includeResources, includePrompts: options.includePrompts }));
        await recordAudit(options.auditSink, options, "mcp_discovery", "completed", { ...bootstrap, toolCount: tools.filter((tool) => tool.name.startsWith(`mcp_${client.serverId}_`)).length });
        clients.push(client);
        statuses.push({ id: config.id, endpoint: config.endpoint, enabled, selected: isSelected, connected: true });
      } catch (error) {
        await recordAudit(options.auditSink, options, "mcp_connect", "failed", { ...bootstrap, errorCode: error instanceof Error ? error.name : "unknown" });
        await client.close();
        statuses.push({ id: config.id, endpoint: config.endpoint, enabled, selected: isSelected, connected: false, error: safeError(error) });
        if (selected?.has(config.id)) throw new Error(`MCP server ${config.id} failed to initialize: ${safeError(error)}`);
      }
    }
    return new McpRuntime(clients, tools, statuses, configs, credentialStore);
  }

  list(): readonly McpRuntimeServerStatus[] { return this.statuses; }

  async login(serverId: string, options: { readonly browserLauncher?: BrowserLauncher; readonly waitForAuthorizationCode?: (authorizationUrl: string, redirectUri: string) => Promise<{ readonly code: string; readonly state: string }> } = {}): Promise<void> {
    const config = this.configById.get(serverId);
    if (!config) throw new Error(`Unknown MCP server: ${serverId}`);
    const authenticator = new OAuthAuthenticator(this.credentialStore);
    await authenticator.login({ serverId: config.id, endpoint: config.endpoint, clientId: config.oauth?.clientId, scopes: config.oauth?.scopes, authorizationServer: config.oauth?.authorizationServer, resource: config.oauth?.resource, browserLauncher: options.browserLauncher, waitForAuthorizationCode: options.waitForAuthorizationCode });
  }

  async logout(serverId: string): Promise<void> {
    const config = this.configById.get(serverId);
    if (!config) throw new Error(`Unknown MCP server: ${serverId}`);
    await new OAuthAuthenticator(this.credentialStore).logout(config.id, config.endpoint);
  }

  async close(): Promise<void> { await Promise.all(this.clients.map((client) => client.close())); }
}

async function recordAudit(sink: AuditSink | undefined, options: McpRuntimeOptions, eventType: string, status: string, metadata: Record<string, unknown>): Promise<void> {
  await sink?.record({ sessionId: options.sessionId, runId: options.runId, eventType, status, metadata: sanitizeAuditMetadata(metadata) as import("../agent/types.ts").JsonObject });
}

function sanitizeAuditMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  const allowed = ["serverId", "serverDigest", "endpointOrigin", "capabilities", "protocolVersion", "toolCount", "errorCode"];
  return Object.fromEntries(Object.entries(metadata).filter(([key]) => allowed.includes(key)).map(([key, value]) => [key, typeof value === "string" || Array.isArray(value) ? value : undefined]).filter((entry) => entry[1] !== undefined));
}

function safeError(error: unknown): string { return error instanceof Error ? error.message.slice(0, 256) : "MCP initialization failed"; }
