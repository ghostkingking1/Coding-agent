import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Agent } from "../../src/agent/agent.ts";
import { SessionManager } from "../../src/agent/session-manager.ts";
import { SqliteSessionStore } from "../../src/agent/sqlite-session-store.ts";
import type { ModelClient, ModelResponse } from "../../src/agent/types.ts";

const capabilities = { toolCalling: false, streaming: false } as const;

async function withDatabase(run: (root: string, databasePath: string) => Promise<void>): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "coding-agent-session-db-"));
  try { await run(root, path.join(root, "sessions.sqlite")); } finally { await fs.rm(root, { recursive: true, force: true }); }
}

function model(requests: string[][] = []): ModelClient {
  return {
    provider: "fake",
    model: "fake",
    capabilities,
    async generate(request): Promise<ModelResponse> {
      requests.push(request.messages.map((message) => `${message.role}:${message.content}`));
      return { message: { role: "assistant", content: `answer:${request.messages.findLast((message) => message.role === "user")?.content}` } };
    },
  };
}

test("SQLite SessionStore persists multiple sessions and restores committed context", async () => {
  await withDatabase(async (root, databasePath) => {
    const firstStore = new SqliteSessionStore(databasePath);
    const manager = new SessionManager(new Agent(model(), undefined, { includeRunDiff: false }), firstStore, root);
    const first = await manager.create("session-one");
    const second = await manager.create("session-two");
    await first.run("one");
    await second.run("other");
    assert.deepEqual((await manager.list()).map((session) => session.id), ["session-two", "session-one"]);
    await firstStore.close();

    const requests: string[][] = [];
    const recoveredStore = new SqliteSessionStore(databasePath);
    const recovered = await new SessionManager(new Agent(model(requests), undefined, { includeRunDiff: false }), recoveredStore, root).load("session-one");
    await recovered.run("two");
    assert.deepEqual(requests[0], ["user:one", "assistant:answer:one", "user:two"]);
    assert.equal(recovered.runs.length, 2);
    await recoveredStore.close();
  });
});

test("recovery marks an unfinished run interrupted without committing messages", async () => {
  await withDatabase(async (root, databasePath) => {
    const store = new SqliteSessionStore(databasePath);
    await store.createSession({ id: "session-recovery", workspaceRoot: root, createdAt: "2026-01-01T00:00:00.000Z" });
    await store.startRun({ id: "run-interrupted", sessionId: "session-recovery", status: "running", input: "unfinished", startedAt: "2026-01-01T00:00:01.000Z" });
    const restored = await new SessionManager(new Agent(model(), undefined, { includeRunDiff: false }), store, root).recover("session-recovery");
    assert.equal(restored.messages.length, 0);
    assert.equal(restored.runs[0]?.status, "failed");
    assert.equal((restored.runs[0] as { error: string }).error, "Process ended before run completion");
    await restored.close();
    await store.close();
  });
});

test("loading an actively running session refuses without changing its state", async () => {
  await withDatabase(async (root, databasePath) => {
    const store = new SqliteSessionStore(databasePath);
    await store.createSession({ id: "session-active", workspaceRoot: root, createdAt: "2026-01-01T00:00:00.000Z" });
    await store.startRun({ id: "run-active", sessionId: "session-active", status: "running", input: "still running", startedAt: "2026-01-01T00:00:01.000Z" });
    const manager = new SessionManager(new Agent(model(), undefined, { includeRunDiff: false }), store, root);
    await assert.rejects(() => manager.load("session-active"), /active run/);
    assert.equal((await store.listRuns("session-active"))[0]?.status, "running");
    await store.close();
  });
});

test("SQLite prevents a second process from starting a concurrent run", async () => {
  await withDatabase(async (root, databasePath) => {
    const store = new SqliteSessionStore(databasePath);
    await store.createSession({ id: "session-lock", workspaceRoot: root, createdAt: "2026-01-01T00:00:00.000Z" });
    await store.startRun({ id: "run-one", sessionId: "session-lock", status: "running", input: "one", startedAt: "2026-01-01T00:00:01.000Z" });
    await assert.rejects(() => store.startRun({ id: "run-two", sessionId: "session-lock", status: "running", input: "two", startedAt: "2026-01-01T00:00:02.000Z" }), /active run/);
    await store.close();
  });
});

test("SQLite SessionStore rejects duplicate sessions and workspace-mismatched recovery", async () => {
  await withDatabase(async (root, databasePath) => {
    const store = new SqliteSessionStore(databasePath);
    const manager = new SessionManager(new Agent(model(), undefined, { includeRunDiff: false }), store, root);
    await manager.create("session-unique");
    await assert.rejects(() => manager.create("session-unique"));
    await assert.rejects(() => new SessionManager(new Agent(model(), undefined, { includeRunDiff: false }), store, path.join(root, "other")).load("session-unique"), /workspace/);
    await store.close();
  });
});
