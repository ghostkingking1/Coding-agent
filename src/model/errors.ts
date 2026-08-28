/** 模型 HTTP 通信失败的稳定分类，供 provider adapter 决定是否可以重试。 */
export type ModelTransportErrorCode =
  | "aborted"
  | "timeout"
  | "network"
  | "unauthorized"
  | "forbidden"
  | "rate_limited"
  | "server_error"
  | "http_error"
  | "response_too_large"
  | "invalid_json";

/** 创建模型通信错误时可附带的非敏感上下文。 */
export interface ModelTransportErrorOptions {
  readonly status?: number;
  readonly retryAfterMs?: number;
  readonly requestId?: string;
}

/**
 * provider adapter 只依据这类标准化错误决定行为，避免暴露服务端响应正文、URL 或密钥。
 */
export class ModelTransportError extends Error {
  readonly code: ModelTransportErrorCode;
  readonly status?: number;
  readonly retryAfterMs?: number;
  readonly requestId?: string;

  constructor(code: ModelTransportErrorCode, message: string, options: ModelTransportErrorOptions = {}) {
    super(message);
    this.name = "ModelTransportError";
    this.code = code;
    this.status = options.status;
    this.retryAfterMs = options.retryAfterMs;
    this.requestId = options.requestId;
  }
}
