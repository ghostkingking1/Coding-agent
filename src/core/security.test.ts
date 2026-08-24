import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ApprovalDeniedError, SecurityPolicy, WorkspacePolicy, WorkspaceSecurityError } from "./security.ts";
import { createWorkspaceTools } from "./workspace-tools.ts";
import { ToolRegistry } from "./tool-registry.ts";

async function withWorkspace(run: (root: string) => Promise<void>): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "coding-agent-"));
  try {
    await run(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
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
    assert.deepEqual(await readFile.execute({ path: "src/main.ts" }, { messages: [] }), {
      path: path.join("src", "main.ts"),
      content: "const answer = 42;\n",
    });
    assert.deepEqual(await listFiles.execute({ path: ".", depth: 2 }, { messages: [] }), ["src", path.join("src", "main.ts")]);
    assert.deepEqual(await searchText.execute({ query: "answer" }, { messages: [] }), [{
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
