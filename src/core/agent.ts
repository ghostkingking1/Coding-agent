import { ToolRegistry } from "./tool-registry.ts";
import type {
  AgentOptions,
  AgentResult,
  Message,
  Model,
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
      this.options.signal?.throwIfAborted();
      const response = await this.model.generate(messages);
      const assistantMessage: Message = {
        role: "assistant",
        content: response.message.content,
      };
      messages.push(assistantMessage);

      const calls = response.toolCalls ?? [];
      if (calls.length === 0) {
        return {
          finalText: response.message.content,
          messages: [...messages],
          steps: step,
          stopReason: "completed",
        };
      }

      for (const call of calls) {
        messages.push(await this.executeToolCall(call, messages));
      }
    }

    return {
      finalText: "",
      messages: [...messages],
      steps: this.options.maxSteps,
      stopReason: "max_steps",
    };
  }

  private async executeToolCall(call: ToolCall, messages: readonly Message[]): Promise<Message> {
    try {
      const result = await this.tools.execute(call.name, call.input, {
        messages,
        signal: this.options.signal,
      });
      return {
        role: "tool",
        content: serializeToolResult(result),
        toolCallId: call.id,
        toolName: call.name,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        role: "tool",
        content: JSON.stringify({ error: message }),
        toolCallId: call.id,
        toolName: call.name,
      };
    }
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
