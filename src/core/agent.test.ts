import assert from "node:assert/strict";
import test from "node:test";
import { Agent } from "./agent.ts";
import { ToolRegistry } from "./tool-registry.ts";
import type { Message, Model, ModelResponse, Tool } from "./types.ts";

test("returns a model answer when no tool call is requested", async () => {
  const model: Model = {
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
  const seen: readonly Message[][] = [];
  let calls = 0;
  const model: Model = {
    async generate(messages): Promise<ModelResponse> {
      (seen as Message[][]).push([...messages]);
      calls += 1;
      if (calls === 1) {
        return {
          message: { role: "assistant", content: "checking" },
          toolCalls: [{ id: "1", name: "add", input: { a: 2, b: 3 } }],
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
});

test("records tool failures so the model can recover", async () => {
  let calls = 0;
  const model: Model = {
    async generate(messages): Promise<ModelResponse> {
      calls += 1;
      if (calls === 1) {
        return {
          message: { role: "assistant", content: "attempt" },
          toolCalls: [{ id: "missing", name: "missing", input: null }],
        };
      }
      assert.match(messages.at(-1)?.content ?? "", /Unknown tool/);
      return { message: { role: "assistant", content: "recovered" } };
    },
  };
  const result = await new Agent(model).run("recover");
  assert.equal(result.finalText, "recovered");
});

test("stops after maxSteps", async () => {
  const model: Model = {
    async generate(): Promise<ModelResponse> {
      return {
        message: { role: "assistant", content: "work" },
        toolCalls: [{ id: "1", name: "noop", input: null }],
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
