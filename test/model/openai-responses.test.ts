import assert from "node:assert/strict";
import test from "node:test";
import type { HttpRequest, HttpResponse, HttpTransport } from "../../src/model/transport.ts";
import { OpenAIResponsesModel, OpenAIResponsesResponseError } from "../../src/model/openai-responses.ts";

class FakeTransport implements HttpTransport {
  last?: HttpRequest;
  private readonly value: unknown;
  constructor(value: unknown) { this.value = value; }
  async request(request: HttpRequest): Promise<HttpResponse> { this.last = request; return { status: 200, statusText: "OK", headers: new Headers(), bodyText: JSON.stringify(this.value) }; }
  async requestJson<T>(request: HttpRequest): Promise<T> { await this.request(request); return this.value as T; }
  async *stream(request: HttpRequest): AsyncIterable<string> { this.last = request; yield String(this.value); }
}

test("serializes Responses input, tools, and function-call continuation", async () => {
  const transport = new FakeTransport({ id: "resp_1", status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "done" }] }], usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 } });
  const model = new OpenAIResponsesModel({ baseUrl: "https://gateway.example/v1", model: "model", apiKey: "key", transport });
  const result = await model.generate({ messages: [
    { role: "system", content: "Be careful" }, { role: "user", content: "Inspect" },
    { role: "assistant", content: "", toolCalls: [{ id: "call_1", name: "read_file", input: { path: "a.ts" } }] },
    { role: "tool", toolCallId: "call_1", toolName: "read_file", content: "source" },
  ], tools: [{ name: "read_file", description: "Read", inputSchema: { type: "object" } }] });
  assert.equal(transport.last?.url.toString(), "https://gateway.example/v1/responses");
  const body = JSON.parse(transport.last?.init?.body as string);
  assert.deepEqual(body.input[0], { role: "system", content: "Be careful" });
  assert.deepEqual(body.input.at(-1), { type: "function_call_output", call_id: "call_1", output: "source" });
  assert.deepEqual(body.tools, [{ type: "function", name: "read_file", description: "Read", parameters: { type: "object" } }]);
  assert.equal(result.message.content, "done"); assert.deepEqual(result.usage, { inputTokens: 3, outputTokens: 2, totalTokens: 5 });
});

test("parses Responses function calls and SSE deltas", async () => {
  const transport = new FakeTransport({ status: "completed", output: [{ type: "function_call", call_id: "call_1", name: "read_file", arguments: '{"path":"a.ts"}' }] });
  const model = new OpenAIResponsesModel({ baseUrl: "https://gateway.example/v1", model: "model", transport });
  const result = await model.generate({ messages: [{ role: "user", content: "read" }], tools: [] });
  assert.equal(result.finishReason, "tool_use"); assert.deepEqual(result.message.toolCalls, [{ id: "call_1", name: "read_file", input: { path: "a.ts" } }]);
  const streamTransport = new FakeTransport([
    'data: {"type":"response.output_item.added","output_index":0,"item":{"type":"function_call","call_id":"call_2","name":"read_file"}}',
    'data: {"type":"response.function_call_arguments.delta","output_index":0,"item_id":"call_2","delta":"{}"}',
    'data: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}',
  ].join("\n"));
  const streamModel = new OpenAIResponsesModel({ baseUrl: "https://gateway.example/v1", model: "model", transport: streamTransport });
  const events = []; for await (const event of streamModel.generateStream!({ messages: [{ role: "user", content: "read" }], tools: [] })) events.push(event);
  assert.equal(events[0]?.type, "tool_call_delta"); assert.equal(events.at(-1)?.type, "done"); assert.ok(events.some((event) => event.type === "usage"));
});

test("rejects malformed Responses output", async () => {
  const model = new OpenAIResponsesModel({ baseUrl: "https://gateway.example/v1", model: "model", transport: new FakeTransport({ output: [{ type: "function_call", call_id: "x", name: "f", arguments: "bad" }] }) });
  await assert.rejects(() => model.generate({ messages: [{ role: "user", content: "x" }], tools: [] }), OpenAIResponsesResponseError);
});
