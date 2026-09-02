import assert from "node:assert/strict";
import test from "node:test";
import { Agent } from "../../src/agent/agent.ts";
import { Session } from "../../src/agent/session.ts";
import type { Message, ModelClient, ModelResponse } from "../../src/agent/types.ts";

const capabilities = { toolCalling: false, streaming: false } as const;

test("keeps one session context across multiple runs and assigns stable ids", async () => {
  const requests: Message[][] = [];
  const model: ModelClient = {
    provider: "fake",
    model: "fake-model",
    capabilities,
    async generate(request): Promise<ModelResponse> {
      requests.push([...request.messages]);
      return { message: { role: "assistant", content: `answer-${requests.length}` } };
    },
  };
  const session = new Session(new Agent(model, undefined, { systemPrompt: "Be concise", includeRunDiff: false }), { sessionId: "session-test" });

  const first = await session.run("first");
  const second = await session.run("second");

  assert.equal(first.sessionId, "session-test");
  assert.match(first.runId, /^run_[A-Za-z0-9-]+$/);
  assert.notEqual(first.runId, second.runId);
  assert.deepEqual(requests[0].map((message) => message.role), ["system", "user"]);
  assert.deepEqual(requests[1].map((message) => message.role), ["system", "user", "assistant", "user"]);
  assert.deepEqual(session.messages, second.messages);
  assert.equal(session.runs.length, 2);
});

test("records failed runs without committing their partial context", async () => {
  let calls = 0;
  const model: ModelClient = {
    provider: "fake",
    model: "fake-model",
    capabilities,
    async generate(): Promise<ModelResponse> {
      calls += 1;
      if (calls === 1) throw new Error("model unavailable");
      return { message: { role: "assistant", content: "recovered" } };
    },
  };
  const session = new Session(new Agent(model, undefined, { includeRunDiff: false }));

  await assert.rejects(() => session.run("retry"), /model unavailable/);
  assert.deepEqual(session.messages, []);
  assert.equal(session.runs[0]?.status, "failed");
  assert.equal((session.runs[0] as { error: string }).error, "model unavailable");
  await session.run("retry");
  assert.equal(session.runs.length, 2);
});

test("enforces session lifecycle and rejects overlapping runs", async () => {
  let release: (() => void) | undefined;
  const model: ModelClient = {
    provider: "fake",
    model: "fake-model",
    capabilities,
    async generate(): Promise<ModelResponse> {
      await new Promise<void>((resolve) => { release = resolve; });
      return { message: { role: "assistant", content: "done" } };
    },
  };
  const session = new Session(new Agent(model, undefined, { includeRunDiff: false }));
  const pending = session.run("long");
  await new Promise<void>((resolve) => setImmediate(resolve));
  await assert.rejects(() => session.run("overlap"), /already has a run/);
  assert.throws(() => session.close(), /run is in progress/);
  release?.();
  await pending;
  const closed = session.close();
  assert.equal(closed.status, "closed");
  await assert.rejects(() => session.run("after close"), /Session is closed/);
  assert.throws(() => new Session(new Agent(model), { sessionId: "bad id" }), /sessionId/);
});
