import type {
  AssistantMessage,
  Message,
  ModelClient,
  ModelFinishReason,
  ModelRequest,
  ModelResponse,
  ModelToolDefinition,
  ToolCall,
} from "../agent/types.ts";
import { FetchHttpTransport, type HttpTransport } from "./transport.ts";

/** OpenAI-compatible 响应不符合本项目所需结构时抛出的错误。 */
export class OpenAICompatibleResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpenAICompatibleResponseError";
  }
}

/** OpenAI-compatible Chat Completions adapter 的配置。 */
export interface OpenAICompatibleModelOptions {
  /** 服务的 API 基础地址，例如 https://example.com/v1。 */
  readonly baseUrl: string;
  /** 供应商侧实际使用的模型名称。 */
  readonly model: string;
  /** 可选 Bearer token；本 adapter 不读取环境变量或打印该值。 */
  readonly apiKey?: string;
  /** 注入 transport 以支持测试或由上层统一网络策略。 */
  readonly transport?: HttpTransport;
  /** 单次模型请求的超时，由 transport 强制执行。 */
  readonly timeoutMs?: number;
  /** 单次模型响应的最大字节数，由 transport 强制执行。 */
  readonly maxResponseBytes?: number;
}

/**
 * 实现 Chat Completions 风格的模型 adapter。
 * 该层只转换供应商协议；网络限制由 HttpTransport、工具安全由 ToolRegistry 负责。
 */
export class OpenAICompatibleModel implements ModelClient {
  readonly provider = "openai-compatible";
  readonly model: string;
  readonly capabilities = { toolCalling: true, streaming: false } as const;
  private readonly endpoint: URL;
  private readonly apiKey?: string;
  private readonly transport: HttpTransport;
  private readonly timeoutMs?: number;
  private readonly maxResponseBytes?: number;

  constructor(options: OpenAICompatibleModelOptions) {
    this.model = requireConfigString(options.model, "model");
    this.endpoint = chatCompletionsEndpoint(options.baseUrl);
    if (options.apiKey !== undefined) {
      if (!options.apiKey.trim() || /[\0\r\n]/.test(options.apiKey)) {
        throw new Error("apiKey must be a non-empty single-line string when provided");
      }
      this.apiKey = options.apiKey;
    }
    this.transport = options.transport ?? new FetchHttpTransport();
    this.timeoutMs = options.timeoutMs;
    this.maxResponseBytes = options.maxResponseBytes;
  }

  async generate(request: ModelRequest): Promise<ModelResponse> {
    const payload: OpenAICompatibleRequest = {
      model: this.model,
      messages: request.messages.map(toOpenAIMessage),
      ...(request.tools.length > 0 ? { tools: request.tools.map(toOpenAITool) } : {}),
    };
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;

    const response = await this.transport.requestJson<unknown>({
      url: this.endpoint,
      init: {
        method: "POST",
        /** 审批只覆盖显式配置的 origin，不能让 fetch 把对话内容转发到未确认的重定向目标。 */
        redirect: "error",
        headers,
        body: JSON.stringify(payload),
      },
      signal: request.signal,
      timeoutMs: this.timeoutMs,
      maxResponseBytes: this.maxResponseBytes,
    });
    return parseOpenAIResponse(response);
  }
}

interface OpenAICompatibleRequest {
  readonly model: string;
  readonly messages: readonly OpenAICompatibleMessage[];
  readonly tools?: readonly OpenAICompatibleTool[];
}

type OpenAICompatibleMessage =
  | { readonly role: "system" | "user"; readonly content: string }
  | { readonly role: "assistant"; readonly content: string; readonly tool_calls?: readonly OpenAICompatibleToolCall[] }
  | { readonly role: "tool"; readonly content: string; readonly tool_call_id: string };

interface OpenAICompatibleTool {
  readonly type: "function";
  readonly function: {
    readonly name: string;
    readonly description: string;
    readonly parameters: ModelToolDefinition["inputSchema"];
  };
}

interface OpenAICompatibleToolCall {
  readonly id: string;
  readonly type: "function";
  readonly function: {
    readonly name: string;
    readonly arguments: string;
  };
}

function toOpenAIMessage(message: Message): OpenAICompatibleMessage {
  switch (message.role) {
    case "system":
    case "user":
      return { role: message.role, content: message.content };
    case "assistant":
      return {
        role: "assistant",
        content: message.content,
        ...(message.toolCalls?.length ? { tool_calls: message.toolCalls.map(toOpenAIToolCall) } : {}),
      };
    case "tool":
      return { role: "tool", content: message.content, tool_call_id: message.toolCallId };
  }
}

function toOpenAITool(tool: ModelToolDefinition): OpenAICompatibleTool {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    },
  };
}

function toOpenAIToolCall(call: ToolCall): OpenAICompatibleToolCall {
  return {
    id: call.id,
    type: "function",
    function: {
      name: call.name,
      arguments: serializeToolInput(call.input),
    },
  };
}

function serializeToolInput(input: unknown): string {
  try {
    const serialized = JSON.stringify(input);
    /** provider 历史必须是 JSON，避免 undefined 或循环引用产生无法恢复的工具调用记录。 */
    if (typeof serialized !== "string") throw new Error("not serializable");
    return serialized;
  } catch {
    throw new Error("Tool call input must be JSON-serializable");
  }
}

function parseOpenAIResponse(value: unknown): ModelResponse {
  const response = record(value, "response");
  const choices = array(response.choices, "response.choices");
  if (choices.length === 0) throw invalidResponse("response.choices must not be empty");
  const choice = record(choices[0], "response.choices[0]");
  const message = record(choice.message, "response.choices[0].message");
  if (message.role !== "assistant") throw invalidResponse("response message role must be assistant");

  const assistantMessage: AssistantMessage = {
    role: "assistant",
    content: nullableString(message.content, "response.choices[0].message.content"),
    ...(message.tool_calls === undefined ? {} : { toolCalls: parseToolCalls(message.tool_calls) }),
  };
  return {
    message: assistantMessage,
    finishReason: parseFinishReason(choice.finish_reason),
  };
}

function parseToolCalls(value: unknown): readonly ToolCall[] {
  const calls = array(value, "response.choices[0].message.tool_calls");
  const ids = new Set<string>();
  return calls.map((value, index) => {
    const path = `response.choices[0].message.tool_calls[${index}]`;
    const call = record(value, path);
    const id = requireNonEmptyString(call.id, `${path}.id`);
    if (ids.has(id)) throw invalidResponse(`${path}.id must be unique`);
    ids.add(id);
    if (call.type !== "function") throw invalidResponse(`${path}.type must be function`);
    const functionCall = record(call.function, `${path}.function`);
    const name = requireNonEmptyString(functionCall.name, `${path}.function.name`);
    const serializedInput = requireString(functionCall.arguments, `${path}.function.arguments`);
    try {
      return { id, name, input: JSON.parse(serializedInput) };
    } catch {
      throw invalidResponse(`${path}.function.arguments must contain valid JSON`);
    }
  });
}

function parseFinishReason(value: unknown): ModelFinishReason | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw invalidResponse("response.choices[0].finish_reason must be a string");
  if (value === "stop") return "stop";
  if (value === "tool_calls") return "tool_use";
  if (value === "length") return "length";
  if (value === "content_filter") return "content_filter";
  return "unknown";
}

function chatCompletionsEndpoint(baseUrl: string): URL {
  const normalized = requireConfigString(baseUrl, "baseUrl");
  let base: URL;
  try {
    base = new URL(normalized);
  } catch {
    throw new Error("baseUrl must be an absolute URL");
  }
  if (base.protocol !== "https:" && base.protocol !== "http:") {
    throw new Error("baseUrl must use http or https");
  }
  if (base.search || base.hash) throw new Error("baseUrl must not include a query string or fragment");
  if (base.username || base.password) throw new Error("baseUrl must not include credentials");
  if (!base.pathname.endsWith("/")) base.pathname += "/";
  return new URL("chat/completions", base);
}

function record(value: unknown, path: string): Readonly<Record<string, unknown>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidResponse(`${path} must be an object`);
  return value as Readonly<Record<string, unknown>>;
}

function array(value: unknown, path: string): readonly unknown[] {
  if (!Array.isArray(value)) throw invalidResponse(`${path} must be an array`);
  return value;
}

function requireString(value: unknown, path: string): string {
  if (typeof value !== "string") throw invalidResponse(`${path} must be a string`);
  return value;
}

function nullableString(value: unknown, path: string): string {
  if (value === null || value === undefined) return "";
  return requireString(value, path);
}

function requireNonEmptyString(value: unknown, path: string): string {
  const text = requireString(value, path);
  if (!text.trim()) throw invalidResponse(`${path} must not be empty`);
  return text;
}

function requireConfigString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must be a non-empty string`);
  return value;
}

function invalidResponse(message: string): OpenAICompatibleResponseError {
  return new OpenAICompatibleResponseError(`Invalid OpenAI-compatible response: ${message}`);
}
