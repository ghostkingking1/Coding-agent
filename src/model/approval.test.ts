import assert from "node:assert/strict";
import test from "node:test";
import { ApprovedModelClient, DefaultModelApprovalPolicy, ModelApprovalDeniedError } from "./approval.ts";
import type { ModelClient, ModelRequest, ModelResponse } from "../core/types.ts";

function createFakeModel(): { client: ModelClient; requests: ModelRequest[] } {
  const requests: ModelRequest[] = [];
  return {
    requests,
    client: {
      provider: "fake",
      model: "fake-model",
      capabilities: { toolCalling: true, streaming: false },
      async generate(request): Promise<ModelResponse> {
        requests.push(request);
        return { message: { role: "assistant", content: "done" } };
      },
    },
  };
}

test("default model approval policy denies network requests", async () => {
  const fake = createFakeModel();
  const model = new ApprovedModelClient(fake.client, { endpointOrigin: "https://models.example" });

  await assert.rejects(
    () => model.generate({ messages: [{ role: "user", content: "hello" }], tools: [] }),
    ModelApprovalDeniedError,
  );
  assert.equal(fake.requests.length, 0);
});

test("approved model requests expose a content-free summary before delegation", async () => {
  const fake = createFakeModel();
  const approvals: unknown[] = [];
  const model = new ApprovedModelClient(fake.client, {
    endpointOrigin: "https://models.example",
    approval: new DefaultModelApprovalPolicy((request) => {
      approvals.push(request);
      return true;
    }),
  });
  const controller = new AbortController();

  const result = await model.generate({
    messages: [
      { role: "system", content: "secret system prompt" },
      { role: "user", content: "secret user request" },
    ],
    tools: [
      { name: "read_file", description: "read", inputSchema: { type: "object" } },
      { name: "read_file", description: "read", inputSchema: { type: "object" } },
    ],
    signal: controller.signal,
  });

  assert.equal(result.message.content, "done");
  assert.equal(fake.requests.length, 1);
  assert.deepEqual(approvals, [{
    provider: "fake",
    model: "fake-model",
    endpointOrigin: "https://models.example",
    messageCount: 2,
    roles: ["system", "user"],
    toolNames: ["read_file"],
  }]);
  assert.doesNotMatch(JSON.stringify(approvals), /secret/);
});
