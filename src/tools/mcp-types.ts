import type { JsonObject, JsonSchema, ToolCapability } from "../agent/types.ts";

export interface McpListedTool {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema?: JsonSchema;
}

export interface McpResource {
  readonly uri: string;
  readonly name?: string;
  readonly description?: string;
  readonly mimeType?: string;
}

export interface McpPrompt {
  readonly name: string;
  readonly description?: string;
  readonly arguments?: readonly { readonly name: string; readonly description?: string; readonly required?: boolean }[];
}

export interface McpToolResult {
  readonly content: readonly unknown[];
  readonly isError: boolean;
}

export interface McpResourceResult {
  readonly contents: readonly unknown[];
}

export interface McpPromptResult {
  readonly description?: string;
  readonly messages: readonly unknown[];
}

/** 本地 stdio 和远程 HTTP MCP 共享的最小客户端契约。 */
export interface McpClient {
  readonly serverId: string;
  readonly serverDigest: string;
  readonly capabilities: readonly ToolCapability[];
  readonly capabilitySnapshot: { readonly backend: string; readonly version: string; readonly capabilities: readonly string[] };
  readonly endpointOrigin?: string;
  /** 初始化后由远程 Server 明确声明的 surface；缺失表示未暴露给模型。 */
  readonly supportsTools?: boolean;
  readonly supportsResources?: boolean;
  readonly supportsPrompts?: boolean;

  connect(signal?: AbortSignal): Promise<void>;
  listTools(signal?: AbortSignal): Promise<readonly McpListedTool[]>;
  callTool(name: string, args: JsonObject, signal?: AbortSignal): Promise<McpToolResult>;
  listResources(signal?: AbortSignal): Promise<readonly McpResource[]>;
  readResource(uri: string, signal?: AbortSignal): Promise<McpResourceResult>;
  listPrompts(signal?: AbortSignal): Promise<readonly McpPrompt[]>;
  getPrompt(name: string, args?: JsonObject, signal?: AbortSignal): Promise<McpPromptResult>;
  close(): Promise<void>;
}
