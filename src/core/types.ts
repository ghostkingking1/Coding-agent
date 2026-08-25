/** 消息的发送者角色。 */
export type Role = "system" | "user" | "assistant" | "tool";

/** 工具声明的能力类型，用于审批和安全策略判断。 */
export type ToolCapability = "read" | "write" | "execute" | "network";

/** 工具能力清单。 */
export interface ToolManifest {
  readonly capabilities: readonly ToolCapability[];
}

/** 在工具产生副作用前提交给审批策略的请求。 */
export interface ApprovalRequest {
  readonly toolName: string;
  readonly capabilities: readonly ToolCapability[];
  readonly input: unknown;
  readonly preview?: unknown;
}

export interface Message {
  /** 消息发送者。 */
  role: Role;
  /** 消息正文。 */
  content: string;
  /** 关联的工具调用标识。 */
  toolCallId?: string;
  /** 关联的工具名称。 */
  toolName?: string;
}

export interface ToolCall {
  /** 模型生成的工具调用标识。 */
  id: string;
  /** 要调用的工具名称。 */
  name: string;
  /** 传给工具的输入。 */
  input: unknown;
}

export interface ModelResponse {
  /** 模型生成的 assistant 消息。 */
  message: Message;
  /** 模型请求执行的工具调用。 */
  toolCalls?: ToolCall[];
  /** 模型本轮结束原因。 */
  finishReason?: "stop" | "tool_use";
}

export interface Model {
  /** 根据当前消息上下文生成下一步模型响应。 */
  generate(messages: readonly Message[]): Promise<ModelResponse>;
}

export interface ToolContext {
  /** 当前运行中的消息上下文。 */
  readonly messages: readonly Message[];
  /** 用于取消当前工具工作的信号。 */
  readonly signal?: AbortSignal;
}

/** 工具执行前的授权策略。 */
export interface ToolExecutionPolicy {
  /** 在工具执行产生副作用前完成授权判断。 */
  authorize(tool: Tool, input: unknown, context: ToolContext): Promise<void> | void;
}

export interface Tool {
  /** 工具的稳定名称。 */
  readonly name: string;
  /** 面向模型和调用方的工具说明。 */
  readonly description: string;
  /** 工具声明的能力和安全边界。 */
  readonly manifest?: ToolManifest;
  /** 在执行前生成可供审批查看的预览结果。 */
  preview?(input: unknown, context: ToolContext): Promise<unknown> | unknown;
  /** 执行工具并返回结构化或文本结果。 */
  execute(input: unknown, context: ToolContext): Promise<unknown> | unknown;
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
}
