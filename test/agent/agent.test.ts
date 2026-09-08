import assert from "node:assert/strict";
import test from "node:test";
import { Agent } from "../../src/agent/agent.ts";
import { DefaultContextManager } from "../../src/agent/context-manager.ts";
import { ToolRegistry } from "../../src/tools/tool-registry.ts";
import type { Message, ModelClient, ModelRequest, ModelResponse, Tool } from "../../src/agent/types.ts";
import { ModelTransportError } from "../../src/model/errors.ts";

const fakeCapabilities = { toolCalling: true, streaming: false } as const;

test("returns a model answer when no tool call is requested", async () => {
  const model: ModelClient = {
    provider: "fake",
    model: "fake-model",
    capabilities: fakeCapabilities,
    async generate(): Promise<ModelResponse> {
      return { message: { role: "assistant", content: "done" } };
    },
  };

  const result = await new Agent(model).run("hello");
  assert.equal(result.finalText, "done");
  assert.equal(result.steps, 1);
  assert.equal(result.stopReason, "completed");
  assert.deepEqual(result.messages.map((message) => message.role), ["user", "assistant"]);
});

test("executes tool calls and feeds their results back to the model", async () => {
  const seen: Message[][] = [];
  let calls = 0;
  const model: ModelClient = {
    provider: "fake",
    model: "fake-model",
    capabilities: fakeCapabilities,
    async generate(request): Promise<ModelResponse> {
      seen.push([...request.messages]);
      calls += 1;
      if (calls === 1) {
        return {
          message: {
            role: "assistant",
            content: "checking",
            toolCalls: [{ id: "1", name: "add", input: { a: 2, b: 3 } }],
          },
          finishReason: "tool_use",
        };
      }
      return { message: { role: "assistant", content: "5" } };
    },
  };
  const add: Tool = {
    name: "add",
    description: "Adds two numbers",
    execute(input) {
      const value = input as { a: number; b: number };
      return value.a + value.b;
    },
  };
  const registry = new ToolRegistry().register(add);

  const result = await new Agent(model, registry).run("calculate");
  assert.equal(result.finalText, "5");
  assert.equal(result.steps, 2);
  assert.equal(seen[1].at(-1)?.content, "5");
  assert.equal(result.messages.find((message) => message.role === "tool")?.content, "5");
  assert.deepEqual(
    result.messages.find((message) => message.role === "assistant")?.toolCalls,
    [{ id: "1", name: "add", input: { a: 2, b: 3 } }],
  );
  assert.deepEqual(
    seen[1].find((message) => message.role === "assistant")?.toolCalls,
    [{ id: "1", name: "add", input: { a: 2, b: 3 } }],
  );
});

test("records tool failures so the model can recover", async () => {
  let calls = 0;
  const model: ModelClient = {
    provider: "fake",
    model: "fake-model",
    capabilities: fakeCapabilities,
    async generate(request): Promise<ModelResponse> {
      calls += 1;
      if (calls === 1) {
        return {
          message: {
            role: "assistant",
            content: "attempt",
            toolCalls: [{ id: "missing", name: "missing", input: null }],
          },
        };
      }
      assert.match(request.messages.at(-1)?.content ?? "", /Unknown tool/);
      return { message: { role: "assistant", content: "recovered" } };
    },
  };
  const result = await new Agent(model).run("recover");
  assert.equal(result.finalText, "recovered");
});

test("stops after maxSteps", async () => {
  const model: ModelClient = {
    provider: "fake",
    model: "fake-model",
    capabilities: fakeCapabilities,
    async generate(): Promise<ModelResponse> {
      return {
        message: {
          role: "assistant",
          content: "work",
          toolCalls: [{ id: "1", name: "noop", input: null }],
        },
      };
    },
  };
  const registry = new ToolRegistry().register({
    name: "noop",
    description: "Does nothing",
    execute: () => "ok",
  });
  const result = await new Agent(model, registry, { maxSteps: 2 }).run("loop");
  assert.equal(result.steps, 2);
  assert.equal(result.stopReason, "max_steps");
  assert.equal(result.finalText, "");
});

test("passes declared model tools and the cancellation signal to the model", async () => {
  const controller = new AbortController();
  let request: ModelRequest | undefined;
  const model: ModelClient = {
    provider: "fake",
    model: "fake-model",
    capabilities: fakeCapabilities,
    async generate(value): Promise<ModelResponse> {
      request = value;
      return { message: { role: "assistant", content: "done" } };
    },
  };
  const registry = new ToolRegistry()
    .register({
      name: "visible",
      description: "Visible tool",
      manifest: {
        capabilities: ["read"],
        modelInputSchema: { type: "object", additionalProperties: false },
      },
      execute: () => "ok",
    })
    .register({
      name: "hidden",
      description: "Hidden tool",
      manifest: { capabilities: ["read"] },
      execute: () => "ok",
    });

  await new Agent(model, registry, { signal: controller.signal }).run("hello");

  assert.strictEqual(request?.signal, controller.signal);
  assert.deepEqual(request?.tools, [{
    name: "visible",
    description: "Visible tool",
    inputSchema: { type: "object", additionalProperties: false },
  }]);
});

test("feeds provider input usage back into context estimation", async () => {
  const contextManager = new DefaultContextManager();
  const model: ModelClient = {
    provider: "fake",
    model: "fake-model",
    capabilities: fakeCapabilities,
    async generate(request): Promise<ModelResponse> {
      const raw = request.contextResult!.rawEstimatedTokens;
      return {
        message: { role: "assistant", content: "done" },
        usage: { inputTokens: raw * 2, outputTokens: 1, totalTokens: raw * 2 + 1 },
      };
    },
  };
  const before = contextManager.estimate([{ role: "user", content: "hello" }]);
  await new Agent(model, undefined, { contextManager }).run("hello");
  assert.ok(contextManager.estimate([{ role: "user", content: "hello" }]) > before);
});

test("uses a 75 percent proactive threshold with the default context budget", async () => {
  let budget: number | undefined;
  let threshold: number | undefined;
  const model: ModelClient = {
    provider: "fake",
    model: "fake-model",
    capabilities: fakeCapabilities,
    async generate(request): Promise<ModelResponse> {
      budget = request.contextResult?.budget;
      threshold = request.contextResult?.compactionThreshold;
      return { message: { role: "assistant", content: "done" } };
    },
  };
  await new Agent(model, undefined, { includeRunDiff: false }).run("hello");
  assert.equal(budget, 32_000);
  assert.equal(threshold, 24_000);
});

test("retries rate limited model requests and emits streamed text", async () => {
  let attempts = 0;
  const events: string[] = [];
  const model: ModelClient = { provider: "fake", model: "fake", capabilities: { toolCalling: true, streaming: true }, async generate() { throw new Error("fallback should not run"); }, async *generateStream() {
    attempts += 1;
    if (attempts === 1) throw new ModelTransportError("rate_limited", "limited", { retryAfterMs: 1 });
    yield { type: "text_delta", text: "done" } as const;
    yield { type: "done", finishReason: "stop" } as const;
  } };
  const result = await new Agent(model, undefined, { includeRunDiff: false, retry: { sleep: async () => undefined }, onEvent: (event) => { events.push(event.type); } }).run("hello");
  assert.equal(result.finalText, "done");
  assert.equal(attempts, 2);
  assert.ok(events.includes("model_retry"));
  assert.ok(events.includes("model_delta"));
});

test("exposes a paged artifact reader after a tool returns oversized output", async () => {
  let calls = 0;
  const model: ModelClient = {
    provider: "fake", model: "fake-model", capabilities: fakeCapabilities,
    async generate(request): Promise<ModelResponse> {
      calls += 1;
      if (calls === 1) return { message: { role: "assistant", content: "", toolCalls: [{ id: "large", name: "large", input: {} }] } };
      assert.ok(request.messages.some((message) => message.role === "tool" && message.content.includes("artifactId=out_")));
      assert.ok(request.tools.some((tool) => tool.name === "read_tool_output"));
      return { message: { role: "assistant", content: "done" } };
    },
  };
  const registry = new ToolRegistry().register({ name: "large", description: "large", execute: () => "x".repeat(5_000) });
  const result = await new Agent(model, registry, { includeRunDiff: false }).run("inspect", { sessionId: "artifact-session", runId: "artifact-run" });
  assert.equal(result.finalText, "done");
});

test("reuses checkpointed tool results instead of executing the tool twice", async () => {
  let executions = 0;
  const checkpoints: import("../../src/agent/types.ts").CheckpointRecord[] = [];
  const tool = { name: "read", description: "read", manifest: { capabilities: ["read"] as const, modelInputSchema: { type: "object" } }, async execute() { executions += 1; return "cached result"; } };
  const model: ModelClient = { provider: "fake", model: "fake", capabilities: fakeCapabilities, async generate(request) {
    if (request.messages.some((message) => message.role === "tool")) return { message: { role: "assistant", content: "done" } };
    return { message: { role: "assistant", content: "", toolCalls: [{ id: "call-1", name: "read", input: {} }] } };
  } };
  const first = await new Agent(model, new ToolRegistry().register(tool), { includeRunDiff: false }).run("inspect", { sessionId: "s", runId: "r", checkpoint: { save: async (checkpoint) => { checkpoints.push(checkpoint); } } });
  assert.equal(first.finalText, "done");
  const second = await new Agent(model, new ToolRegistry().register(tool), { includeRunDiff: false }).run("inspect", { sessionId: "s", runId: "r", replayToolResults: new Map([["r:1:call-1", "cached result"]]) });
  assert.equal(second.finalText, "done");
  assert.equal(executions, 1);
  assert.ok(checkpoints.some((checkpoint) => checkpoint.phase === "tool"));
});

test("executes parallelizable tool calls concurrently and returns declared order", async () => {
  let active = 0;
  let peak = 0;
  let responses = 0;
  const model: ModelClient = {
    provider: "fake", model: "fake", capabilities: fakeCapabilities,
    async generate(request): Promise<ModelResponse> {
      responses += 1;
      if (responses === 1) return { message: { role: "assistant", content: "", toolCalls: [{ id: "a", name: "read", input: { value: "a" } }, { id: "b", name: "read", input: { value: "b" } }] } };
      assert.deepEqual(request.messages.slice(-2).map((message) => message.content), ["a", "b"]);
      return { message: { role: "assistant", content: "done" } };
    },
  };
  const read = { name: "read", description: "read", manifest: { capabilities: ["read"] as const, parallelizable: true }, async execute(input: unknown) { active += 1; peak = Math.max(peak, active); await new Promise((resolve) => setTimeout(resolve, 30)); active -= 1; return (input as { value: string }).value; } };
  const result = await new Agent(model, new ToolRegistry().register(read), { includeRunDiff: false }).run("inspect");
  assert.equal(result.finalText, "done");
  assert.equal(peak, 2);
});

test("keeps undeclared tools serial and isolates a failed call", async () => {
  let active = 0;
  let peak = 0;
  let responses = 0;
  const model: ModelClient = { provider: "fake", model: "fake", capabilities: fakeCapabilities, async generate(request): Promise<ModelResponse> {
    responses += 1;
    if (responses === 1) return { message: { role: "assistant", content: "", toolCalls: [{ id: "bad", name: "bad", input: null }, { id: "ok", name: "ok", input: null }] } };
    assert.match(request.messages.find((message) => message.role === "tool" && message.toolCallId === "bad")?.content ?? "", /boom/);
    assert.equal(request.messages.find((message) => message.role === "tool" && message.toolCallId === "ok")?.content, "ok");
    return { message: { role: "assistant", content: "done" } };
  } };
  const registry = new ToolRegistry().register({ name: "bad", description: "bad", execute: () => { throw new Error("boom"); } }).register({ name: "ok", description: "ok", execute: async () => { active += 1; peak = Math.max(peak, active); await new Promise((resolve) => setTimeout(resolve, 10)); active -= 1; return "ok"; } });
  await new Agent(model, registry, { includeRunDiff: false }).run("inspect");
  assert.equal(peak, 1);
});

test("enforces the concurrency limit and conflict keys", async () => {
  let active = 0;
  let peak = 0;
  let responses = 0;
  const model: ModelClient = { provider: "fake", model: "fake", capabilities: fakeCapabilities, async generate(request): Promise<ModelResponse> {
    responses += 1;
    if (responses === 1) return { message: { role: "assistant", content: "", toolCalls: [
      { id: "1", name: "read", input: { key: "same" } }, { id: "2", name: "read", input: { key: "same" } }, { id: "3", name: "read", input: { key: "other" } },
    ] } };
    return { message: { role: "assistant", content: "done" } };
  } };
  const read = { name: "read", description: "read", manifest: { capabilities: ["read"] as const, parallelizable: true, conflictKey: (input: unknown) => (input as { key: string }).key }, async execute() { active += 1; peak = Math.max(peak, active); await new Promise((resolve) => setTimeout(resolve, 15)); active -= 1; return "ok"; } };
  await new Agent(model, new ToolRegistry().register(read), { includeRunDiff: false, maxConcurrentToolCalls: 2 }).run("inspect");
  assert.equal(peak, 2);
});

test("emits batch lifecycle events and checkpoints after the complete batch", async () => {
  const events: string[] = [];
  let responses = 0;
  const checkpoints: import("../../src/agent/types.ts").CheckpointRecord[] = [];
  const model: ModelClient = { provider: "fake", model: "fake", capabilities: fakeCapabilities, async generate(): Promise<ModelResponse> {
    responses += 1;
    return responses === 1 ? { message: { role: "assistant", content: "", toolCalls: [{ id: "a", name: "a", input: null }, { id: "b", name: "b", input: null }] } } : { message: { role: "assistant", content: "done" } };
  } };
  const registry = new ToolRegistry().register({ name: "a", description: "a", manifest: { capabilities: ["read"] as const, parallelizable: true }, execute: () => "a" }).register({ name: "b", description: "b", manifest: { capabilities: ["read"] as const, parallelizable: true }, execute: () => "b" });
  await new Agent(model, registry, { includeRunDiff: false, onEvent: (event) => { events.push(event.type); } }).run("inspect", { sessionId: "s", runId: "r", checkpoint: { save: async (checkpoint) => { checkpoints.push(checkpoint); } } });
  assert.deepEqual(events.filter((event) => event.startsWith("tool_batch")), ["tool_batch_started", "tool_batch_finished"]);
  assert.equal(checkpoints.filter((checkpoint) => checkpoint.phase === "tool").length, 1);
  assert.deepEqual(checkpoints.find((checkpoint) => checkpoint.phase === "tool")?.toolResults.map((result) => result.toolCallId), ["a", "b"]);
});
