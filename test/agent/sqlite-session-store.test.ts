import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Agent } from "../../src/agent/agent.ts";
import { SessionManager } from "../../src/agent/session-manager.ts";
import { SqliteSessionStore } from "../../src/agent/sqlite-session-store.ts";
import type { ModelClient, ModelResponse } from "../../src/agent/types.ts";
import { DefaultContextManager } from "../../src/agent/context-manager.ts";
import { DatabaseSync } from "node:sqlite";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { GitRepository } from "../../src/repository/git.ts";
import { RecoveryPointCoordinator } from "../../src/agent/recovery-point.ts";
import type { VerificationSummary } from "../../src/agent/types.ts";

const capabilities = { toolCalling: false, streaming: false } as const;

function git(root: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => execFile("git", ["-C", root, ...args], { encoding: "utf8" }, (error, stdout, stderr) => error ? reject(new Error(stderr || error.message)) : resolve(stdout.trim())));
}

const passedVerification: VerificationSummary = { required: true, writeObserved: true, status: "passed", verifierTool: "run_tests", verificationPassed: true, verificationAttempts: 1, repairAttempts: 0, evidence: [{ evidenceId: "e1", toolName: "run_tests", kind: "test", status: "passed", reason: "passed", recordedAt: "2026-01-01T00:00:00.000Z" }] };

async function withDatabase(run: (root: string, databasePath: string) => Promise<void>): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "coding-agent-session-db-"));
  let failure: unknown;
  try { await run(root, path.join(root, "sessions.sqlite")); } catch (error) { failure = error; }
  try { await removeTemporaryDirectory(root); } catch (error) { if (failure === undefined) throw error; }
  if (failure !== undefined) throw failure;
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
    assert.equal(restored.runs[0]?.status, "interrupted");
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
    await store.saveContextCheckpoint({ sessionId: "session-context", version: 4, parentVersion: 3, summaryVersion: "summary-v1", compressionStrategyVersion: "context-compaction-v1", coveredThroughSequence: 3, sourcePrefixHash: "hash", summarySegments: [{ summaryId: "sum", sourceMessageIndexes: [0, 1], content: "summary" }], retainedTailStart: 4, updatedAt: "2026-01-01T00:01:00.000Z" });
    const checkpoint = await store.getContextCheckpoint("session-context");
    assert.equal(checkpoint?.coveredThroughSequence, 3);
    assert.equal(checkpoint?.summarySegments[0]?.content, "summary");
    assert.equal(checkpoint?.version, 4);
    assert.equal(checkpoint?.parentVersion, 3);
    assert.equal(checkpoint?.compressionStrategyVersion, "context-compaction-v1");
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
    assert.deepEqual((await store.listAuditEvents(sessionId, runId)).map((event) => event.eventType), ["run_resumed", "model_attempt", "run_completed"]);
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

test("SQLite clears run leases after completion and failure", async () => {
  await withDatabase(async (root, databasePath) => {
    const store = new SqliteSessionStore(databasePath);
    await store.createSession({ id: "session-lease-cleanup", workspaceRoot: root, createdAt: "2026-01-01T00:00:00.000Z" });
    await store.startRun({ id: "run-complete", sessionId: "session-lease-cleanup", status: "running", input: "ok", startedAt: "2026-01-01T00:00:01.000Z", ownerId: "owner", leaseUntil: "2026-01-01T00:01:00.000Z" });
    await store.completeRun({ run: { id: "run-complete", sessionId: "session-lease-cleanup", status: "completed", input: "ok", finalText: "done", startedAt: "2026-01-01T00:00:01.000Z", finishedAt: "2026-01-01T00:00:02.000Z", result: { finalText: "done", messages: [], steps: 1, stopReason: "completed", taskState: "completed", verification: { required: false, writeObserved: false, status: "not_required", verificationPassed: false, verificationAttempts: 0, repairAttempts: 0, evidence: [] } } } as never, messages: [] });
    await store.startRun({ id: "run-fail", sessionId: "session-lease-cleanup", status: "running", input: "bad", startedAt: "2026-01-01T00:00:03.000Z", ownerId: "owner", leaseUntil: "2026-01-01T00:01:00.000Z" });
    await store.failRun({ sessionId: "session-lease-cleanup", runId: "run-fail", status: "failed", error: "bad", finishedAt: "2026-01-01T00:00:04.000Z" });
    const runs = await store.listRuns("session-lease-cleanup");
    assert.equal(runs[0]?.ownerId, undefined);
    assert.equal(runs[0]?.leaseUntil, undefined);
    assert.equal(runs[1]?.ownerId, undefined);
    assert.equal(runs[1]?.leaseUntil, undefined);
    await store.close();
  });
});

test("SQLite summary cache survives restart and is reused independently of context checkpoints", async () => {
  await withDatabase(async (_root, databasePath) => {
    const messages: import("../../src/agent/types.ts").Message[] = [
      { role: "user", content: "old request ".repeat(20) },
      { role: "assistant", content: "old response ".repeat(20) },
      { role: "user", content: "new request" },
    ];
    const sourceHash = crypto.createHash("sha256").update(JSON.stringify(messages.slice(0, 2))).digest("hex");
    const cacheKey = `${sourceHash}:summary-v1:context-compaction-v1`;
    const firstStore = new SqliteSessionStore(databasePath);
    let firstCalls = 0;
    await new DefaultContextManager({ summarize: async () => { firstCalls += 1; return "cached across restart"; } })
      .compact(messages, { maxInputTokens: 60, recentTurns: 1 }, firstStore);
    assert.equal(firstCalls, 1);
    assert.equal((await firstStore.getSummaryCache(cacheKey))?.content, "cached across restart");
    await firstStore.close();

    const reopenedStore = new SqliteSessionStore(databasePath);
    let secondCalls = 0;
    const result = await new DefaultContextManager({ summarize: async () => { secondCalls += 1; return "should not run"; } })
      .compact(messages, { maxInputTokens: 60, recentTurns: 1 }, reopenedStore);
    assert.equal(secondCalls, 0);
    assert.ok(result.messages.some((message) => message.content.includes("cached across restart")));
    await reopenedStore.close();
  });
});

test("session recovery loads the persisted compacted view plus only the incremental tail", async () => {
  await withDatabase(async (root, databasePath) => {
    let summaryCalls = 0;
    const firstStore = new SqliteSessionStore(databasePath);
    const firstAgent = new Agent(model(), undefined, {
      includeRunDiff: false,
      contextBudget: { maxInputTokens: 150, recentTurns: 1 },
      contextManager: new DefaultContextManager({ summarize: async () => { summaryCalls += 1; return "persisted old work"; } }),
    });
    const session = await new SessionManager(firstAgent, firstStore, root).create("session-compact-resume");
    await session.run("first request ".repeat(12));
    await session.run("second request ".repeat(12));
    const persistedCount = await firstStore.countMessages("session-compact-resume");
    const checkpoint = await firstStore.getContextCheckpoint("session-compact-resume");
    assert.ok(checkpoint?.resumeMessages);
    assert.equal(checkpoint.sourceMessageCount, persistedCount);
    assert.equal(checkpoint.coveredThroughSequence, persistedCount - 1);
    assert.ok((checkpoint.version ?? 0) >= 1);
    assert.equal(checkpoint.summaryVersion, "summary-v1");
    assert.ok(checkpoint.resumeMessages.length < persistedCount);
    const transcriptBeforeRestart = await firstStore.listMessages("session-compact-resume");
    assert.ok(transcriptBeforeRestart.some((entry) => entry.message.content.includes("first request first request")));
    assert.ok(!transcriptBeforeRestart.some((entry) => entry.message.content.includes("persisted old work")));
    await firstStore.close();

    let restoredSummaryCalls = 0;
    const restoredSummaryInputs: string[][] = [];
    const requests: string[][] = [];
    const restoredStore = new SqliteSessionStore(databasePath);
    const restoredAgent = new Agent(model(requests), undefined, {
      includeRunDiff: false,
      contextBudget: { maxInputTokens: 150, recentTurns: 1 },
      contextManager: new DefaultContextManager({ summarize: async (messages) => {
        restoredSummaryCalls += 1;
        restoredSummaryInputs.push(messages.map((message) => message.content));
        return "incremental persisted summary";
      } }),
    });
    const restored = await new SessionManager(restoredAgent, restoredStore, root).load("session-compact-resume");
    assert.ok(restored.messages.length < persistedCount);
    assert.ok(restored.messages.some((message) => message.content.includes("persisted old work")));
    assert.deepEqual(restored.messages, checkpoint.resumeMessages);
    await restored.run("third request");
    assert.ok(restoredSummaryCalls <= 1);
    assert.equal(restoredSummaryInputs.flat().some((content) => content.includes("first request first request")), false);
    assert.equal(requests[0]?.some((message) => message.includes("first request first request")), false);
    assert.equal(await restoredStore.countMessages("session-compact-resume"), persistedCount + 2);
    const transcriptAfterRestart = await restoredStore.listMessages("session-compact-resume");
    assert.ok(transcriptAfterRestart.some((entry) => entry.message.content.includes("first request first request")));
    const latestCheckpoint = await restoredStore.getContextCheckpoint("session-compact-resume");
    assert.equal(latestCheckpoint?.coveredThroughSequence, transcriptAfterRestart.length - 1);
    assert.ok((latestCheckpoint?.version ?? 0) > (checkpoint.version ?? 0));
    assert.ok((await restoredStore.listAuditEvents("session-compact-resume")).some((event) => event.eventType === "context_checkpoint_restored"));
    await restoredStore.close();
  });
});

test("SQLite migrates a version 5 context checkpoint without losing its summary", async () => {
  await withDatabase(async (_root, databasePath) => {
    const legacy = new DatabaseSync(databasePath);
    legacy.exec(`
      CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY);
      INSERT INTO schema_migrations(version) VALUES (5);
      CREATE TABLE context_checkpoints (
        session_id TEXT PRIMARY KEY,
        covered_through_sequence INTEGER NOT NULL,
        source_prefix_hash TEXT NOT NULL,
        summary_segments_json TEXT NOT NULL,
        retained_tail_start INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO context_checkpoints VALUES ('legacy-session', 1, 'hash', '[{"summaryId":"sum","sourceMessageIndexes":[0,1],"content":"legacy"}]', 2, '2026-01-01T00:00:00.000Z');
    `);
    legacy.close();

    const store = new SqliteSessionStore(databasePath);
    const checkpoint = await store.getContextCheckpoint("legacy-session");
    assert.equal(checkpoint?.summarySegments[0]?.content, "legacy");
    assert.equal(checkpoint?.resumeMessages, undefined);
    await store.close();
  });
});

test("SQLite merges run and context checkpoints while keeping context and tool JSON separate", async () => {
  await withDatabase(async (root, databasePath) => {
    const store = new SqliteSessionStore(databasePath);
    await store.createSession({ id: "session-merged-checkpoints", workspaceRoot: root, createdAt: "2026-01-01T00:00:00.000Z" });
    await store.startRun({ id: "run-merged-checkpoints", sessionId: "session-merged-checkpoints", status: "running", input: "inspect", startedAt: "2026-01-01T00:00:01.000Z" });
    await store.saveCheckpoint({ sessionId: "session-merged-checkpoints", runId: "run-merged-checkpoints", step: 1, phase: "tool", messages: [{ role: "user", content: "inspect" }], toolResults: [{ key: "k", toolCallId: "c", toolName: "read", status: "completed", result: "output" }], updatedAt: "2026-01-01T00:00:02.000Z" });
    await store.saveContextCheckpoint({ sessionId: "session-merged-checkpoints", coveredThroughSequence: 0, sourcePrefixHash: "hash", summarySegments: [], retainedTailStart: 1, resumeMessages: [{ role: "user", content: "inspect" }], updatedAt: "2026-01-01T00:00:03.000Z" });
    await store.close();
    const database = new DatabaseSync(databasePath);
    const tables = (database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('checkpoints', 'context_checkpoints') ORDER BY name").all() as Array<{ name: string }>).map((row) => row.name);
    assert.deepEqual(tables, ["checkpoints"]);
    const columns = (database.prepare("PRAGMA table_info(checkpoints)").all() as Array<{ name: string }>).map((row) => row.name);
    assert.ok(columns.includes("context_json"));
    assert.ok(columns.includes("tool_results_json"));
    const rows = database.prepare("SELECT checkpoint_kind, context_json, tool_results_json FROM checkpoints WHERE session_id = ? ORDER BY checkpoint_kind").all("session-merged-checkpoints") as Array<{ checkpoint_kind: string; context_json: string | null; tool_results_json: string | null }>;
    assert.deepEqual(rows.map((row) => row.checkpoint_kind), ["context", "run"]);
    assert.equal(rows.find((row) => row.checkpoint_kind === "run")?.tool_results_json, JSON.stringify([{ key: "k", toolCallId: "c", toolName: "read", status: "completed", result: "output" }]));
    database.close();
  });
});

test("RecoveryPoint binds frozen context to a Git tree object and preserves sequence history", async () => {
  await withDatabase(async (root, databasePath) => {
    await git(root, ["init", "-q"]);
    await git(root, ["config", "user.email", "test@example.com"]);
    await git(root, ["config", "user.name", "Recovery Test"]);
    await fs.writeFile(path.join(root, "app.ts"), "one\n");
    await git(root, ["add", "app.ts"]);
    await git(root, ["commit", "-qm", "initial"]);
    const store = new SqliteSessionStore(databasePath);
    const sessionId = "session-recovery-point";
    await store.createSession({ id: sessionId, workspaceRoot: root, createdAt: "2026-01-01T00:00:00.000Z" });
    await store.startRun({ id: "run-recovery-1", sessionId, status: "running", input: "one", startedAt: "2026-01-01T00:00:00.500Z" });
    await store.saveContextCheckpoint({ sessionId, coveredThroughSequence: 0, sourcePrefixHash: "hash", summarySegments: [], retainedTailStart: 0, resumeMessages: [{ role: "user", content: "one" }], version: 1, summaryVersion: "summary-v1", compressionStrategyVersion: "context-compaction-v1", updatedAt: "2026-01-01T00:00:01.000Z" });
    const coordinator = new RecoveryPointCoordinator(store, new GitRepository(root), { requireCleanStart: false });
    const first = await coordinator.createForCompletedRun({ sessionId, runId: "run-recovery-1", verification: passedVerification, eligibleAtStart: true });
    assert.equal(first?.sequence, 1);
    assert.equal(first?.workspaceRevision.objectType, "tree");
    await store.failRun({ sessionId, runId: "run-recovery-1", status: "failed", error: "test transition", finishedAt: "2026-01-01T00:00:01.000Z" });
    await fs.writeFile(path.join(root, "app.ts"), "two\n");
    await store.startRun({ id: "run-recovery-2", sessionId, status: "running", input: "two", startedAt: "2026-01-01T00:00:01.500Z" });
    await store.saveContextCheckpoint({ sessionId, coveredThroughSequence: 1, sourcePrefixHash: "hash2", summarySegments: [], retainedTailStart: 1, resumeMessages: [{ role: "user", content: "two" }], version: 2, summaryVersion: "summary-v1", compressionStrategyVersion: "context-compaction-v1", updatedAt: "2026-01-01T00:00:02.000Z" });
    const second = await coordinator.createForCompletedRun({ sessionId, runId: "run-recovery-2", verification: passedVerification, eligibleAtStart: true });
    assert.equal(second?.sequence, 2);
    assert.equal(second?.previousRecoveryPointId, first?.id);
    assert.equal((await store.getFrozenContextCheckpoint!(sessionId, first!.contextCheckpointId))?.resumeMessages?.[0]?.content, "one");
    assert.equal((await store.getFrozenContextCheckpoint!(sessionId, second!.contextCheckpointId))?.resumeMessages?.[0]?.content, "two");
    await store.close();
  });
});
