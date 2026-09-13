import assert from "node:assert/strict";
import test from "node:test";
import { TaskStateMachine } from "../../src/agent/task-state-machine.ts";

test("task state machine emits legal transitions and tracks verification", async () => {
  const transitions: string[] = [];
  const machine = new TaskStateMachine({ mode: "coding" }, (from, to, reason) => {
    transitions.push(`${from}->${to}:${reason}`);
  });

  await machine.start();
  await machine.observeWrite("apply_patch");
  await machine.observeVerification("run_tests", false);
  await machine.beginWork();
  await machine.observeVerification("run_tests", true);
  assert.equal(await machine.complete(), true);
  assert.equal(machine.state, "completed");
  assert.deepEqual(machine.summary(), {
    required: true,
    writeObserved: true,
    verifierTool: "run_tests",
    verificationPassed: true,
    verificationAttempts: 2,
    repairAttempts: 1,
  });
  assert.deepEqual(transitions.map((value) => value.split(":", 1)[0]), [
    "received->working",
    "working->verifying",
    "verifying->repairing",
    "repairing->working",
    "working->verifying",
    "verifying->completed",
  ]);
});

test("task state machine blocks after the configured repair limit", async () => {
  const machine = new TaskStateMachine({ mode: "coding", maxRepairAttempts: 3 });
  await machine.start();
  await machine.observeWrite("apply_patch");
  await machine.observeVerification("run_tests", false);
  await machine.beginWork();
  await machine.observeVerification("run_tests", false);
  await machine.beginWork();
  await machine.observeVerification("run_tests", false);
  assert.equal(machine.state, "blocked");
  assert.equal(machine.isBlocked, true);
  assert.equal(machine.requiresVerification, true);
  assert.equal(machine.summary().repairAttempts, 3);
  assert.equal(await machine.complete(), false);
});

test("task state machine rejects re-entering a terminal state", async () => {
  const machine = new TaskStateMachine({ mode: "coding" });
  await machine.start();
  assert.equal(await machine.complete(), true);
  await assert.rejects(() => machine.observeWrite("apply_patch"), /Completed task cannot observe a write/);
});
