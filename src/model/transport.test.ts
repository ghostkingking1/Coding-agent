import assert from "node:assert/strict";
import test from "node:test";
import { ModelTransportError } from "./errors.ts";
import { FetchHttpTransport, type FetchLike } from "./transport.ts";

test("returns bounded successful responses and preserves request metadata", async () => {
  let seenSignal: AbortSignal | null | undefined;
  const transport = new FetchHttpTransport({
    fetch: async (_url, init) => {
      seenSignal = init?.signal;
      return new Response('{"answer":42}', {
        status: 200,
        headers: { "x-request-id": "req_123", "content-type": "application/json" },
      });
    },
  });

  const response = await transport.request({
    url: "https://example.invalid/models",
    init: { method: "POST", signal: AbortSignal.abort() },
  });

  assert.equal(response.status, 200);
  assert.equal(response.bodyText, '{"answer":42}');
  assert.equal(response.requestId, "req_123");
  assert.ok(seenSignal instanceof AbortSignal);
  assert.equal(seenSignal?.aborted, false);
});

test("parses successful JSON responses", async () => {
  const transport = new FetchHttpTransport({ fetch: async () => new Response('{"answer":42}') });

  const result = await transport.requestJson<{ answer: number }>({ url: "https://example.invalid/models" });

  assert.deepEqual(result, { answer: 42 });
});

test("rejects invalid JSON without exposing response content", async () => {
  const transport = new FetchHttpTransport({ fetch: async () => new Response("not-secret-json") });

  await assert.rejects(
    () => transport.requestJson({ url: "https://example.invalid/models" }),
    (error: unknown) => {
      assertTransportError(error, "invalid_json");
      assert.doesNotMatch(error.message, /not-secret-json/);
      return true;
    },
  );
});

test("classifies provider HTTP failures and exposes only safe metadata", async () => {
  const cases: ReadonlyArray<readonly [number, string]> = [
    [401, "unauthorized"],
    [403, "forbidden"],
    [429, "rate_limited"],
    [500, "server_error"],
    [418, "http_error"],
  ];

  for (const [status, code] of cases) {
    const transport = new FetchHttpTransport({
      fetch: async () => new Response("service-secret", {
        status,
        headers: { "x-request-id": "req_failure", "retry-after": "3" },
      }),
    });
    await assert.rejects(
      () => transport.request({ url: "https://example.invalid/models" }),
      (error: unknown) => {
        assertTransportError(error, code);
        assert.equal(error.status, status);
        assert.equal(error.requestId, "req_failure");
        assert.doesNotMatch(error.message, /service-secret/);
        if (status === 429) assert.equal(error.retryAfterMs, 3000);
        return true;
      },
    );
  }
});

test("rejects response bodies above the configured limit", async () => {
  const transport = new FetchHttpTransport({ fetch: async () => new Response("12345") });

  await assert.rejects(
    () => transport.request({ url: "https://example.invalid/models", maxResponseBytes: 4 }),
    (error: unknown) => {
      assertTransportError(error, "response_too_large");
      return true;
    },
  );
});

test("rejects oversized declared content before consuming the response stream", async () => {
  const transport = new FetchHttpTransport({
    fetch: async () => new Response("12345", { headers: { "content-length": "5" } }),
  });

  await assert.rejects(
    () => transport.request({ url: "https://example.invalid/models", maxResponseBytes: 4 }),
    (error: unknown) => {
      assertTransportError(error, "response_too_large");
      return true;
    },
  );
});

test("maps a caller cancellation to an aborted transport error", async () => {
  const controller = new AbortController();
  const transport = new FetchHttpTransport({ fetch: rejectWhenAborted });
  const pending = transport.request({ url: "https://example.invalid/models", signal: controller.signal });

  controller.abort(new Error("caller stopped"));

  await assert.rejects(pending, (error: unknown) => {
    assertTransportError(error, "aborted");
    return true;
  });
});

test("maps transport timeouts to a timeout error", async () => {
  const transport = new FetchHttpTransport({ fetch: rejectWhenAborted });

  await assert.rejects(
    () => transport.request({ url: "https://example.invalid/models", timeoutMs: 10 }),
    (error: unknown) => {
      assertTransportError(error, "timeout");
      return true;
    },
  );
});

test("does not leak a network failure message", async () => {
  const transport = new FetchHttpTransport({
    fetch: async () => {
      throw new Error("Bearer top-secret-token");
    },
  });

  await assert.rejects(
    () => transport.request({ url: "https://example.invalid/models" }),
    (error: unknown) => {
      assertTransportError(error, "network");
      assert.doesNotMatch(error.message, /top-secret-token/);
      assert.equal(error.cause, undefined);
      return true;
    },
  );
});

const rejectWhenAborted: FetchLike = async (_url, init) => new Promise<Response>((_resolve, reject) => {
  init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
});

function assertTransportError(error: unknown, code: string): asserts error is ModelTransportError {
  assert.ok(error instanceof ModelTransportError);
  assert.equal(error.code, code);
}
