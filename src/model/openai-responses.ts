import type { AssistantMessage, Message, ModelClient, ModelFinishReason, ModelRequest, ModelResponse, ModelStreamEvent, ModelToolDefinition, ModelUsage, ToolCall } from "../agent/types.ts";
import { FetchHttpTransport, type HttpTransport } from "./transport.ts";

export class OpenAIResponsesResponseError extends Error {
  constructor(message: string) { super(message); this.name = "OpenAIResponsesResponseError"; }
}

export interface OpenAIResponsesModelOptions {
  readonly baseUrl: string; readonly model: string; readonly apiKey?: string; readonly transport?: HttpTransport;
  readonly timeoutMs?: number; readonly maxResponseBytes?: number;
}

/** OpenAI Responses 协议适配层；Agent 只看到统一 ModelClient。 */
export class OpenAIResponsesModel implements ModelClient {
  readonly provider = "openai-responses"; readonly capabilities = { toolCalling: true, streaming: true } as const;
  readonly model: string; private readonly endpoint: URL; private readonly apiKey?: string; private readonly transport: HttpTransport;
  private readonly timeoutMs?: number; private readonly maxResponseBytes?: number;
  constructor(options: OpenAIResponsesModelOptions) {
    if (typeof options.model !== "string" || !options.model.trim()) throw new Error("model must be a non-empty string");
    this.model = options.model; this.endpoint = responsesEndpoint(options.baseUrl);
    if (options.apiKey !== undefined) { if (!options.apiKey.trim() || /[\0\r\n]/.test(options.apiKey)) throw new Error("apiKey must be a non-empty single-line string when provided"); this.apiKey = options.apiKey; }
    this.transport = options.transport ?? new FetchHttpTransport(); this.timeoutMs = options.timeoutMs; this.maxResponseBytes = options.maxResponseBytes;
  }
  async generate(request: ModelRequest): Promise<ModelResponse> {
    const response = await this.transport.requestJson<unknown>({ url: this.endpoint, init: this.init(request, false), signal: request.signal, timeoutMs: this.timeoutMs, maxResponseBytes: this.maxResponseBytes });
    return parseResponse(response);
  }
  async *generateStream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    const req = { url: this.endpoint, init: this.init(request, true), signal: request.signal, timeoutMs: this.timeoutMs, maxResponseBytes: this.maxResponseBytes };
    const source = this.transport.stream ? this.transport.stream(req) : (async function* (t: HttpTransport) { yield (await t.request(req)).bodyText; })(this.transport);
    let pending = ""; let done = false;
    for await (const chunk of source) { pending += chunk; const lines = pending.split(/\r?\n/); pending = lines.pop() ?? ""; for (const line of lines) { const event = parseSseLine(line); if (event) { for (const item of event) { if (item.type === "done") { if (done) continue; done = true; } yield item; } } } }
    if (pending) { const event = parseSseLine(pending); if (event) for (const item of event) { if (item.type === "done") { if (done) continue; done = true; } yield item; } }
    if (!done) yield { type: "done" };
  }
  private init(request: ModelRequest, stream: boolean): RequestInit {
    validateHistory(request.messages);
    const payload: Record<string, unknown> = { model: this.model, input: request.messages.flatMap(toInput), ...(request.previousResponseId ? { previous_response_id: request.previousResponseId } : {}), ...(request.tools.length ? { tools: request.tools.map(toTool) } : {}), ...(stream ? { stream: true } : {}) };
    const headers: Record<string, string> = { "content-type": "application/json", ...(stream ? { accept: "text/event-stream" } : {}) }; if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;
    return { method: "POST", redirect: "error", headers, body: JSON.stringify(payload) };
  }
}

function toInput(message: Message): readonly Record<string, unknown>[] {
  if (message.role === "system") return [{ role: "system", content: message.content }];
  if (message.role === "user") return [{ role: "user", content: message.content }];
  if (message.role === "tool") return [{ type: "function_call_output", call_id: message.toolCallId, output: message.content }];
  const items: Record<string, unknown>[] = []; if (message.content || !(message.toolCalls?.length)) items.push({ role: "assistant", content: message.content });
  for (const call of message.toolCalls ?? []) items.push({ type: "function_call", call_id: call.id, name: call.name, arguments: serializeToolInput(call.input) });
  return items;
}
function toTool(tool: ModelToolDefinition): Record<string, unknown> { return { type: "function", name: tool.name, description: tool.description, parameters: tool.inputSchema }; }
function responsesEndpoint(baseUrl: string): URL { let base: URL; try { base = new URL(baseUrl); } catch { throw new Error("baseUrl must be an absolute URL"); } if (!["http:", "https:"].includes(base.protocol)) throw new Error("baseUrl must use http or https"); if (base.search || base.hash) throw new Error("baseUrl must not include a query string or fragment"); if (base.username || base.password) throw new Error("baseUrl must not include credentials"); if (!base.pathname.endsWith("/")) base.pathname += "/"; return new URL("responses", base); }
function parseResponse(value: unknown): ModelResponse { const response = record(value, "response"); const output = array(response.output, "response.output"); const calls: ToolCall[] = []; const ids = new Set<string>(); let content = ""; for (const item of output) { const x = record(item, "response.output[]"); if (x.type === "message") { for (const part of array(x.content, "response.output[].content")) { const p = record(part, "response.output[].content[]"); if (p.type === "output_text" && typeof p.text === "string") content += p.text; } } else if (x.type === "function_call") { const id = nonEmpty(x.call_id, "response.output[].call_id"); if (ids.has(id)) throw invalid("response.output[].call_id must be unique"); ids.add(id); const name = nonEmpty(x.name, "response.output[].name"); const args = requireString(x.arguments, "response.output[].arguments"); try { calls.push({ id, name, input: JSON.parse(args) }); } catch { throw invalid("response.output[].arguments must contain valid JSON"); } } }
  const status = response.status; const reason: ModelFinishReason | undefined = status === "completed" ? (calls.length ? "tool_use" : "stop") : status === "incomplete" ? "length" : undefined; const message: AssistantMessage = { role: "assistant", content, ...(calls.length ? { toolCalls: calls } : {}) }; return { message, finishReason: reason, ...(response.usage !== undefined ? { usage: parseUsage(response.usage) } : {}) };
}
function parseSseLine(line: string): ModelStreamEvent[] | undefined {
  if (!line.startsWith("data:")) return;
  const data = line.slice(5).trim();
  if (!data || data === "[DONE]") return [{ type: "done", finishReason: "stop" }];
  let value: unknown; try { value = JSON.parse(data); } catch { throw invalid("stream event is not valid JSON"); }
  const e = record(value, "stream event"); const type = e.type;
  if (type === "response.output_text.delta") return typeof e.delta === "string" ? [{ type: "text_delta", text: e.delta }] : undefined;
  if (type === "response.output_item.added") {
    const item = record(e.item, "stream event.item");
    if (item.type === "function_call") return [{ type: "tool_call_delta", index: Number.isInteger(e.output_index) ? e.output_index as number : 0, ...(typeof item.call_id === "string" ? { id: item.call_id } : {}), ...(typeof item.name === "string" ? { name: item.name } : {}) }];
  }
  if (type === "response.function_call_arguments.delta") return typeof e.delta === "string" ? [{ type: "tool_call_delta", index: Number.isInteger(e.output_index) ? e.output_index as number : 0, ...(typeof e.call_id === "string" ? { id: e.call_id } : {}), ...(typeof e.name === "string" ? { name: e.name } : {}), ...(typeof e.item_id === "string" ? { id: e.item_id } : {}), argumentsDelta: e.delta }] : undefined;
  if (type === "response.completed") {
    const response = e.response && typeof e.response === "object" ? e.response as Record<string, unknown> : undefined;
    const usage = response?.usage !== undefined ? { type: "usage" as const, usage: parseUsage(response.usage) } : undefined;
    const reason: ModelFinishReason = response?.status === "incomplete" ? "length" : "stop";
    return [...(usage ? [usage] : []), { type: "done", finishReason: reason }];
  }
  return undefined;
}
function parseUsage(value: unknown): ModelUsage { const u = record(value, "response.usage"); const input = nonNeg(u.input_tokens, "response.usage.input_tokens"); const output = nonNeg(u.output_tokens, "response.usage.output_tokens"); const details = u.input_token_details && typeof u.input_token_details === "object" ? u.input_token_details as Record<string, unknown> : undefined; return { inputTokens: input, outputTokens: output, totalTokens: nonNeg(u.total_tokens, "response.usage.total_tokens"), ...(details?.cached_tokens !== undefined ? { cacheReadTokens: nonNeg(details.cached_tokens, "response.usage.input_token_details.cached_tokens") } : {}) }; }
function serializeToolInput(input: unknown): string { try { const value = JSON.stringify(input); if (typeof value !== "string") throw new Error(); return value; } catch { throw new Error("Tool call input must be JSON-serializable"); } }
function validateHistory(messages: readonly Message[]): void { const calls = new Set<string>(); for (const message of messages) { if (message.role === "assistant") for (const call of message.toolCalls ?? []) { if (calls.has(call.id)) throw new OpenAIResponsesResponseError("Invalid OpenAI Responses request: tool call IDs must be unique"); calls.add(call.id); } if (message.role === "tool" && !calls.has(message.toolCallId)) throw new OpenAIResponsesResponseError("Invalid OpenAI Responses request: tool result call_id has no matching function call"); } }
function record(v: unknown, p: string): Readonly<Record<string, unknown>> { if (!v || typeof v !== "object" || Array.isArray(v)) throw invalid(`${p} must be an object`); return v as Readonly<Record<string, unknown>>; }
function array(v: unknown, p: string): readonly unknown[] { if (!Array.isArray(v)) throw invalid(`${p} must be an array`); return v; }
function requireString(v: unknown, p: string): string { if (typeof v !== "string") throw invalid(`${p} must be a string`); return v; }
function nonEmpty(v: unknown, p: string): string { const s = requireString(v, p); if (!s.trim()) throw invalid(`${p} must not be empty`); return s; }
function nonNeg(v: unknown, p: string): number { if (!Number.isInteger(v) || (v as number) < 0) throw invalid(`${p} must be a non-negative integer`); return v as number; }
function invalid(message: string): OpenAIResponsesResponseError { return new OpenAIResponsesResponseError(`Invalid OpenAI Responses response: ${message}`); }
