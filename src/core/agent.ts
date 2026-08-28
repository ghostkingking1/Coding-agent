import { ToolRegistry } from "./tool-registry.ts";
import type {
  AgentOptions,
  AgentResult,
  Message,
  ModelClient,
  ModelResponse,
  ToolCall,
} from "./types.ts";

const DEFAULT_MAX_STEPS = 8;

/** 驱动模型、工具和消息上下文之间多轮交互的 Agent 执行器。 */
export class Agent {
  private readonly model: ModelClient;
  private readonly tools: ToolRegistry;
  private readonly options: Required<Pick<AgentOptions, "maxSteps">> & Omit<AgentOptions, "maxSteps">;

  /** 创建 Agent，并把最大步数归一化为每次运行共享的上限。 */
  constructor(model: ModelClient, tools = new ToolRegistry(), options: AgentOptions = {}) {
    const maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS;
    if (!Number.isInteger(maxSteps) || maxSteps < 1) {
      throw new Error("maxSteps must be a positive integer");
    }
    /** 统一保存配置，确保每次运行都遵守同一个有限循环上限。 */
    this.model = model;
    this.tools = tools;
    this.options = { ...options, maxSteps };
  }

  /** 执行一次用户请求，并在模型和工具之间循环传递消息。 */
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
      /** 每轮开始前检查取消信号，避免停止后的运行启动新的模型或工具操作。 */
      this.options.signal?.throwIfAborted();
      await this.emit({ type: "model_started", step });
      let response: ModelResponse;
      try {
        response = await this.model.generate({
          messages,
          tools: this.tools.listModelDefinitions(),
          signal: this.options.signal,
        });
      } catch (error) {
        await this.emit({ type: "run_failed", error: error instanceof Error ? error.message : String(error) });
        throw error;
      }
      /** 保留原始工具调用，下一轮 provider 才能正确关联对应的 tool result。 */
      messages.push(response.message);

      const calls = response.message.toolCalls ?? [];
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

  /** 执行单个工具调用，并把成功或失败结果转换为工具消息。 */
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

  /** 将运行事件交给调用方观察器。 */
  private async emit(event: Parameters<NonNullable<AgentOptions["onEvent"]>>[0]): Promise<void> {
    await this.options.onEvent?.(event);
  }
}

/** 将工具结果稳定地转换为可放入消息上下文的文本。 */
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
