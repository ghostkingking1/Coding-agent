import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ApprovalDeniedError, SecurityPolicy, WorkspacePolicy, WorkspaceSecurityError } from "../../src/tools/security.ts";
import { createWorkspaceTools } from "../../src/tools/workspace-tools.ts";
import { ToolRegistry } from "../../src/tools/tool-registry.ts";
import type { Tool } from "../../src/agent/types.ts";

async function withWorkspace(run: (root: string) => Promise<void>): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "coding-agent-"));
  try {
    await run(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function executeTool(tool: Tool, input: unknown): Promise<unknown> {
  return new ToolRegistry().register(tool).execute(tool.name, input, { messages: [] });
}

test("workspace tools read and search only visible files", async () => {
  await withWorkspace(async (root) => {
    await fs.mkdir(path.join(root, "src"));
    await fs.writeFile(path.join(root, "src", "main.ts"), "const answer = 42;\n");
    await fs.writeFile(path.join(root, ".secret"), "do not expose");
    const policy = new WorkspacePolicy({ root });
    const tools = createWorkspaceTools(policy);
    const readFile = tools.find((tool) => tool.name === "read_file");
    const listFiles = tools.find((tool) => tool.name === "list_files");
    const searchText = tools.find((tool) => tool.name === "search_text");
    if (!readFile || !listFiles || !searchText) throw new Error("Workspace tools were not registered");
    assert.deepEqual(await executeTool(readFile, { path: "src/main.ts" }), {
      path: path.join("src", "main.ts"),
      content: "const answer = 42;\n",
    });
    assert.deepEqual(await executeTool(listFiles, { path: ".", depth: 2 }), ["src", path.join("src", "main.ts")]);
    assert.deepEqual(await executeTool(searchText, { query: "answer" }), [{
      path: path.join("src", "main.ts"),
      line: 1,
      text: "const answer = 42;",
    }]);
  });
});

test("workspace policy rejects traversal and hidden paths", async () => {
  await withWorkspace(async (root) => {
    const policy = new WorkspacePolicy({ root });
    assert.throws(() => policy.resolveExisting(".."), WorkspaceSecurityError);
    await fs.writeFile(path.join(root, ".secret"), "hidden");
    assert.throws(() => policy.resolveExisting(".secret"), WorkspaceSecurityError);
  });
});

test("security policy requests approval before non-read tools execute", async () => {
  let executed = false;
  const requests: string[] = [];
  const registry = new ToolRegistry(new SecurityPolicy({
    onApprovalRequired: (request) => {
      requests.push(request.toolName);
    },
  }));
  registry.register({
    name: "write_file",
    description: "test write",
    manifest: { capabilities: ["write"] },
    execute: () => {
      executed = true;
      return "written";
    },
  });
  await assert.rejects(() => registry.execute("write_file", { path: "x" }, { messages: [] }), ApprovalDeniedError);
  assert.equal(executed, false);
  assert.deepEqual(requests, ["write_file"]);
});

test("tool registry denies side effects when no policy is configured", async () => {
  let executed = false;
  const registry = new ToolRegistry().register({
    name: "unsafe_write",
    description: "test write",
    manifest: { capabilities: ["write"] },
    execute: () => { executed = true; },
  });
  await assert.rejects(() => registry.execute("unsafe_write", {}, { messages: [] }), ApprovalDeniedError);
  assert.equal(executed, false);
});

test("tool registry rejects an empty capability set", () => {
  assert.throws(() => new ToolRegistry().register({
    name: "empty",
    description: "invalid",
    manifest: { capabilities: [] },
    execute: () => undefined,
  }), WorkspaceSecurityError);
});

test("tool registry rejects undeclared tools when no policy is configured", async () => {
  const registry = new ToolRegistry().register({
    name: "undeclared",
    description: "missing manifest",
    execute: () => "no",
  });
  await assert.rejects(() => registry.execute("undeclared", {}, { messages: [] }), WorkspaceSecurityError);
});

test("tool registry prepares once and rejects approval-time digest mutation", async () => {
  let prepared = 0;
  let executed = false;
  const registry = new ToolRegistry({
    authorize(_tool, _input, context) {
      (context.preparedOperation as { approvalDigest: string }).approvalDigest = "changed";
    },
  }).register({
    name: "prepared_write",
    description: "prepared write",
    manifest: { capabilities: ["write"] },
    prepare() {
      prepared += 1;
      return { operationId: "operation-1", approvalDigest: "digest-1", preview: {}, payload: {} };
    },
    executePrepared() { executed = true; },
    execute() { throw new Error("legacy execute must not run"); },
  });

  await assert.rejects(() => registry.execute("prepared_write", {}, { messages: [] }), /changed during approval/);
  assert.equal(prepared, 1);
  assert.equal(executed, false);
});
