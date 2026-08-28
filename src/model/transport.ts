import { ModelTransportError, type ModelTransportErrorCode } from "./errors.ts";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024;

/** 可注入的 fetch 形状，让 provider 单元测试不需要真实网络。 */
export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

/** 一次供应商无关的 HTTP 请求。 */
export interface HttpRequest {
  readonly url: string | URL;
  readonly init?: RequestInit;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
}

/** 已读取且受大小限制的 HTTP 响应。 */
export interface HttpResponse {
  readonly status: number;
  readonly statusText: string;
  readonly headers: Headers;
  readonly bodyText: string;
  readonly requestId?: string;
}

/** provider adapter 依赖的最小 HTTP 抽象。 */
export interface HttpTransport {
  request(request: HttpRequest): Promise<HttpResponse>;
  requestJson<T = unknown>(request: HttpRequest): Promise<T>;
}

/** Fetch transport 的默认限制与可替换 fetch。 */
export interface FetchHttpTransportOptions {
  readonly fetch?: FetchLike;
  readonly defaultTimeoutMs?: number;
  readonly defaultMaxResponseBytes?: number;
}

/**
 * 用 fetch 实现的受限 HTTP transport。
 * 不理解任何供应商协议，只负责把通信失败归一化并限制不可信响应的资源消耗。
 */
export class FetchHttpTransport implements HttpTransport {
  private readonly fetch: FetchLike;
  private readonly defaultTimeoutMs: number;
  private readonly defaultMaxResponseBytes: number;

  constructor(options: FetchHttpTransportOptions = {}) {
    this.fetch = options.fetch ?? globalThis.fetch;
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.defaultMaxResponseBytes = options.defaultMaxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    assertPositiveInteger(this.defaultTimeoutMs, "defaultTimeoutMs");
    assertPositiveInteger(this.defaultMaxResponseBytes, "defaultMaxResponseBytes");
  }

  async request(request: HttpRequest): Promise<HttpResponse> {
    const timeoutMs = request.timeoutMs ?? this.defaultTimeoutMs;
    const maxResponseBytes = request.maxResponseBytes ?? this.defaultMaxResponseBytes;
    assertPositiveInteger(timeoutMs, "timeoutMs");
    assertPositiveInteger(maxResponseBytes, "maxResponseBytes");
    if (request.signal?.aborted) throw abortedError();

    const controller = new AbortController();
    let timedOut = false;
    const abort = () => controller.abort(request.signal?.reason);
    request.signal?.addEventListener("abort", abort, { once: true });
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);

    try {
      /** 强制覆盖 init.signal，避免调用方传入的另一信号绕过统一超时和取消处理。 */
      const response = await this.fetch(request.url, { ...request.init, signal: controller.signal });
      const requestId = findRequestId(response.headers);
      if (!response.ok) {
        await discardBody(response);
        throw httpError(response.status, response.headers, requestId);
      }
      return {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
        bodyText: await readBody(response, maxResponseBytes, requestId),
        requestId,
      };
    } catch (error) {
      if (error instanceof ModelTransportError) throw error;
      if (timedOut) throw timeoutError();
      if (request.signal?.aborted) throw abortedError();
      /** fetch 与响应流异常的原始 message 可能包含请求地址或凭据，不能向上泄漏。 */
      throw new ModelTransportError("network", "Model request failed before a response was received");
    } finally {
      clearTimeout(timeout);
      request.signal?.removeEventListener("abort", abort);
    }
  }

  async requestJson<T = unknown>(request: HttpRequest): Promise<T> {
    const response = await this.request(request);
    try {
      return JSON.parse(response.bodyText) as T;
    } catch {
      throw new ModelTransportError("invalid_json", "Model response is not valid JSON", {
        requestId: response.requestId,
      });
    }
  }
}

async function readBody(response: Response, maxBytes: number, requestId?: string): Promise<string> {
  const contentLength = response.headers.get("content-length");
  if (contentLength && Number(contentLength) > maxBytes) {
    await discardBody(response);
    throw responseTooLargeError(requestId);
  }
  if (!response.body) return "";

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel();
        throw responseTooLargeError(requestId);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return new TextDecoder().decode(concatBytes(chunks, bytes));
}

function concatBytes(chunks: readonly Uint8Array[], length: number): Uint8Array {
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

async function discardBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // 错误响应正文不参与诊断，取消失败也不能覆盖原有 HTTP 错误。
  }
}

function httpError(status: number, headers: Headers, requestId?: string): ModelTransportError {
  const code = httpErrorCode(status);
  return new ModelTransportError(code, `Model request failed with HTTP status ${status}`, {
    status,
    retryAfterMs: code === "rate_limited" ? parseRetryAfter(headers.get("retry-after")) : undefined,
    requestId,
  });
}

function httpErrorCode(status: number): ModelTransportErrorCode {
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 429) return "rate_limited";
  if (status >= 500 && status <= 599) return "server_error";
  return "http_error";
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) return undefined;
  return Math.max(0, timestamp - Date.now());
}

function findRequestId(headers: Headers): string | undefined {
  return headers.get("x-request-id") ?? headers.get("request-id") ?? undefined;
}

function abortedError(): ModelTransportError {
  return new ModelTransportError("aborted", "Model request was aborted");
}

function timeoutError(): ModelTransportError {
  return new ModelTransportError("timeout", "Model request timed out");
}

function responseTooLargeError(requestId?: string): ModelTransportError {
  return new ModelTransportError("response_too_large", "Model response exceeds the configured size limit", { requestId });
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
}
