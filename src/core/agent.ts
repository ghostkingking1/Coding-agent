import { ToolRegistry } from "./tool-registry.ts";
import type {
  AgentOptions,
  AgentResult,
  Message,
  Model,
  ModelResponse,
  ToolCall,
} from "./types.ts";

const DEFAULT_MAX_STEPS = 8;

export class Agent {
  private readonly model: Model;
  private readonly tools: ToolRegistry;
  private readonly options: Required<Pick<AgentOptions, "maxSteps">> & Omit<AgentOptions, "maxSteps">;

  constructor(model: Model, tools = new ToolRegistry(), options: AgentOptions = {}) {
    const maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS;
    if (!Number.isInteger(maxSteps) || maxSteps < 1) {
      throw new Error("maxSteps must be a positive integer");
    }
    // Normalize the default once so every run uses the same bounded loop.
    this.model = model;
    this.tools = tools;
    this.options = { ...options, maxSteps };
  }

  async run(input: string): Promise<AgentResult> {
    if (!input.trim()) {
      throw new Error("Agent input must not be empty");
    }

    const messages: Message[] = [];
    if (this.options.systemPrompt) {
      messages.push({ role: "system", content: this.options.systemPrompt });
    }
    messages.push({ role: "user", content: input });

    for (let step = 1; step <= this.options.maxSteps; step += 1) {
      // Cancellation is checked before each model/tool cycle so a stopped run cannot start another operation.
      this.options.signal?.throwIfAborted();
      await this.emit({ type: "model_started", step });
      let response: ModelResponse;
      try {
        response = await this.model.generate(messages);
      } catch (error) {
        await this.emit({ type: "run_failed", error: error instanceof Error ? error.message : String(error) });
        throw error;
      }
      const assistantMessage: Message = {
        role: "assistant",
        content: response.message.content,
      };
      messages.push(assistantMessage);

      const calls = response.toolCalls ?? [];
      if (calls.length === 0) {
        const result = {
          finalText: response.message.content,
          messages: [...messages],
          steps: step,
          stopReason: "completed",
        } as const;
        await this.emit({ type: "run_finished", steps: result.steps, stopReason: result.stopReason });
        return result;
      }

      for (const call of calls) {
        await this.emit({ type: "tool_requested", step, toolName: call.name, toolCallId: call.id });
        messages.push(await this.executeToolCall(call, messages, step));
      }
    }

    const result = {
      finalText: "",
      messages: [...messages],
      steps: this.options.maxSteps,
      stopReason: "max_steps",
    } as const;
    await this.emit({ type: "run_finished", steps: result.steps, stopReason: result.stopReason });
    return result;
  }

  private async executeToolCall(call: ToolCall, messages: readonly Message[], step: number): Promise<Message> {
    try {
      const result = await this.tools.execute(call.name, call.input, {
        messages,
        signal: this.options.signal,
      });
      await this.emit({ type: "tool_completed", step, toolName: call.name, toolCallId: call.id });
      return {
        role: "tool",
        content: serializeToolResult(result),
        toolCallId: call.id,
        toolName: call.name,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.emit({ type: "tool_failed", step, toolName: call.name, toolCallId: call.id, error: message });
      return {
        role: "tool",
        content: JSON.stringify({ error: message }),
        toolCallId: call.id,
        toolName: call.name,
      };
    }
  }

  private async emit(event: Parameters<NonNullable<AgentOptions["onEvent"]>>[0]): Promise<void> {
    await this.options.onEvent?.(event);
  }
}

function serializeToolResult(result: unknown): string {
  if (typeof result === "string") {
    return result;
  }
  try {
    return JSON.stringify(result);
  } catch {
    return String(result);
  }
}
