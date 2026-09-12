import type { z } from "zod";

/** 消息的发送者角色。 */
export type Role = "system" | "user" | "assistant" | "tool";

/** 工具声明的能力类型，用于审批和安全策略判断。 */
export type ToolCapability = "read" | "write" | "execute" | "network";

/** 工具输入 schema 使用 Zod，便于运行时校验后把 unknown 收窄为工具自己的输入类型。 */
export type ToolInputSchema = z.ZodType;

/** 可在模型供应商之间传递的 JSON 值。 */
export type JsonValue = string | number | boolean | null | JsonObject | readonly JsonValue[];

/** JSON 对象，用于表达模型工具参数 schema。 */
export interface JsonObject {
  readonly [key: string]: JsonValue;
}

/** 面向模型的工具输入 JSON Schema。 */
export type JsonSchema = JsonObject;

/** 工具能力清单。 */
export interface ToolManifest {
  readonly capabilities: readonly ToolCapability[];
  readonly inputSchema?: ToolInputSchema;
  /** 面向模型公开的参数 schema；未声明的工具不会发送给模型。 */
  readonly modelInputSchema?: JsonSchema;
  /** 只有显式声明后，工具调用才可在同一批次并行执行。 */
  readonly parallelizable?: boolean;
  /** 相同冲突键的调用必须串行，避免资源竞态。 */
  readonly conflictKey?: (input: unknown) => string | undefined;
}

/** 在工具产生副作用前提交给审批策略的请求。 */
export interface ApprovalRequest {
  readonly toolName: string;
  readonly capabilities: readonly ToolCapability[];
  readonly input: unknown;
  readonly preview?: unknown;
}

/** 所有消息共有的文本内容。 */
interface BaseMessage {
  /** 消息正文。 */
  readonly content: string;
}

export interface ToolCall {
  /** 模型生成的工具调用标识。 */
  id: string;
  /** 要调用的工具名称。 */
  name: string;
  /** 传给工具的输入。 */
  input: unknown;
}

/** 系统消息。 */
export interface SystemMessage extends BaseMessage {
  readonly role: "system";
}

/** 用户消息。 */
export interface UserMessage extends BaseMessage {
  readonly role: "user";
}

/** 模型输出的 assistant 消息，工具调用必须随该消息一起保留。 */
export interface AssistantMessage extends BaseMessage {
  readonly role: "assistant";
  readonly toolCalls?: readonly ToolCall[];
}

/** 关联到一次 assistant 工具调用的执行结果。 */
export interface ToolMessage extends BaseMessage {
  readonly role: "tool";
  readonly toolCallId: string;
  readonly toolName: string;
}

/** 统一的对话消息类型。 */
export type Message = SystemMessage | UserMessage | AssistantMessage | ToolMessage;

/** 供应商适配器标准化后的模型结束原因。 */
export type ModelFinishReason = "stop" | "tool_use" | "length" | "content_filter" | "unknown";

export interface ModelResponse {
  /** 模型生成的 assistant 消息。 */
  readonly message: AssistantMessage;
  /** 模型本轮结束原因。 */
  readonly finishReason?: ModelFinishReason;
  readonly usage?: ModelUsage;
}

export type ModelStreamEvent =
  | { readonly type: "text_delta"; readonly text: string }
  | { readonly type: "tool_call_delta"; readonly index: number; readonly id?: string; readonly name?: string; readonly argumentsDelta?: string }
  | { readonly type: "usage"; readonly usage: ModelUsage }
  | { readonly type: "done"; readonly finishReason?: ModelFinishReason };

/** 供应商归一化后的模型用量；缺失字段由 adapter 省略或置零。 */
export interface ModelUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
  readonly cacheSavedTokens?: number;
}

export interface ContextBudget {
  readonly maxInputTokens: number;
  readonly reservedOutputTokens?: number;
  /** 达到输入预算的该比例时主动摘要旧历史；默认 0.75。 */
  readonly compactThresholdRatio?: number;
  readonly recentTurns?: number;
  readonly maxToolOutputTokens?: number;
}

export interface ContextSummary {
  readonly summaryId: string;
  readonly sourceMessageIndexes: readonly number[];
  readonly content: string;
}
export interface ContextCheckpoint {
  readonly sessionId: string;
  readonly coveredThroughSequence: number;
  readonly sourcePrefixHash: string;
  readonly summarySegments: readonly ContextSummary[];
  readonly retainedTailStart: number;
  readonly updatedAt: string;
}

export type ContextDegradation = "tool_output_truncated" | "snipped" | "context_collapsed" | "old_messages_summarized" | "current_request_exceeds_budget";

export interface ContextStageResult { readonly name: string; readonly estimatedTokens: number; }

export interface ContextResult {
  readonly messages: readonly Message[];
  readonly estimatedTokens: number;
  readonly rawEstimatedTokens: number;
  readonly calibrationFactor: number;
  readonly budget: number;
  readonly compactionThreshold: number;
  readonly compacted: boolean;
  readonly stages: readonly ContextStageResult[];
  readonly summaries: readonly ContextSummary[];
  readonly degradation?: ContextDegradation;
}

export interface ContextManager {
  estimate(messages: readonly Message[]): number;
  compact(messages: readonly Message[], budget: number | ContextBudget): Promise<ContextResult>;
  observeUsage?(context: ContextResult, usage: ModelUsage): void;
  buildRequestContext(sessionId: string, input: string): Promise<readonly Message[]>;
  exportCheckpoint?(sessionId: string, messages: readonly Message[], budget?: ContextBudget): Promise<ContextCheckpoint | undefined>;
  restoreCheckpoint?(checkpoint: ContextCheckpoint, messages: readonly Message[]): boolean;
}

/** 提供给模型的工具定义，不包含本地执行实现或安全策略。 */
export interface ModelToolDefinition {
  /** 工具稳定名称。 */
  readonly name: string;
  /** 帮助模型选择工具的说明。 */
  readonly description: string;
  /** 模型生成工具参数时使用的 JSON Schema。 */
  readonly inputSchema: JsonSchema;
}

/** 模型供应商实现的能力声明。 */
export interface ModelCapabilities {
  /** 是否可以请求执行工具。 */
  readonly toolCalling: boolean;
  /** 是否支持增量流式响应。 */
  readonly streaming: boolean;
}

/** 一次模型调用的供应商无关输入。 */
export interface ModelRequest {
  /** 当前完整对话消息。 */
  readonly messages: readonly Message[];
  /** 可供模型选择的已声明工具。 */
  readonly tools: readonly ModelToolDefinition[];
  /** 取消当前模型请求的信号。 */
  readonly signal?: AbortSignal;
  readonly contextResult?: ContextResult;
  /** Responses 协议可选的服务端上下文引用。 */
  readonly previousResponseId?: string;
}

/** 真实 provider 和测试替身共同实现的统一模型接口。 */
export interface ModelClient {
  /** 供应商标识，例如 openai 或 anthropic。 */
  readonly provider: string;
  /** 本次调用使用的模型标识。 */
  readonly model: string;
  /** 供应商已实现的可选能力。 */
  readonly capabilities: ModelCapabilities;
  /** 根据统一请求生成标准化响应。 */
  generate(request: ModelRequest): Promise<ModelResponse>;
  generateStream?(request: ModelRequest): AsyncIterable<ModelStreamEvent>;
}

export interface ModelRetryOptions {
  readonly maxAttempts?: number;
  readonly maxTotalMs?: number;
  readonly initialBackoffMs?: number;
  readonly maxBackoffMs?: number;
  readonly sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
}

export interface AuditEvent {
  readonly sessionId?: string;
  readonly runId?: string;
  readonly sequence?: number;
  readonly eventType: string;
  readonly step?: number;
  readonly toolCallId?: string;
  readonly toolName?: string;
  readonly attempt?: number;
  readonly status?: string;
  readonly errorCode?: string;
  readonly requestId?: string;
  readonly metadata?: JsonObject;
  readonly createdAt?: string;
}

export interface AuditSink { record(event: AuditEvent): Promise<void>; }

export interface ToolContext {
  /** 当前运行中的消息上下文。 */
  readonly messages: readonly Message[];
  /** 用于取消当前工具工作的信号。 */
  readonly signal?: AbortSignal;
  /** 临时工具输出只能在产生它的会话和运行内读取。 */
  readonly sessionId?: string;
  readonly runId?: string;
  readonly toolOutputStore?: import("./tool-output-store.ts").ToolOutputStore;
  /** 工具可补充自身的受限审计摘要，不能写入完整不可信输出。 */
  readonly auditSink?: AuditSink;
  /** 当前 Agent 运行的变更记录器，供写入工具在副作用前保存原始内容。 */
  readonly changeTracker?: {
    recordBeforeWrite(absolutePath: string, relativePath: string, originalContent: string): void;
  };
}

/** 工具执行前的授权策略。 */
export interface ToolExecutionPolicy {
  /** 在工具执行产生副作用前完成授权判断。 */
  authorize(tool: Tool, input: unknown, context: ToolContext): Promise<void> | void;
}

export interface Tool<TInput = unknown> {
  /** 工具的稳定名称。 */
  readonly name: string;
  /** 面向模型和调用方的工具说明。 */
  readonly description: string;
  /** 工具声明的能力和安全边界。 */
  readonly manifest?: ToolManifest;
  /** 在执行前生成可供审批查看的预览结果。 */
  preview?(input: TInput, context: ToolContext): Promise<unknown> | unknown;
  /** 执行工具并返回结构化或文本结果。 */
  execute(input: TInput, context: ToolContext): Promise<unknown> | unknown;
}

/** Agent 运行过程中的可观测事件。 */
export type RunEvent =
  | { type: "model_started"; step: number }
  | { type: "model_delta"; step: number; text: string }
  | { type: "model_retry"; step: number; attempt: number; errorCode: string; delayMs: number }
  | { type: "tool_batch_started"; step: number; batchId: string; toolCallCount: number; parallelCount: number }
  | { type: "tool_requested"; step: number; toolName: string; toolCallId: string }
  | { type: "tool_completed"; step: number; toolName: string; toolCallId: string }
  | { type: "tool_failed"; step: number; toolName: string; toolCallId: string; error: string }
  | { type: "tool_batch_finished"; step: number; batchId: string; succeeded: number; failed: number }
  | { type: "run_finished"; steps: number; stopReason: AgentResult["stopReason"] }
  | { type: "run_failed"; error: string };

/** Agent 的运行配置。 */
export interface AgentOptions {
  /** 单次运行允许的最大模型循环次数。 */
  maxSteps?: number;
  /** 注入模型上下文的系统提示词。 */
  systemPrompt?: string;
  /** 取消当前运行的信号。 */
  signal?: AbortSignal;
  /** 每个运行事件发出时调用的观察器。 */
  onEvent?: (event: RunEvent) => void | Promise<void>;
  /** 是否生成本次运行涉及文件的最终 diff。 */
  includeRunDiff?: boolean;
  /** 可注入工作区范围的 tracker，便于 CLI 或测试控制快照范围。 */
  changeTracker?: import("./run-diff.ts").RunChangeTracker;
  contextManager?: ContextManager;
  /** 模型最大输入 token；未配置时 Agent 使用保守的 32,000 token。 */
  contextBudget?: ContextBudget;
  toolOutputStore?: import("./tool-output-store.ts").ToolOutputStore;
  /** 同一批次允许同时执行的工具调用数。 */
  maxConcurrentToolCalls?: number;
  retry?: ModelRetryOptions;
  auditSink?: AuditSink;
}

/** 单次 Agent run 可由 Session 注入的上下文和标识。 */
export interface AgentRunOptions {
  /** 延续此前 run 的消息上下文。 */
  initialMessages?: readonly Message[];
  /** 关联本次运行的 Session 标识。 */
  sessionId?: string;
  /** 本次运行的稳定标识。 */
  runId?: string;
  /** 可选的本次运行变更跟踪器；由 Session/CLI 注入以隔离每轮基线。 */
  changeTracker?: import("./run-diff.ts").RunChangeTracker;
  checkpoint?: CheckpointSink;
  replayToolResults?: ReadonlyMap<string, string>;
  /** 从已持久化的 run 内 checkpoint 继续，不能与新输入拼接。 */
  resumeCheckpoint?: CheckpointRecord;
  auditSink?: AuditSink;
  /** 可选的 Git 基线跟踪器；仅采集只读状态，不参与任何 Git 写入。 */
  gitChangeTracker?: import("../repository/git.ts").GitChangeTracker;
}

export interface CheckpointRecord {
  readonly sessionId: string;
  readonly runId: string;
  readonly step: number;
  readonly phase: "model" | "tool";
  readonly messages: readonly Message[];
  readonly toolResults: readonly { readonly key: string; readonly toolCallId: string; readonly toolName: string; readonly status: "completed" | "failed"; readonly result: string }[];
  readonly updatedAt: string;
}

export interface CheckpointSink { save(checkpoint: CheckpointRecord): Promise<void>; }

export interface AgentResult {
  /** Agent 最终生成的文本。 */
  finalText: string;
  /** 本次运行积累的完整消息记录。 */
  messages: readonly Message[];
  /** 实际执行的模型循环次数。 */
  steps: number;
  /** 运行结束的原因。 */
  stopReason: "completed" | "max_steps";
  /** 本次运行成功写入文件的最终 unified diff。 */
  diff?: import("./run-diff.ts").RunDiff;
  /** 本次运行前后 Git 状态及与 Agent diff 的归属交叉结果。 */
  gitChanges?: import("../repository/git.ts").GitChangeReport;
}
