import assert from "node:assert/strict";
import test from "node:test";
import type { HttpRequest, HttpResponse, HttpTransport } from "../../src/model/transport.ts";
import { OpenAICompatibleModel, OpenAICompatibleResponseError } from "../../src/model/openai-compatible.ts";

class FakeTransport implements HttpTransport {
  lastRequest?: HttpRequest;
  private readonly response: unknown;

  constructor(response: unknown) {
    this.response = response;
  }

  async request(value: HttpRequest): Promise<HttpResponse> {
    this.lastRequest = value;
    return {
      status: 200,
      statusText: "OK",
      headers: new Headers(),
      bodyText: JSON.stringify(this.response),
    };
  }

  async requestJson<T>(value: HttpRequest): Promise<T> {
    await this.request(value);
    return this.response as T;
  }
}

test("serializes unified messages and tools into an OpenAI-compatible request", async () => {
  const transport = new FakeTransport({
    choices: [{
      finish_reason: "stop",
      message: { role: "assistant", content: "done" },
    }],
  });
  const model = new OpenAICompatibleModel({
    baseUrl: "https://gateway.example/v1",
    model: "free-model",
    apiKey: "test-key",
    transport,
    timeoutMs: 100,
    maxResponseBytes: 200,
  });
  const controller = new AbortController();

  const result = await model.generate({
    messages: [
      { role: "system", content: "Be careful." },
      { role: "user", content: "Inspect files." },
      {
        role: "assistant",
        content: "I will read it.",
        toolCalls: [{ id: "call_1", name: "read_file", input: { path: "src/app.ts" } }],
      },
      { role: "tool", toolCallId: "call_1", toolName: "read_file", content: "source" },
    ],
    tools: [{
      name: "read_file",
      description: "Read a source file.",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
        additionalProperties: false,
      },
    }],
    signal: controller.signal,
  });

  assert.equal(transport.lastRequest?.url.toString(), "https://gateway.example/v1/chat/completions");
  assert.equal(transport.lastRequest?.init?.method, "POST");
  assert.equal(transport.lastRequest?.init?.redirect, "error");
  assert.strictEqual(transport.lastRequest?.signal, controller.signal);
  const headers = new Headers(transport.lastRequest?.init?.headers);
  assert.equal(headers.get("content-type"), "application/json");
  assert.equal(headers.get("authorization"), "Bearer test-key");
  assert.equal(transport.lastRequest?.timeoutMs, 100);
  assert.equal(transport.lastRequest?.maxResponseBytes, 200);
  assert.deepEqual(JSON.parse(transport.lastRequest?.init?.body as string), {
    model: "free-model",
    messages: [
      { role: "system", content: "Be careful." },
      { role: "user", content: "Inspect files." },
      {
        role: "assistant",
        content: "I will read it.",
        tool_calls: [{
          id: "call_1",
          type: "function",
          function: { name: "read_file", arguments: '{"path":"src/app.ts"}' },
        }],
      },
      { role: "tool", tool_call_id: "call_1", content: "source" },
    ],
    tools: [{
      type: "function",
      function: {
        name: "read_file",
        description: "Read a source file.",
        parameters: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
          additionalProperties: false,
        },
      },
    }],
  });
  assert.equal(result.message.content, "done");
  assert.equal(result.finishReason, "stop");
});

test("parses multiple OpenAI-compatible tool calls into the unified response", async () => {
  const transport = new FakeTransport({
    choices: [{
      finish_reason: "tool_calls",
      message: {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "call_1", type: "function", function: { name: "read_file", arguments: '{"path":"a.ts"}' } },
          { id: "call_2", type: "function", function: { name: "run_tests", arguments: "{}" } },
        ],
      },
    }],
  });
  const model = new OpenAICompatibleModel({
    baseUrl: "https://gateway.example/v1/",
    model: "free-model",
    transport,
  });

  const result = await model.generate({ messages: [{ role: "user", content: "Fix it." }], tools: [] });

  assert.equal(result.message.content, "");
  assert.equal(result.finishReason, "tool_use");
  assert.deepEqual(result.message.toolCalls, [
    { id: "call_1", name: "read_file", input: { path: "a.ts" } },
    { id: "call_2", name: "run_tests", input: {} },
  ]);
  assert.deepEqual(JSON.parse(transport.lastRequest?.init?.body as string), {
    model: "free-model",
    messages: [{ role: "user", content: "Fix it." }],
  });
});

test("rejects malformed tool arguments without exposing their content", async () => {
  const transport = new FakeTransport({
    choices: [{
      message: {
        role: "assistant",
        content: "",
        tool_calls: [{
          id: "call_1",
          type: "function",
          function: { name: "read_file", arguments: "secret-not-json" },
        }],
      },
    }],
  });
  const model = new OpenAICompatibleModel({ baseUrl: "https://gateway.example/v1", model: "free-model", transport });

  await assert.rejects(
    () => model.generate({ messages: [{ role: "user", content: "Fix it." }], tools: [] }),
    (error: unknown) => {
      assert.ok(error instanceof OpenAICompatibleResponseError);
      assert.match(error.message, /arguments must contain valid JSON/);
      assert.doesNotMatch(error.message, /secret-not-json/);
      return true;
    },
  );
});

test("rejects malformed response structures and duplicate tool call IDs", async () => {
  const malformed = new OpenAICompatibleModel({
    baseUrl: "https://gateway.example/v1",
    model: "free-model",
    transport: new FakeTransport({ choices: [] }),
  });
  await assert.rejects(
    () => malformed.generate({ messages: [{ role: "user", content: "Fix it." }], tools: [] }),
    OpenAICompatibleResponseError,
  );

  const duplicate = new OpenAICompatibleModel({
    baseUrl: "https://gateway.example/v1",
    model: "free-model",
    transport: new FakeTransport({
      choices: [{
        message: {
          role: "assistant",
          content: "",
          tool_calls: [
            { id: "same", type: "function", function: { name: "one", arguments: "{}" } },
            { id: "same", type: "function", function: { name: "two", arguments: "{}" } },
          ],
        },
      }],
    }),
  });
  await assert.rejects(
    () => duplicate.generate({ messages: [{ role: "user", content: "Fix it." }], tools: [] }),
    OpenAICompatibleResponseError,
  );
});

test("rejects unsafe adapter configuration before it can make a request", () => {
  assert.throws(
    () => new OpenAICompatibleModel({ baseUrl: "https://gateway.example/v1?api_key=secret", model: "free-model" }),
    /baseUrl must not include a query string or fragment/,
  );
  assert.throws(
    () => new OpenAICompatibleModel({ baseUrl: "file:///tmp/models", model: "free-model" }),
    /baseUrl must use http or https/,
  );
  assert.throws(
    () => new OpenAICompatibleModel({ baseUrl: "https://user:secret@gateway.example/v1", model: "free-model" }),
    /baseUrl must not include credentials/,
  );
  assert.throws(
    () => new OpenAICompatibleModel({ baseUrl: "https://gateway.example/v1", model: "free-model", apiKey: "bad\nkey" }),
    /apiKey must be a non-empty single-line string/,
  );
  assert.throws(
    () => new OpenAICompatibleModel({ baseUrl: "https://gateway.example/v1", model: "" }),
    /model must be a non-empty string/,
  );
});

test("rejects non-JSON tool call history before making a provider request", async () => {
  const transport = new FakeTransport({ choices: [{ message: { role: "assistant", content: "done" } }] });
  const model = new OpenAICompatibleModel({ baseUrl: "https://gateway.example/v1", model: "free-model", transport });

  await assert.rejects(
    () => model.generate({
      messages: [{
        role: "assistant",
        content: "",
        toolCalls: [{ id: "call_1", name: "read_file", input: undefined }],
      }],
      tools: [],
    }),
    /Tool call input must be JSON-serializable/,
  );
  assert.equal(transport.lastRequest, undefined);
});
