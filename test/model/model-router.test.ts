import assert from "node:assert/strict";
import test from "node:test";
import { ModelRouter, type ModelRouteDecision } from "../../src/model/model-router.ts";
import type { ModelClient, ModelRequest, ModelResponse } from "../../src/agent/types.ts";

function client(model: string, calls: string[]): ModelClient {
  return {
    provider: "fake",
    model,
    capabilities: { toolCalling: true, streaming: true },
    async generate(): Promise<ModelResponse> { calls.push(model); return { message: { role: "assistant", content: model } }; },
    async *generateStream() { calls.push(model); yield { type: "text_delta" as const, text: model }; yield { type: "done" as const }; },
  };
}

function request(content: string, extra: Partial<ModelRequest> = {}): ModelRequest {
  return { messages: [{ role: "user", content }], tools: [], ...extra };
}

test("router sends a short low-risk request to the simple model", async () => {
  const calls: string[] = [];
  const decisions: ModelRouteDecision[] = [];
  const router = new ModelRouter({ simple: client("fast", calls), complex: client("strong", calls), onDecision: (decision) => { decisions.push(decision); } });
  const result = await router.generate(request("read package.json"));
  assert.equal(result.message.content, "fast");
  assert.deepEqual(calls, ["fast"]);
  assert.equal(decisions[0]?.route, "simple");
  assert.deepEqual(decisions[0]?.reasons, []);
});

test("router escalates explicit high-risk work combined with observed tool failure", async () => {
  const calls: string[] = [];
  const router = new ModelRouter({ simple: client("fast", calls), complex: client("strong", calls) });
  const routed = request("修复并发安全漏洞", { messages: [
    { role: "user", content: "修复并发安全漏洞" },
    { role: "assistant", content: "checking", toolCalls: [{ id: "one", name: "run_tests", input: {} }] },
    { role: "tool", content: JSON.stringify({ error: "failed" }), toolCallId: "one", toolName: "run_tests" },
  ] });
  const decision = router.decide(routed);
  assert.equal(decision.route, "complex");
  assert.ok(decision.reasons.includes("explicit_high_risk_scope"));
  assert.ok(decision.reasons.includes("observed_tool_failures"));
  await router.generate(routed);
  assert.deepEqual(calls, ["strong"]);
});

test("router uses actual context occupancy instead of predicted change size", () => {
  const router = new ModelRouter({ simple: client("fast", []), complex: client("strong", []) });
  const decision = router.decide(request("continue", {
    contextResult: {
      messages: [{ role: "user", content: "continue" }], estimatedTokens: 7_500, rawEstimatedTokens: 7_500, calibrationFactor: 1,
      budget: 10_000, compactionThreshold: 7_500, compacted: false, stages: [], summaries: [],
    },
  }));
  assert.equal(decision.route, "complex");
  assert.equal(decision.signals.budgetRatio, 0.75);
  assert.deepEqual(decision.reasons, ["context_budget_70_percent"]);
});

test("streaming uses the same observable routing decision", async () => {
  const calls: string[] = [];
  const router = new ModelRouter({ simple: client("fast", calls), complex: client("strong", calls), complexThreshold: 2 });
  const events = [];
  for await (const event of router.generateStream(request("security review"))) events.push(event);
  assert.deepEqual(calls, ["strong"]);
  assert.equal(events[0]?.type, "text_delta");
});

test("router records a content-free route decision in the run audit sink", async () => {
  const events: import("../../src/agent/types.ts").AuditEvent[] = [];
  const router = new ModelRouter({ simple: client("fast", []), complex: client("strong", []) });
  await router.generate({
    ...request("private request body"),
    routingAudit: { sink: { record: async (event) => { events.push(event); } }, sessionId: "session-one", runId: "run-one" },
  });
  assert.equal(events[0]?.eventType, "model_route_decided");
  assert.equal(events[0]?.metadata?.model, "fast");
  assert.equal(JSON.stringify(events).includes("private request body"), false);
});
