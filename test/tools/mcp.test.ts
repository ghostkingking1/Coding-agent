import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createMcpTools, McpStdioClient } from "../../src/tools/mcp.ts";
import { ProcessSandboxBackend, type SandboxBackend } from "../../src/tools/sandbox.ts";
import { ApprovalDeniedError, SecurityPolicy, WorkspacePolicy } from "../../src/tools/security.ts";
import { ToolRegistry } from "../../src/tools/tool-registry.ts";

class IsolatedTestSandbox implements SandboxBackend {
  readonly capabilities = { backend: "test", version: "1", capabilities: ["process.spawn", "process-tree", "workspace.fs", "network.off", "os.isolation"] as const };
  private readonly delegate = new ProcessSandboxBackend();
  assertAvailable(required: readonly "process.spawn"[] | readonly string[]): void { for (const capability of required) if (!this.capabilities.capabilities.includes(capability as never)) throw new Error(`missing ${capability}`); }
  spawn(request: Parameters<SandboxBackend["spawn"]>[0]) { return this.delegate.spawn(request); }
}

async function withWorkspace(run: (root: string) => Promise<void>): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "coding-agent-mcp-"));
  try { await run(root); } finally { await fs.rm(root, { recursive: true, force: true }); }
}
function client(root: string): McpStdioClient { return new McpStdioClient({ id: "test", executable: process.execPath, args: ["--experimental-strip-types", path.resolve("test/fixtures/mcp-server.ts")], cwd: ".", env: { PATH: process.env.PATH ?? "" }, toolCapabilities: ["execute"], timeoutMs: 2_000 }, new WorkspacePolicy({ root }), new IsolatedTestSandbox()); }

test("MCP tools are discovered, approval-bound, and invoked through the sandbox", async () => {
  await withWorkspace(async (root) => {
    const mcp = client(root);
    try {
      const tools = await createMcpTools(mcp);
      assert.equal(tools[0]?.name, "mcp_test_echo");
      let preview: unknown;
      const registry = new ToolRegistry(new SecurityPolicy({ approval: { requestApproval(request) { preview = request.preview; return true; } } }));
      for (const tool of tools) registry.register(tool);
      const result = await registry.execute("mcp_test_echo", { b: 2, a: "one" }, { messages: [] }) as { readonly content: readonly { readonly text: string }[]; readonly isError: boolean };
      assert.equal(result.isError, false);
      assert.match(result.content[0]!.text, /"name":"echo"/);
      assert.deepEqual({ ...(preview as Record<string, unknown>), requestDigest: undefined }, { serverId: "test", serverDigest: mcp.serverDigest, mcpToolName: "echo", arguments: { a: "one", b: 2 }, capabilitySnapshot: mcp.capabilitySnapshot, requestDigest: undefined });
      assert.match((preview as { readonly requestDigest: string }).requestDigest, /^[a-f0-9]{64}$/);
    } finally { await mcp.close(); }
  });
});

test("MCP side effects are rejected before a call when approval denies them", async () => {
  await withWorkspace(async (root) => {
    const mcp = client(root);
    try {
      const registry = new ToolRegistry(new SecurityPolicy({ approval: { requestApproval: () => false } }));
      for (const tool of await createMcpTools(mcp)) registry.register(tool);
      await assert.rejects(() => registry.execute("mcp_test_echo", {}, { messages: [] }), ApprovalDeniedError);
    } finally { await mcp.close(); }
  });
});

test("MCP requires a sandbox that proves OS isolation", async () => {
  await withWorkspace(async (root) => {
    assert.throws(() => new McpStdioClient({ id: "test", executable: process.execPath, cwd: ".", env: {}, toolCapabilities: ["read"] }, new WorkspacePolicy({ root }), new ProcessSandboxBackend()));
  });
});
