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
  try { await run(root, path.join(root, "sessions.sqlite")); } finally { await removeTemporaryDirectory(root); }
}

/** Windows 释放 SQLite WAL sidecar 句柄存在延迟；重试只属于测试清理，不进入业务代码。 */
async function removeTemporaryDirectory(directory: string): Promise<void> {
  const maxAttempts = 20;
  let lastError: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      await fs.rm(directory, { recursive: true, force: true });
      return;
    } catch (error) {
      lastError = error;
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EBUSY" && code !== "EPERM") throw error;
      await new Promise((resolve) => setTimeout(resolve, Math.min(250, 25 * 2 ** attempt)));
    }
  }
  throw lastError;
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
    await store.startRun({ id: "run-interrupted", sessionId: "session-recovery", status: "running", input: "unfinished", startedAt: "2026-01-01T00:00:01.000Z", leaseUntil: new Date(Date.now() - 1_000).toISOString() });
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

test("SQLite persists and reads the latest run checkpoint", async () => {
  await withDatabase(async (root, databasePath) => {
    const store = new SqliteSessionStore(databasePath);
    await store.createSession({ id: "session-checkpoint", workspaceRoot: root, createdAt: "2026-01-01T00:00:00.000Z" });
    await store.startRun({ id: "run-checkpoint", sessionId: "session-checkpoint", status: "running", input: "inspect", startedAt: "2026-01-01T00:00:01.000Z" });
    await store.saveCheckpoint({ sessionId: "session-checkpoint", runId: "run-checkpoint", step: 1, phase: "tool", messages: [{ role: "tool", content: "ok", toolCallId: "c1", toolName: "read" }], toolResults: [{ key: "run-checkpoint:1:c1", toolCallId: "c1", toolName: "read", status: "completed", result: "ok" }], updatedAt: "2026-01-01T00:00:02.000Z" });
    assert.equal((await store.getCheckpoint("session-checkpoint", "run-checkpoint"))?.toolResults[0]?.result, "ok");
    await store.close();
  });
});

test("SQLite persists the independent context checkpoint", async () => {
  await withDatabase(async (root, databasePath) => {
    const store = new SqliteSessionStore(databasePath);
    await store.createSession({ id: "session-context", workspaceRoot: root, createdAt: "2026-01-01T00:00:00.000Z" });
    await store.saveContextCheckpoint({ sessionId: "session-context", coveredThroughSequence: 3, sourcePrefixHash: "hash", summarySegments: [{ summaryId: "sum", sourceMessageIndexes: [0, 1], content: "summary" }], retainedTailStart: 4, updatedAt: "2026-01-01T00:01:00.000Z" });
    const checkpoint = await store.getContextCheckpoint("session-context");
    assert.equal(checkpoint?.coveredThroughSequence, 3);
    assert.equal(checkpoint?.summarySegments[0]?.content, "summary");
    await store.close();
  });
});

test("SQLite persists append-only audit events in sequence order", async () => {
  await withDatabase(async (root, databasePath) => {
    const store = new SqliteSessionStore(databasePath);
    await store.record({ sessionId: "audit-session", runId: "audit-run", eventType: "model_attempt", attempt: 1 });
    await store.record({ sessionId: "audit-session", runId: "audit-run", eventType: "model_retry", attempt: 1, errorCode: "rate_limited", metadata: { delayMs: 10 } });
    const events = await store.listAuditEvents("audit-session", "audit-run");
    assert.deepEqual(events.map((event) => event.eventType), ["model_attempt", "model_retry"]);
    assert.equal(events[1]?.metadata?.delayMs, 10);
    await store.close();
  });
});

test("recovery resumes from a tool checkpoint without replaying the completed tool", async () => {
  await withDatabase(async (root, databasePath) => {
    const store = new SqliteSessionStore(databasePath);
    const sessionId = "session-resume";
    const runId = "run-resume";
    await store.createSession({ id: sessionId, workspaceRoot: root, createdAt: "2026-01-01T00:00:00.000Z" });
    await store.startRun({ id: runId, sessionId, status: "running", input: "inspect", startedAt: "2026-01-01T00:00:01.000Z", leaseUntil: new Date(Date.now() - 1_000).toISOString() });
    await store.saveCheckpoint({ sessionId, runId, step: 1, phase: "tool", messages: [
      { role: "user", content: "inspect" },
      { role: "assistant", content: "", toolCalls: [{ id: "call-read", name: "read_file", input: { path: "a.ts" } }] },
      { role: "tool", content: "saved output", toolCallId: "call-read", toolName: "read_file" },
    ], toolResults: [{ key: `${runId}:1:call-read`, toolCallId: "call-read", toolName: "read_file", status: "completed", result: "saved output" }], updatedAt: "2026-01-01T00:00:02.000Z" });
    const requests: string[][] = [];
    const resumedModel = model(requests);
    const manager = new SessionManager(new Agent(resumedModel, undefined, { includeRunDiff: false }), store, root);
    const recovered = await manager.recover(sessionId);
    const result = await recovered.resume();
    assert.equal(result.finalText, "answer:inspect");
    assert.deepEqual(requests[0], ["user:inspect", "assistant:", "tool:saved output"]);
    assert.equal((await store.listRuns(sessionId))[0]?.status, "completed");
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
