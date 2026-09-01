import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Agent } from "../../src/agent/agent.ts";
import { RunChangeTracker } from "../../src/agent/run-diff.ts";
import type { ModelClient, ModelResponse } from "../../src/agent/types.ts";
import { SecurityPolicy, WorkspacePolicy } from "../../src/tools/security.ts";
import { ToolRegistry } from "../../src/tools/tool-registry.ts";
import { createWorkspaceTools } from "../../src/tools/workspace-tools.ts";

async function withWorkspace(run: (root: string) => Promise<void>): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "coding-agent-diff-"));
  try {
    await run(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

test("run diff compares the original file with its final content and keeps context", async () => {
  await withWorkspace(async (root) => {
    const file = path.join(root, "app.ts");
    await fs.writeFile(file, "one\ntwo\nthree\nfour\nfive\n", "utf8");
    const tracker = new RunChangeTracker();
    tracker.recordBeforeWrite(file, "app.ts", await fs.readFile(file, "utf8"));
    await fs.writeFile(file, "one\ntwo\nchanged\nfour\nfive\n", "utf8");

    const result = await tracker.finish();
    assert.equal(result.files.length, 1);
    assert.match(result.text, /--- a\/app\.ts/);
    assert.match(result.text, /\+\+\+ b\/app\.ts/);
    assert.match(result.text, / two/);
    assert.match(result.text, /-three/);
    assert.match(result.text, /\+changed/);
    assert.match(result.text, / four/);
  });
});

test("run diff handles multiple files and repeated writes", async () => {
  await withWorkspace(async (root) => {
    const first = path.join(root, "first.ts");
    const second = path.join(root, "second.ts");
    await fs.writeFile(first, "return 1;\n", "utf8");
    await fs.writeFile(second, "return 2;\n", "utf8");
    const tracker = new RunChangeTracker();
    tracker.recordBeforeWrite(first, "first.ts", "return 1;\n");
    tracker.recordBeforeWrite(first, "first.ts", "incorrect snapshot\n");
    tracker.recordBeforeWrite(second, "second.ts", "return 2;\n");
    await fs.writeFile(first, "return 3;\n", "utf8");
    await fs.writeFile(second, "return 4;\n", "utf8");

    const result = await tracker.finish();
    assert.equal(result.files.length, 2);
    assert.match(result.text, /-return 1;\n\+return 3;/);
    assert.match(result.text, /-return 2;\n\+return 4;/);
  });
});

test("run diff omits files restored to their original content", async () => {
  await withWorkspace(async (root) => {
    const file = path.join(root, "same.ts");
    const content = "unchanged\n";
    await fs.writeFile(file, content, "utf8");
    const tracker = new RunChangeTracker();
    tracker.recordBeforeWrite(file, "same.ts", content);
    await fs.writeFile(file, "temporary\n", "utf8");
    await fs.writeFile(file, content, "utf8");

    const result = await tracker.finish();
    assert.deepEqual(result, { files: [], text: "", truncated: false, complete: true, omittedPaths: [] });
  });
});

test("run diff truncates the final text without losing per-file records", async () => {
  await withWorkspace(async (root) => {
    const file = path.join(root, "large.ts");
    await fs.writeFile(file, "old\n", "utf8");
    const tracker = new RunChangeTracker({ maxDiffChars: 10 });
    tracker.recordBeforeWrite(file, "large.ts", "old\n");
    await fs.writeFile(file, "new content\n", "utf8");

    const result = await tracker.finish();
    assert.equal(result.files.length, 1);
    assert.equal(result.truncated, true);
    assert.match(result.text, /run diff truncated/);
  });
});

test("run diff reports added, deleted, and binary files", async () => {
  await withWorkspace(async (root) => {
    const deleted = path.join(root, "deleted.txt");
    const binary = path.join(root, "image.bin");
    await fs.writeFile(deleted, "remove me\n", "utf8");
    await fs.writeFile(binary, Buffer.from([0, 2, 3]), "binary");
    const tracker = new RunChangeTracker({ root });
    await tracker.start();
    await fs.rm(deleted);
    await fs.writeFile(path.join(root, "added.txt"), "new file\n", "utf8");
    await fs.writeFile(binary, Buffer.from([0, 2, 4]), "binary");

    const result = await tracker.finish();
    assert.deepEqual(result.files.map((file) => file.path), ["added.txt", "deleted.txt", "image.bin"]);
    assert.match(result.text, /\+new file/);
    assert.match(result.text, /-remove me/);
    assert.match(result.text, /Binary files a\/image\.bin and b\/image\.bin differ/);
  });
});

test("Agent result contains the final diff after a patch tool call", async () => {
  await withWorkspace(async (root) => {
    const file = path.join(root, "app.ts");
    await fs.writeFile(file, "const answer = 41;\n", "utf8");
    const registry = new ToolRegistry(new SecurityPolicy({ approval: { requestApproval: () => true } }));
    for (const tool of createWorkspaceTools(new WorkspacePolicy({ root }))) {
      if (tool.name === "apply_patch") registry.register(tool);
    }
    let calls = 0;
    const model: ModelClient = {
      provider: "fake",
      model: "fake",
      capabilities: { toolCalling: true, streaming: false },
      async generate(): Promise<ModelResponse> {
        calls += 1;
        return calls === 1
          ? { message: { role: "assistant", content: "editing", toolCalls: [{ id: "patch-1", name: "apply_patch", input: { changes: [{ path: "app.ts", find: "41", replaceWith: "42" }] } }] } }
          : { message: { role: "assistant", content: "done" } };
      },
    };

    const result = await new Agent(model, registry, { changeTracker: new RunChangeTracker({ root }) }).run("update the answer");
    assert.ok(result.diff);
    assert.equal(result.diff.files.length, 1);
    assert.match(result.diff.text, /-const answer = 41;/);
    assert.match(result.diff.text, /\+const answer = 42;/);
  });
});

test("Agent result includes files created indirectly by run_command", async () => {
  await withWorkspace(async (root) => {
    const registry = new ToolRegistry(new SecurityPolicy({ approval: { requestApproval: () => true } }));
    const policy = new WorkspacePolicy({ root });
    const command = createWorkspaceTools(policy).find((tool) => tool.name === "run_command");
    if (!command) throw new Error("run_command was not registered");
    registry.register(command);
    let calls = 0;
    const model: ModelClient = {
      provider: "fake",
      model: "fake",
      capabilities: { toolCalling: true, streaming: false },
      async generate(): Promise<ModelResponse> {
        calls += 1;
        return calls === 1
          ? { message: { role: "assistant", content: "running", toolCalls: [{ id: "command-1", name: "run_command", input: { command: process.execPath, args: ["-e", "require('node:fs').writeFileSync('generated.txt', 'created\\n')"] } } ] } }
          : { message: { role: "assistant", content: "done" } };
      },
    };

    const result = await new Agent(model, registry, { changeTracker: new RunChangeTracker({ root }) }).run("create a file");
    assert.equal(result.diff?.files[0]?.path, "generated.txt");
    assert.match(result.diff?.text ?? "", /\+created/);
  });
});
