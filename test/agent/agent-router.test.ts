import assert from "node:assert/strict";
import test from "node:test";
import { AgentRouter, TaskOrchestrator, roleInput, parseReviewProtocol, parseReflectionProtocol, RoleProtocolError, type TaskContext } from "../../src/agent/agent-router.ts";
import type { AgentResult } from "../../src/agent/types.ts";
import type { RunDiff } from "../../src/agent/run-diff.ts";

function diff(paths: readonly string[], addedLines = 0, removedLines = 0) {
  return { sessionId: "s", runId: "r", files: paths.map((path) => ({ path, diff: "", addedLines, removedLines })), text: "", truncated: false, complete: true, omittedPaths: [], untrackedPaths: [] } satisfies RunDiff;
}

test("simple work routes only to Execute", () => {
  const decision = new AgentRouter().decideInitial({ request: "rename one local variable" });
  assert.deepEqual(decision.roles, ["execute"]);
  assert.equal(decision.reflectionCandidate, false);
});

test("plan mode and high-risk requests route to Planner before Execute", () => {
  const router = new AgentRouter();
  assert.deepEqual(router.decideInitial({ request: "change the parser", planMode: true }).roles, ["planner", "execute"]);
  assert.deepEqual(router.decideInitial({ request: "design a concurrency rollback migration" }).roles, ["planner", "execute"]);
});

test("post-execution failures route to Reflection, never back to Planner", () => {
  const decision = new AgentRouter().decidePostExecution({
    request: "fix the feature",
    toolCallCount: 8,
    toolFailureCount: 2,
    repairAttempts: 2,
    diff: diff(["src/a.ts"]),
    verification: { required: true, writeObserved: true, status: "failed", verificationPassed: false, verificationAttempts: 2, repairAttempts: 2, evidence: [] },
  });
  assert.equal(decision.roles.includes("planner"), false);
  assert.equal(decision.roles.includes("reflection"), true);
  assert.equal(decision.reflectionCandidate, true);
  assert.ok(decision.reasons.includes("multi_step_repair"));
});

test("large changes can trigger Review and Reflection independently", () => {
  const decision = new AgentRouter({ reviewFileThreshold: 2, reflectionFileThreshold: 4 }).decidePostExecution({
    request: "update the application",
    diff: diff(["src/a.ts", "src/b.ts", "test/a.test.ts", "docs/a.md"], 30, 10),
    verification: { required: true, writeObserved: true, status: "passed", verificationPassed: true, verificationAttempts: 1, repairAttempts: 0, evidence: [] },
  });
  assert.deepEqual(decision.roles, ["execute", "review", "reflection"]);
  assert.equal(decision.reflectionCandidate, true);
});

test("role input exposes only the artifacts required by that role", () => {
  const context = { taskId: "t1", userRequest: "change it", events: [], plan: { kind: "plan", source: "planner", version: 1, plan: {} as never } } satisfies TaskContext;
  const plannerInput = roleInput(context, "planner");
  const executeInput = roleInput(context, "execute");
  assert.equal("plan" in plannerInput, false);
  assert.equal("plan" in executeInput, true);
});

test("orchestrator passes versioned artifacts between roles and keeps failures in Reflection", async () => {
  const calls: string[] = [];
  const result = await new TaskOrchestrator({
    taskId: "task-1",
    request: "fix concurrency rollback migration",
    handlers: {
      planner: async (input) => { calls.push(`planner:${"plan" in input}`); return { kind: "plan", source: "planner", version: 1, plan: {} as never }; },
      execute: async (input) => { calls.push(`execute:${"plan" in input}`); return { kind: "execution", source: "execute", result: { finalText: "done", messages: [], steps: 2, stopReason: "completed", taskState: "completed", verification: { required: true, writeObserved: true, status: "failed", verificationPassed: false, verificationAttempts: 1, repairAttempts: 1, evidence: [] }, diff: diff(["src/a.ts"]) } as AgentResult, toolCallCount: 3, toolFailureCount: 1, repairAttempts: 1 }; },
      review: async (input) => { calls.push(`review:${"execution" in input}`); return { kind: "review", source: "reviewer", decision: "pass", findings: [] }; },
      reflection: async (input) => { calls.push(`reflection:${"execution" in input}`); return { kind: "reflection", source: "reflection", triggeredBy: ["verification_issue"], worthwhile: true, summary: "retry tests", reusableStrategies: ["run focused tests"] }; },
    },
  }).run();
  assert.deepEqual(calls, ["planner:false", "execute:true", "review:true", "reflection:true"]);
  assert.ok(result.context.review);
  assert.ok(result.context.reflection);
  assert.equal(result.postExecutionDecision?.roles.includes("planner"), false);
});

test("orchestrator requires a handler for every routed role", async () => {
  await assert.rejects(() => new TaskOrchestrator({ taskId: "t", request: "architecture migration", handlers: { execute: async () => ({}) as never } }).run(), /Planner was routed/);
});

test("orchestrator re-executes after Review requests repair and reviews the repaired result", async () => {
  let executions = 0;
  let reviews = 0;
  const result = await new TaskOrchestrator({
    taskId: "repair-task",
    request: "change several modules",
    maxReviewRepairAttempts: 1,
    handlers: {
      execute: async () => {
        executions += 1;
        const changedFiles = executions === 1 ? ["src/a.ts", "src/b.ts", "src/c.ts"] : ["src/a.ts"];
        return { kind: "execution", source: "execute", result: { finalText: `run-${executions}`, messages: [], steps: 1, stopReason: "completed", taskState: "completed", verification: { required: false, writeObserved: false, status: "not_required", verificationPassed: false, verificationAttempts: 0, repairAttempts: 0, evidence: [] }, diff: diff(changedFiles) } as AgentResult, toolCallCount: 1, toolFailureCount: 0, repairAttempts: 0 };
      },
      review: async () => {
        reviews += 1;
        return { kind: "review", source: "reviewer", decision: reviews === 1 ? "needs_repair" : "pass", findings: reviews === 1 ? [{ severity: "major", title: "repair", evidence: "missing assertion" }] : [] };
      },
    },
  }).run();
  assert.equal(executions, 2);
  assert.equal(reviews, 2);
  assert.equal(result.context.review?.decision, "pass");
});

test("role protocols are independent and reject unstructured output", () => {
  assert.deepEqual(parseReviewProtocol(JSON.stringify({ decision: "pass", findings: [] })), { decision: "pass", findings: [] });
  assert.deepEqual(parseReflectionProtocol(JSON.stringify({ worthwhile: true, summary: "keep", reusableStrategies: ["run focused tests"] })), { worthwhile: true, summary: "keep", reusableStrategies: ["run focused tests"] });
  assert.throws(() => parseReviewProtocol("PASS"), RoleProtocolError);
  assert.throws(() => parseReflectionProtocol("useful"), RoleProtocolError);
});
