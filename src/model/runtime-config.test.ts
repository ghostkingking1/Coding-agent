import assert from "node:assert/strict";
import test from "node:test";
import { DefaultModelApprovalPolicy, ModelApprovalDeniedError } from "./approval.ts";
import { createConfiguredModelClient, readModelRuntimeConfig } from "./runtime-config.ts";
import type { HttpRequest, HttpResponse, HttpTransport } from "./transport.ts";

class FakeTransport implements HttpTransport {
  requests: HttpRequest[] = [];

  async request(request: HttpRequest): Promise<HttpResponse> {
    this.requests.push(request);
    return { status: 200, statusText: "OK", headers: new Headers(), bodyText: "{}" };
  }

  async requestJson<T>(request: HttpRequest): Promise<T> {
    await this.request(request);
    return { choices: [{ message: { role: "assistant", content: "done" } }] } as T;
  }
}

test("leaves the CLI Echo mode available when no model configuration is present", () => {
  assert.equal(readModelRuntimeConfig({}), undefined);
});

test("requires complete explicit model configuration", () => {
  assert.throws(
    () => readModelRuntimeConfig({ CODING_AGENT_MODEL_PROVIDER: "openai-compatible" }),
    /CODING_AGENT_MODEL_BASE_URL must be set/,
  );
  assert.throws(
    () => readModelRuntimeConfig({
      CODING_AGENT_MODEL_PROVIDER: "anthropic",
      CODING_AGENT_MODEL_BASE_URL: "https://models.example/v1",
      CODING_AGENT_MODEL: "free-model",
    }),
    /CODING_AGENT_MODEL_PROVIDER must be openai-compatible/,
  );
  assert.throws(
    () => readModelRuntimeConfig({
      CODING_AGENT_MODEL_PROVIDER: "openai-compatible",
      CODING_AGENT_MODEL_BASE_URL: "https://models.example/v1",
      CODING_AGENT_MODEL: "free-model",
      CODING_AGENT_MODEL_TIMEOUT_MS: "0",
    }),
    /CODING_AGENT_MODEL_TIMEOUT_MS must be a positive integer/,
  );
});

test("creates an approved OpenAI-compatible runtime from explicit configuration", async () => {
  const config = readModelRuntimeConfig({
    CODING_AGENT_MODEL_PROVIDER: "openai-compatible",
    CODING_AGENT_MODEL_BASE_URL: "https://models.example/v1",
    CODING_AGENT_MODEL: "free-model",
    CODING_AGENT_MODEL_TIMEOUT_MS: "25",
    CODING_AGENT_MODEL_MAX_RESPONSE_BYTES: "1000",
  });
  if (!config) throw new Error("Expected model configuration");
  const transport = new FakeTransport();
  const model = createConfiguredModelClient(config, { transport });

  await assert.rejects(
    () => model.generate({ messages: [{ role: "user", content: "hello" }], tools: [] }),
    ModelApprovalDeniedError,
  );
  assert.equal(transport.requests.length, 0);

  const approved = createConfiguredModelClient(config, {
    transport,
    approval: new DefaultModelApprovalPolicy(() => true),
  });
  const result = await approved.generate({ messages: [{ role: "user", content: "hello" }], tools: [] });
  assert.equal(result.message.content, "done");
  assert.equal(transport.requests.length, 1);
  assert.equal(transport.requests[0]?.url.toString(), "https://models.example/v1/chat/completions");
  assert.equal(transport.requests[0]?.timeoutMs, 25);
  assert.equal(transport.requests[0]?.maxResponseBytes, 1000);
});
