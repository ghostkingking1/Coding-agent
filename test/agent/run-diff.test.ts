import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Agent } from "../../src/agent/agent.ts";
import { cleanupStaleBaselineDirectories, RunChangeTracker } from "../../src/agent/run-diff.ts";
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

test("each tracker gets independent session and run IDs", () => {
  const first = new RunChangeTracker();
  const second = new RunChangeTracker();
  assert.match(first.sessionId, /^sess_[A-Za-z0-9-]+$/);
  assert.match(first.runId, /^run_[A-Za-z0-9-]+$/);
  assert.notEqual(first.sessionId, second.sessionId);
  assert.notEqual(first.runId, second.runId);
});

test("stale cleanup only removes old baseline directories", async () => {
  await withWorkspace(async (root) => {
    const stale = path.join(root, "coding-agent-baseline-stale");
    const fresh = path.join(root, "coding-agent-baseline-fresh");
    const other = path.join(root, "other-temp");
    await fs.mkdir(stale);
    await fs.mkdir(fresh);
    await fs.mkdir(other);
    const old = new Date(Date.now() - 60_000);
    await fs.utimes(stale, old, old);

    await cleanupStaleBaselineDirectories({ tempRoot: root, maxAgeMs: 1_000 });
    await assert.rejects(() => fs.stat(stale));
    await fs.stat(fresh);
    await fs.stat(other);
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
    assert.equal(result.files.length, 0);
    assert.equal(result.text, "");
    assert.equal(result.truncated, false);
    assert.equal(result.complete, true);
    assert.deepEqual(result.omittedPaths, []);
    assert.deepEqual(result.untrackedPaths, []);
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

test("reuses a session baseline and checkpoints only incremental changes", async () => {
  await withWorkspace(async (root) => {
    const stable = path.join(root, "stable.txt");
    const changing = path.join(root, "changing.txt");
    await fs.writeFile(stable, "stable\n", "utf8");
    await fs.writeFile(changing, "one\n", "utf8");
    const tracker = new RunChangeTracker({ root, reuseBaseline: true });
    await tracker.start();

    await fs.writeFile(changing, "two\n", "utf8");
    const first = await tracker.finish();
    assert.deepEqual(first.files.map((file) => file.path), ["changing.txt"]);

    await fs.writeFile(changing, "three\n", "utf8");
    const second = await tracker.finish();
    assert.deepEqual(second.files.map((file) => file.path), ["changing.txt"]);
    assert.match(second.text, /-two/);
    assert.match(second.text, /\+three/);
    await tracker.dispose();
  });
});

test("reusable baseline is cleaned when disposed after an exception", async () => {
  await withWorkspace(async (root) => {
    const tracker = new RunChangeTracker({ root, reuseBaseline: true });
    await tracker.start();
    await assert.doesNotReject(() => tracker.dispose());
    await assert.doesNotReject(() => tracker.dispose());
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
