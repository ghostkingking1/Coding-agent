import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ToolOutputStore } from "../../src/agent/tool-output-store.ts";
import { createToolOutputReadTool } from "../../src/tools/tool-output-tool.ts";

test("stores oversized output and reads it back in bounded pages", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "coding-agent-output-test-"));
  const store = new ToolOutputStore({ rootDirectory: root, maxPreviewCharacters: 32 });
  try {
    const saved = await store.save("session", "run", "0123456789abcdefghij");
    assert.match(saved.message, /artifactId=out_/);
    const id = saved.artifact.artifactId;
    assert.equal((await store.read("session", "run", id, 0, 5)).content, "01234");
    assert.equal((await store.read("session", "run", id, 5, 5)).content, "56789");
    const tool = createToolOutputReadTool(store);
    const page = await tool.execute({ artifactId: id, offset: 10, limit: 4 }, { messages: [], sessionId: "session", runId: "run" }) as { content: string };
    assert.equal(page.content, "abcd");
    await assert.rejects(() => store.read("other", "run", id, 0, 1), /not found/);
  } finally {
    await store.dispose();
  }
});

test("rejects invalid artifact identifiers and unbounded pages", async () => {
  const store = new ToolOutputStore({ rootDirectory: path.join(os.tmpdir(), "coding-agent-output-invalid") });
  await assert.rejects(() => store.read("s", "r", "../../secret", 0, 1), /Invalid artifactId/);
  await assert.rejects(() => store.read("s", "r", "out_missing", 0, 100_001), /offset and limit/);
  await store.dispose();
});

test("marks output beyond the artifact quota as incomplete", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "coding-agent-output-limit-"));
  const store = new ToolOutputStore({ rootDirectory: root, maxArtifactBytes: 4 });
  try {
    const saved = await store.save("session", "run", "abcdef");
    assert.equal(saved.artifact.complete, false);
    assert.match(saved.message, /不可恢复/);
    assert.equal((await store.read("session", "run", saved.artifact.artifactId, 0, 10)).complete, false);
  } finally { await store.dispose(); }
});
