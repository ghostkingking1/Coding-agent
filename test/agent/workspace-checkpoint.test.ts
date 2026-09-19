import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { WorkspaceCheckpointManager } from "../../src/agent/workspace-checkpoint.ts";
import type { VerificationEvidence, VerificationSummary } from "../../src/agent/types.ts";

async function withRoots(run: (workspace: string, storage: string) => Promise<void>): Promise<void> {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "coding-agent-checkpoint-test-"));
  const workspace = path.join(parent, "workspace");
  const storage = path.join(parent, "storage");
  await fs.mkdir(workspace);
  try { await run(workspace, storage); } finally { await fs.rm(parent, { recursive: true, force: true }); }
}

function passedEvidence(id = "evidence-passed"): VerificationEvidence {
  return { evidenceId: id, toolName: "run_tests", kind: "test", status: "passed", reason: "tests passed", recordedAt: "2026-01-01T00:00:00.000Z" };
}

function passedSummary(id?: string): VerificationSummary {
  return { required: true, writeObserved: true, status: "passed", verifierTool: "run_tests", verificationPassed: true, verificationAttempts: 1, repairAttempts: 0, evidence: [passedEvidence(id)] };
}

test("known_good checkpoint survives manager restart in persistent CAS", async () => {
  await withRoots(async (workspace, storage) => {
    await fs.mkdir(path.join(workspace, "src"));
    await fs.writeFile(path.join(workspace, "src", "app.ts"), "const answer = 42;\n");
    const first = new WorkspaceCheckpointManager({ workspaceRoot: workspace, storageRoot: storage });
    const checkpoint = await first.promote("run-one", passedSummary());
    assert.equal(checkpoint.tier, "known_good");
    assert.equal(checkpoint.rollbackEligible, true);

    const restored = new WorkspaceCheckpointManager({ workspaceRoot: workspace, storageRoot: storage });
    assert.equal((await restored.list())[0]?.checkpointId, checkpoint.checkpointId);
    assert.equal(checkpoint.files.length, 1);
    await fs.stat(path.join(storage, "objects", checkpoint.files[0]!.digest.slice(0, 2), checkpoint.files[0]!.digest));
  });
});

test("snapshot quota creates a persistent partial checkpoint without blocking promotion", async () => {
  await withRoots(async (workspace, storage) => {
    await fs.writeFile(path.join(workspace, "large.bin"), Buffer.alloc(64, 1));
    const manager = new WorkspaceCheckpointManager({ workspaceRoot: workspace, storageRoot: storage, maxFileBytes: 8 });
    const checkpoint = await manager.promote("run-partial", passedSummary());
    assert.equal(checkpoint.tier, "partial");
    assert.equal(checkpoint.rollbackEligible, false);
    assert.deepEqual(checkpoint.omittedPaths, ["large.bin"]);
    await assert.rejects(() => manager.rollback(checkpoint.checkpointId, { ownerId: "owner-one", validate: async () => passedEvidence() }), /not eligible/);
  });
});

test("rollback validates the staged workspace before changing live files", async () => {
  await withRoots(async (workspace, storage) => {
    const file = path.join(workspace, "app.ts");
    await fs.writeFile(file, "known good\n");
    const manager = new WorkspaceCheckpointManager({ workspaceRoot: workspace, storageRoot: storage });
    const checkpoint = await manager.promote("run-good", passedSummary());
    await fs.writeFile(file, "current work\n");

    await assert.rejects(() => manager.rollback(checkpoint.checkpointId, {
      ownerId: "owner-one",
      async validate(staging) {
        assert.equal(await fs.readFile(path.join(staging, "app.ts"), "utf8"), "known good\n");
        return { ...passedEvidence("failed-stage"), status: "failed", reason: "tests failed" };
      },
    }), /did not pass/);
    assert.equal(await fs.readFile(file, "utf8"), "current work\n");
  });
});

test("rollback restores known_good files, removes later files, and preserves allowed output directories", async () => {
  await withRoots(async (workspace, storage) => {
    await fs.writeFile(path.join(workspace, "app.ts"), "known good\n");
    const manager = new WorkspaceCheckpointManager({ workspaceRoot: workspace, storageRoot: storage });
    const checkpoint = await manager.promote("run-good", passedSummary());
    await fs.writeFile(path.join(workspace, "app.ts"), "broken\n");
    await fs.writeFile(path.join(workspace, "later.ts"), "remove me\n");
    await fs.mkdir(path.join(workspace, "coverage"));
    await fs.writeFile(path.join(workspace, "coverage", "summary.json"), "{}\n");

    const result = await manager.rollback(checkpoint.checkpointId, { ownerId: "owner-one", validate: async () => passedEvidence("rollback-evidence") });
    assert.equal(result.restoredFiles, 1);
    assert.equal(result.deletedFiles, 1);
    assert.equal(await fs.readFile(path.join(workspace, "app.ts"), "utf8"), "known good\n");
    await assert.rejects(() => fs.stat(path.join(workspace, "later.ts")));
    assert.equal(await fs.readFile(path.join(workspace, "coverage", "summary.json"), "utf8"), "{}\n");
  });
});

test("workspace lease rejects a concurrent rollback", async () => {
  await withRoots(async (workspace, storage) => {
    await fs.writeFile(path.join(workspace, "app.ts"), "known good\n");
    const first = new WorkspaceCheckpointManager({ workspaceRoot: workspace, storageRoot: storage });
    const second = new WorkspaceCheckpointManager({ workspaceRoot: workspace, storageRoot: storage });
    const checkpoint = await first.promote("run-good", passedSummary());
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const pending = first.rollback(checkpoint.checkpointId, {
      ownerId: "owner-one",
      async validate() { entered(); await held; return passedEvidence(); },
    });
    await started;
    await assert.rejects(() => second.rollback(checkpoint.checkpointId, { ownerId: "owner-two", validate: async () => passedEvidence() }), /active lease/);
    release();
    await pending;
  });
});

test("known_good retention evicts old metadata and unreferenced CAS objects", async () => {
  await withRoots(async (workspace, storage) => {
    const file = path.join(workspace, "app.ts");
    const manager = new WorkspaceCheckpointManager({ workspaceRoot: workspace, storageRoot: storage, maxKnownGood: 1 });
    await fs.writeFile(file, "one\n");
    const first = await manager.promote("run-one", passedSummary("e-one"));
    await new Promise((resolve) => setTimeout(resolve, 5));
    await fs.writeFile(file, "two\n");
    const second = await manager.promote("run-two", passedSummary("e-two"));
    assert.deepEqual((await manager.list()).map((value) => value.checkpointId), [second.checkpointId]);
    await assert.rejects(() => fs.stat(path.join(storage, "checkpoints", `${first.checkpointId}.json`)));
    const oldObject = first.files[0]!.digest;
    await assert.rejects(() => fs.stat(path.join(storage, "objects", oldObject.slice(0, 2), oldObject)));
  });
});

test("persisted checkpoint metadata rejects paths outside the workspace", async () => {
  await withRoots(async (workspace, storage) => {
    const manager = new WorkspaceCheckpointManager({ workspaceRoot: workspace, storageRoot: storage });
    await fs.writeFile(path.join(workspace, "app.ts"), "ok\n");
    await manager.promote("run-good", passedSummary());
    await fs.writeFile(path.join(storage, "checkpoints", `cp_${"a".repeat(32)}.json`), JSON.stringify({
      checkpointId: `cp_${"a".repeat(32)}`,
      runId: "foreign",
      workspaceRoot: workspace,
      createdAt: "2026-01-01T00:00:00.000Z",
      tier: "known_good",
      rollbackEligible: true,
      files: [{ path: "../outside", digest: "b".repeat(64), size: 1, mode: 0o644 }],
      omittedPaths: [],
      totalBytes: 1,
    }));
    await assert.rejects(() => manager.list(), /relative path/);
  });
});
