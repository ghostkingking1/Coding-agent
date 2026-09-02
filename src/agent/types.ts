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
}

export interface ToolContext {
  /** 当前运行中的消息上下文。 */
  readonly messages: readonly Message[];
  /** 用于取消当前工具工作的信号。 */
  readonly signal?: AbortSignal;
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
  | { type: "tool_requested"; step: number; toolName: string; toolCallId: string }
  | { type: "tool_completed"; step: number; toolName: string; toolCallId: string }
  | { type: "tool_failed"; step: number; toolName: string; toolCallId: string; error: string }
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
}

/** 单次 Agent run 可由 Session 注入的上下文和标识。 */
export interface AgentRunOptions {
  /** 延续此前 run 的消息上下文。 */
  initialMessages?: readonly Message[];
  /** 关联本次运行的 Session 标识。 */
  sessionId?: string;
  /** 本次运行的稳定标识。 */
  runId?: string;
}

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
}
