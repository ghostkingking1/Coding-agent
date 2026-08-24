export type Role = "system" | "user" | "assistant" | "tool";

export type ToolCapability = "read" | "write" | "execute" | "network";

export interface ToolManifest {
  readonly capabilities: readonly ToolCapability[];
}

export interface ApprovalRequest {
  readonly toolName: string;
  readonly capabilities: readonly ToolCapability[];
  readonly input: unknown;
  readonly preview?: unknown;
}

export interface Message {
  role: Role;
  content: string;
  toolCallId?: string;
  toolName?: string;
}

export interface ToolCall {
  id: string;
  name: string;
  input: unknown;
}

export interface ModelResponse {
  message: Message;
  toolCalls?: ToolCall[];
  finishReason?: "stop" | "tool_use";
}

export interface Model {
  generate(messages: readonly Message[]): Promise<ModelResponse>;
}

export interface ToolContext {
  readonly messages: readonly Message[];
  readonly signal?: AbortSignal;
}

export interface ToolExecutionPolicy {
  authorize(tool: Tool, input: unknown, context: ToolContext): Promise<void> | void;
}

export interface Tool {
  readonly name: string;
  readonly description: string;
  readonly manifest?: ToolManifest;
  preview?(input: unknown, context: ToolContext): Promise<unknown> | unknown;
  execute(input: unknown, context: ToolContext): Promise<unknown> | unknown;
}

export type RunEvent =
  | { type: "model_started"; step: number }
  | { type: "tool_requested"; step: number; toolName: string; toolCallId: string }
  | { type: "tool_completed"; step: number; toolName: string; toolCallId: string }
  | { type: "tool_failed"; step: number; toolName: string; toolCallId: string; error: string }
  | { type: "run_finished"; steps: number; stopReason: AgentResult["stopReason"] }
  | { type: "run_failed"; error: string };

export interface AgentOptions {
  maxSteps?: number;
  systemPrompt?: string;
  signal?: AbortSignal;
  onEvent?: (event: RunEvent) => void | Promise<void>;
}

export interface AgentResult {
  finalText: string;
  messages: readonly Message[];
  steps: number;
  stopReason: "completed" | "max_steps";
}
