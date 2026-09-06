import { ToolRegistry } from "../tools/tool-registry.ts";
import { RunChangeTracker } from "./run-diff.ts";
import { DefaultContextManager } from "./context-manager.ts";
import { createToolOutputReadTool } from "../tools/tool-output-tool.ts";
import { ToolOutputStore } from "./tool-output-store.ts";
import type {
  AgentOptions,
  AgentRunOptions,
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
  private readonly contextManager: import("./types.ts").ContextManager;
  private readonly toolOutputStore: ToolOutputStore;

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
    this.contextManager = options.contextManager ?? new DefaultContextManager();
    this.toolOutputStore = options.toolOutputStore ?? new ToolOutputStore();
  }

  /** 执行一次用户请求，并在模型和工具之间循环传递消息。 */
  async run(input: string, runOptions: AgentRunOptions = {}): Promise<AgentResult> {
    if (!input.trim()) {
      throw new Error("Agent input must not be empty");
    }

    const messages: Message[] = runOptions.resumeCheckpoint ? [...runOptions.resumeCheckpoint.messages] : [...(runOptions.initialMessages ?? [])];
    const suppliedChangeTracker = runOptions.changeTracker ?? this.options.changeTracker;
    const ownsChangeTracker = !suppliedChangeTracker && this.options.includeRunDiff !== false;
    const changeTracker = this.options.includeRunDiff === false ? undefined : suppliedChangeTracker ?? new RunChangeTracker({
      sessionId: runOptions.sessionId,
      runId: runOptions.runId,
    });
    await changeTracker?.start();
    let completed = false;
    try {
      const result = await this.executeRun(input, messages, changeTracker, runOptions);
      completed = true;
      return result;
    } finally {
      // 外部传入的可复用 Session tracker 由调用方在 Session 生命周期结束时清理。
      if (ownsChangeTracker || !completed) await changeTracker?.dispose();
    }
  }

  private async executeRun(input: string, messages: Message[], changeTracker?: RunChangeTracker, runOptions: AgentRunOptions = {}): Promise<AgentResult> {
    const resumed = runOptions.resumeCheckpoint !== undefined;
    if (!resumed && this.options.systemPrompt && !messages.some((message) => message.role === "system")) {
      messages.push({ role: "system", content: this.options.systemPrompt });
    }
    if (!resumed) messages.push({ role: "user", content: input });

    const replayToolResults = new Map(runOptions.replayToolResults);
    for (const result of runOptions.resumeCheckpoint?.toolResults ?? []) replayToolResults.set(result.key, result.result);
    let step = resumed ? runOptions.resumeCheckpoint!.step : 1;
    if (resumed && runOptions.resumeCheckpoint!.phase === "model") {
      const assistant = [...messages].reverse().find((message): message is Extract<Message, { role: "assistant" }> => message.role === "assistant");
      if (!assistant?.toolCalls?.length) throw new Error("Checkpoint model phase has no resumable tool calls");
      await this.executePendingCalls(assistant.toolCalls, messages, step, changeTracker, runOptions, replayToolResults);
      step += 1;
    } else if (resumed && runOptions.resumeCheckpoint!.phase === "tool") {
      const assistantIndex = messages.map((message) => message.role).lastIndexOf("assistant");
      const assistant = messages[assistantIndex] as Extract<Message, { role: "assistant" }> | undefined;
      const resolved = new Set(messages.slice(assistantIndex + 1).filter((message): message is Extract<Message, { role: "tool" }> => message.role === "tool").map((message) => message.toolCallId));
      const pending = assistant?.toolCalls?.filter((call) => !resolved.has(call.id)) ?? [];
      if (pending.length) await this.executePendingCalls(pending, messages, step, changeTracker, runOptions, replayToolResults);
      step += 1;
    }

    for (; step <= this.options.maxSteps; step += 1) {
      /** 每轮开始前检查取消信号，避免停止后的运行启动新的模型或工具操作。 */
      this.options.signal?.throwIfAborted();
      await this.emit({ type: "model_started", step });
      let response: ModelResponse;
      try {
        // input 已在 executeRun 开头写入完整 transcript；这里仅生成其模型视图，避免重复追加。
        const context = await this.contextManager.compact(messages, this.options.contextBudget ?? { maxInputTokens: Number.MAX_SAFE_INTEGER });
        response = await this.model.generate({
          messages: context.messages,
          tools: this.tools.listModelDefinitions(),
          signal: this.options.signal,
          contextResult: context,
        });
        if (response.usage) this.contextManager.observeUsage?.(context, response.usage);
      } catch (error) {
        await this.emit({ type: "run_failed", error: error instanceof Error ? error.message : String(error) });
        throw error;
      }
      /** 保留原始工具调用，下一轮 provider 才能正确关联对应的 tool result。 */
      messages.push(response.message);
      await checkpoint(runOptions, step, "model", messages, []);

      const calls = response.message.toolCalls ?? [];
      if (calls.length === 0) {
        const result = {
          finalText: response.message.content,
          messages: [...messages],
          steps: step,
          stopReason: "completed",
          ...(changeTracker ? { diff: await changeTracker.finish() } : {}),
        } as const;
        await this.emit({ type: "run_finished", steps: result.steps, stopReason: result.stopReason });
        return result;
      }

      await this.executePendingCalls(calls, messages, step, changeTracker, runOptions, replayToolResults);
    }

    const result = {
      finalText: "",
      messages: [...messages],
      steps: this.options.maxSteps,
      stopReason: "max_steps",
      ...(changeTracker ? { diff: await changeTracker.finish() } : {}),
    } as const;
    await this.emit({ type: "run_finished", steps: result.steps, stopReason: result.stopReason });
    return result;
  }

  private async executePendingCalls(calls: readonly ToolCall[], messages: Message[], step: number, changeTracker: RunChangeTracker | undefined, runOptions: AgentRunOptions, replayToolResults: ReadonlyMap<string, string>): Promise<void> {
    for (const call of calls) {
      await this.emit({ type: "tool_requested", step, toolName: call.name, toolCallId: call.id });
      const key = `${runOptions.runId ?? "run"}:${step}:${call.id}`;
      const cached = replayToolResults.get(key);
      const toolMessage = cached === undefined
        ? await this.executeToolCall(call, messages, step, changeTracker, runOptions)
        : { role: "tool", content: cached, toolCallId: call.id, toolName: call.name } as const;
      messages.push(toolMessage);
      await checkpoint(runOptions, step, "tool", messages, [{ key, toolCallId: call.id, toolName: call.name, status: "completed", result: toolMessage.content }]);
    }
  }

  /** 执行单个工具调用，并把成功或失败结果转换为工具消息。 */
  private async executeToolCall(call: ToolCall, messages: readonly Message[], step: number, changeTracker?: RunChangeTracker, runOptions: AgentRunOptions = {}): Promise<Message> {
    try {
      const result = await this.tools.execute(call.name, call.input, {
        messages,
        signal: this.options.signal,
        changeTracker,
        sessionId: runOptions.sessionId,
        runId: runOptions.runId,
        toolOutputStore: this.toolOutputStore,
      });
      await this.emit({ type: "tool_completed", step, toolName: call.name, toolCallId: call.id });
      return {
        role: "tool",
        content: await this.serializeToolResult(result, runOptions),
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

  async exportContextCheckpoint(sessionId: string, messages: readonly Message[], budget?: import("./types.ts").ContextBudget): Promise<import("./types.ts").ContextCheckpoint | undefined> {
    return this.contextManager.exportCheckpoint?.(sessionId, messages, budget);
  }

  restoreContextCheckpoint(checkpoint: import("./types.ts").ContextCheckpoint, messages: readonly Message[]): boolean {
    return this.contextManager.restoreCheckpoint?.(checkpoint, messages) ?? false;
  }

  private async serializeToolResult(result: unknown, runOptions: AgentRunOptions): Promise<string> {
    const content = serializeToolResult(result);
    if (content.length <= this.toolOutputStore.maxPreviewCharacters) return content;
    // 仅当引用实际出现时才公开读取工具，保持普通请求的工具清单稳定。
    if (!this.tools.get("read_tool_output")) this.tools.register(createToolOutputReadTool(this.toolOutputStore));
    return (await this.toolOutputStore.save(runOptions.sessionId, runOptions.runId, content)).message;
  }

  /** 将运行事件交给调用方观察器。 */
  private async emit(event: Parameters<NonNullable<AgentOptions["onEvent"]>>[0]): Promise<void> {
    await this.options.onEvent?.(event);
  }
}

async function checkpoint(runOptions: AgentRunOptions, step: number, phase: "model" | "tool", messages: readonly Message[], toolResults: readonly { key: string; toolCallId: string; toolName: string; status: "completed" | "failed"; result: string }[]): Promise<void> {
  if (!runOptions.checkpoint || !runOptions.sessionId || !runOptions.runId) return;
  await runOptions.checkpoint.save({ sessionId: runOptions.sessionId, runId: runOptions.runId, step, phase, messages: [...messages], toolResults, updatedAt: new Date().toISOString() });
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
