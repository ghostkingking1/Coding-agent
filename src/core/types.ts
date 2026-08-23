export type Role = "system" | "user" | "assistant" | "tool";

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

export interface Tool {
  readonly name: string;
  readonly description: string;
  execute(input: unknown, context: ToolContext): Promise<unknown> | unknown;
}

export interface AgentOptions {
  maxSteps?: number;
  systemPrompt?: string;
  signal?: AbortSignal;
}

export interface AgentResult {
  finalText: string;
  messages: readonly Message[];
  steps: number;
  stopReason: "completed" | "max_steps";
}
