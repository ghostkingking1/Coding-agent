import { z } from "zod";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { McpRemoteServerConfig } from "./mcp-remote.ts";

export interface McpConfigFile { readonly servers: readonly McpRemoteServerConfig[]; }
export interface McpConfigLoadOptions { readonly filePath?: string; readonly environment?: Readonly<Record<string, string | undefined>>; }

const serverSchema = z.object({
  id: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/),
  endpoint: z.string().url(),
  enabled: z.boolean().optional(),
  remoteCapabilities: z.array(z.enum(["read", "write", "execute", "network"] as const)).min(1),
  oauth: z.object({ clientId: z.string().min(1).optional(), scopes: z.array(z.string().min(1)).optional(), authorizationServer: z.string().url().optional(), resource: z.string().min(1).max(2048).optional() }).strict().optional(),
  timeoutMs: z.number().int().positive().optional(), maxMessageBytes: z.number().int().positive().optional(), maxToolCount: z.number().int().positive().optional(), maxResourceCount: z.number().int().positive().optional(), maxPromptCount: z.number().int().positive().optional(), maxConcurrentCalls: z.number().int().positive().optional(), allowInsecureLocalhost: z.boolean().optional(),
}).strict();
const configSchema = z.object({ servers: z.array(serverSchema).max(128) }).strict();

export async function loadMcpConfig(options: McpConfigLoadOptions = {}): Promise<McpConfigFile> {
  const environment = options.environment ?? process.env;
  const filePath = options.filePath ?? environment.CODING_AGENT_MCP_CONFIG ?? defaultMcpConfigPath();
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(path.resolve(filePath), "utf8"));
    const result = configSchema.safeParse(parsed);
    if (!result.success) throw new Error("Invalid MCP configuration");
    const ids = new Set<string>();
    for (const server of result.data.servers) {
      if (ids.has(server.id)) throw new Error(`Duplicate MCP server id: ${server.id}`);
      ids.add(server.id);
    }
    return result.data;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { servers: [] };
    if (error instanceof Error && error.message === "Invalid MCP configuration") throw error;
    throw new Error("Unable to load MCP configuration", { cause: error });
  }
}

export function defaultMcpConfigPath(): string {
  if (process.env.APPDATA) return path.join(process.env.APPDATA, "veil", "mcp.json");
  return path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config"), "veil", "mcp.json");
}
