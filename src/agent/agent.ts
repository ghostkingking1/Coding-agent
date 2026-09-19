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
  ModelStreamEvent,
  AuditEvent,
  VerificationEvidence,
} from "./types.ts";
import { ModelTransportError } from "../model/errors.ts";
import { TaskStateMachine } from "./task-state-machine.ts";
import crypto from "node:crypto";

const DEFAULT_MAX_STEPS = 8;
/** 未配置模型容量时采用保守上限；调用方可按 provider 的真实输入容量显式覆盖。 */
const DEFAULT_CONTEXT_BUDGET = { maxInputTokens: 32_000 } as const;

interface ToolExecutionOutcome {
  readonly key: string;
  readonly message: Extract<Message, { role: "tool" }>;
  readonly succeeded: boolean;
  readonly rawResult?: unknown;
}

/** 驱动模型、工具和消息上下文之间多轮交互的 Agent 执行器。 */
export class Agent {
  private readonly model: ModelClient;
  private readonly tools: ToolRegistry;
  private readonly options: Required<Pick<AgentOptions, "maxSteps" | "maxConcurrentToolCalls">> & Omit<AgentOptions, "maxSteps" | "maxConcurrentToolCalls">;
  private readonly contextManager: import("./types.ts").ContextManager;
  private readonly toolOutputStore: ToolOutputStore;

  /** 创建 Agent，并把最大步数归一化为每次运行共享的上限。 */
  constructor(model: ModelClient, tools = new ToolRegistry(), options: AgentOptions = {}) {
    const maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS;
    if (!Number.isInteger(maxSteps) || maxSteps < 1) {
      throw new Error("maxSteps must be a positive integer");
    }
    const maxConcurrentToolCalls = options.maxConcurrentToolCalls ?? 4;
    if (!Number.isInteger(maxConcurrentToolCalls) || maxConcurrentToolCalls < 1) throw new Error("maxConcurrentToolCalls must be a positive integer");
    /** 统一保存配置，确保每次运行都遵守同一个有限循环上限。 */
    this.model = model;
    this.tools = tools;
    this.options = { ...options, maxSteps, maxConcurrentToolCalls };
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
    await runOptions.gitChangeTracker?.start();
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
    const verification = this.options.verification?.mode === "coding"
      ? new TaskStateMachine(this.options.verification, (from, to, reason) => this.emit({ type: "task_state_changed", from, to, reason }))
      : undefined;
    await verification?.start();
    const resumed = runOptions.resumeCheckpoint !== undefined;
    if (!resumed && this.options.systemPrompt && !messages.some((message) => message.role === "system")) {
      messages.push({ role: "system", content: this.options.systemPrompt });
    }
    if (!resumed && this.options.skillContext) {
      const skillContext = await this.options.skillContext(input);
      if (skillContext) messages.push({ role: "system", content: skillContext });
    }
    if (!resumed) messages.push({ role: "user", content: input });

    const replayToolResults = new Map(runOptions.replayToolResults);
    for (const result of runOptions.resumeCheckpoint?.toolResults ?? []) replayToolResults.set(result.key, result.result);
    let step = resumed ? runOptions.resumeCheckpoint!.step : 1;
    if (resumed && runOptions.resumeCheckpoint!.phase === "model") {
      const assistant = [...messages].reverse().find((message): message is Extract<Message, { role: "assistant" }> => message.role === "assistant");
      if (!assistant?.toolCalls?.length) throw new Error("Checkpoint model phase has no resumable tool calls");
      await this.executePendingCalls(assistant.toolCalls, messages, step, changeTracker, runOptions, replayToolResults, verification);
      step += 1;
    } else if (resumed && runOptions.resumeCheckpoint!.phase === "tool") {
      const assistantIndex = messages.map((message) => message.role).lastIndexOf("assistant");
      const assistant = messages[assistantIndex] as Extract<Message, { role: "assistant" }> | undefined;
      const resolved = new Set(messages.slice(assistantIndex + 1).filter((message): message is Extract<Message, { role: "tool" }> => message.role === "tool").map((message) => message.toolCallId));
      const pending = assistant?.toolCalls?.filter((call) => !resolved.has(call.id)) ?? [];
      if (pending.length) await this.executePendingCalls(pending, messages, step, changeTracker, runOptions, replayToolResults, verification);
      step += 1;
    }

    for (; step <= this.options.maxSteps; step += 1) {
      /** 每轮开始前检查取消信号，避免停止后的运行启动新的模型或工具操作。 */
      this.options.signal?.throwIfAborted();
      await verification?.beginWork();
      await this.emit({ type: "model_started", step });
      let response: ModelResponse;
      try {
        // 门禁提示只存在于本次模型视图，不写入 canonical transcript，避免污染 Session 恢复上下文。
        const modelMessages: Message[] = verification?.requiresVerification
          ? [...messages, { role: "system", content: "The workspace was modified, but verification has not passed. You must call run_tests before completing this task." }]
          : messages;
        const context = await this.contextManager.compact(modelMessages, this.options.contextBudget ?? DEFAULT_CONTEXT_BUDGET);
        const request = {
          messages: context.messages,
          tools: this.tools.listModelDefinitions(),
          signal: this.options.signal,
          contextResult: context,
        } as const;
        response = await this.generateWithRetry(request, step, { ...runOptions, auditSink: runOptions.auditSink ?? this.options.auditSink });
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
        if (verification?.requiresVerification) {
          await verification.noteVerificationRequired();
          if (!verification.isBlocked) continue;
          return await this.finishResult(response.message.content, messages, step, "blocked", verification, changeTracker, runOptions);
        }
        await verification?.complete();
        return await this.finishResult(response.message.content, messages, step, "completed", verification, changeTracker, runOptions);
      }

      await this.executePendingCalls(calls, messages, step, changeTracker, runOptions, replayToolResults, verification);
      if (verification?.isBlocked) return await this.finishResult(response.message.content, messages, step, "blocked", verification, changeTracker, runOptions);
    }

    if (verification?.requiresVerification) await verification.block("maximum model steps reached before verification");
    const stopReason = verification?.isBlocked ? "blocked" : "max_steps";
    return await this.finishResult("", messages, this.options.maxSteps, stopReason, verification, changeTracker, runOptions);
  }

  private async finishResult(finalText: string, messages: readonly Message[], steps: number, stopReason: AgentResult["stopReason"], verification: TaskStateMachine | undefined, changeTracker: RunChangeTracker | undefined, runOptions: AgentRunOptions): Promise<AgentResult> {
    const diff = changeTracker ? await changeTracker.finish() : undefined;
    const result = {
      finalText,
      messages: [...messages],
      steps,
      stopReason,
      taskState: verification?.state ?? (stopReason === "completed" ? "completed" : "working"),
      verification: verification?.summary() ?? { required: false, writeObserved: false, status: "not_required", verificationPassed: false, verificationAttempts: 0, repairAttempts: 0, evidence: [] },
      ...(diff ? { diff } : {}),
      ...(runOptions.gitChangeTracker ? { gitChanges: await runOptions.gitChangeTracker.finish(diff) } : {}),
    } as const;
    await this.emit({ type: "run_finished", steps: result.steps, stopReason: result.stopReason });
    return result;
  }

  private async generateWithRetry(request: Parameters<ModelClient["generate"]>[0], step: number, runOptions: AgentRunOptions): Promise<ModelResponse> {
    const retry = this.options.retry ?? {};
    const maxAttempts = retry.maxAttempts ?? 3;
    const totalMs = retry.maxTotalMs ?? 60_000;
    const initial = retry.initialBackoffMs ?? 250;
    const maxBackoff = retry.maxBackoffMs ?? 4_000;
    const started = Date.now();
    for (let attempt = 1; ; attempt += 1) {
      await this.audit({ sessionId: runOptions.sessionId, runId: runOptions.runId, eventType: "model_attempt", step, attempt }, runOptions.auditSink ?? this.options.auditSink);
      try {
        if (this.model.generateStream) return await this.collectStream(request, step, runOptions);
        return await this.model.generate(request);
      } catch (error) {
        const code = error instanceof ModelTransportError ? error.code : "unknown";
        const retryable = error instanceof ModelTransportError && ["timeout", "network", "rate_limited", "server_error"].includes(error.code);
        if (!retryable || attempt >= maxAttempts || Date.now() - started >= totalMs) throw error;
        const delayMs = Math.min(maxBackoff, error.retryAfterMs ?? initial * 2 ** (attempt - 1));
        await this.emit({ type: "model_retry", step, attempt, errorCode: code, delayMs });
        await this.audit({ sessionId: runOptions.sessionId, runId: runOptions.runId, eventType: "model_retry", step, attempt, errorCode: code, metadata: { delayMs } }, runOptions.auditSink ?? this.options.auditSink);
        await (retry.sleep ?? defaultSleep)(delayMs, this.options.signal);
      }
    }
  }

  private async collectStream(request: Parameters<ModelClient["generate"]>[0], step: number, runOptions: AgentRunOptions): Promise<ModelResponse> {
    let content = "";
    const calls = new Map<number, { id: string; name: string; args: string }>();
    let finishReason: ModelResponse["finishReason"];
    let usage: ModelResponse["usage"];
    for await (const event of this.model.generateStream!(request)) {
      if (event.type === "text_delta") { content += event.text; await this.emit({ type: "model_delta", step, text: event.text }); }
      else if (event.type === "tool_call_delta") { const current = calls.get(event.index) ?? { id: event.id ?? `call_${event.index}`, name: event.name ?? "", args: "" }; calls.set(event.index, { id: event.id ?? current.id, name: event.name ?? current.name, args: current.args + (event.argumentsDelta ?? "") }); }
      else if (event.type === "usage") usage = event.usage;
      else if (event.type === "done") finishReason = event.finishReason;
    }
    const toolCalls = [...calls.entries()].sort(([a], [b]) => a - b).map(([, call]) => ({ id: call.id, name: call.name, input: parseStreamArguments(call.args) }));
    await this.audit({ sessionId: runOptions.sessionId, runId: runOptions.runId, eventType: "model_finished", step, status: "streamed" }, runOptions.auditSink ?? this.options.auditSink);
    return { message: { role: "assistant", content, ...(toolCalls.length ? { toolCalls } : {}) }, finishReason, usage };
  }

  private async audit(event: AuditEvent, sink = this.options.auditSink): Promise<void> { await sink?.record(event); }

  private async executePendingCalls(calls: readonly ToolCall[], messages: Message[], step: number, changeTracker: RunChangeTracker | undefined, runOptions: AgentRunOptions, replayToolResults: ReadonlyMap<string, string>, verification?: TaskStateMachine): Promise<void> {
    const batchId = `${runOptions.runId ?? "run"}:${step}`;
    const parallelCount = calls.filter((call) => this.isParallelizable(call)).length;
    await this.emit({ type: "tool_batch_started", step, batchId, toolCallCount: calls.length, parallelCount });
    await this.audit({ sessionId: runOptions.sessionId, runId: runOptions.runId, eventType: "tool_batch_started", step, metadata: { toolCallCount: calls.length, parallelCount } }, runOptions.auditSink ?? this.options.auditSink);
    const results = await this.executeToolBatch(calls, messages, step, changeTracker, runOptions, replayToolResults);
    messages.push(...results.map(({ message }) => message));
    for (const result of results) {
      if (!verification || !result.succeeded) {
        if (verification && !result.succeeded && this.tools.get(result.message.toolName)?.manifest?.verification) {
          await verification.observeVerification(result.message.toolName, failedVerificationEvidence(result.message.toolName));
        }
        continue;
      }
      const manifest = this.tools.get(result.message.toolName)?.manifest;
      if (manifest?.capabilities.includes("write")) await verification.observeWrite(result.message.toolName);
      if (manifest?.verification) {
        let evidence: VerificationEvidence;
        try {
          evidence = manifest.verification.toEvidence?.(result.rawResult, result.message.toolName)
            ?? legacyVerificationEvidence(result.message.toolName, manifest.verification.isSuccessful(result.rawResult));
        } catch {
          evidence = failedVerificationEvidence(result.message.toolName, "verification result could not be evaluated");
        }
        await verification.observeVerification(result.message.toolName, evidence);
        await this.audit({
          sessionId: runOptions.sessionId,
          runId: runOptions.runId,
          eventType: "verification_evidence_recorded",
          step,
          toolName: result.message.toolName,
          status: evidence.status,
          metadata: {
            evidenceId: evidence.evidenceId,
            reason: evidence.reason,
            ...(evidence.commandDigest ? { commandDigest: evidence.commandDigest } : {}),
            ...(evidence.policyDigest ? { policyDigest: evidence.policyDigest } : {}),
          },
        }, runOptions.auditSink ?? this.options.auditSink);
      }
    }
    await checkpoint(runOptions, step, "tool", messages, results.map(({ key, message }) => ({ key, toolCallId: message.toolCallId, toolName: message.toolName, status: isToolErrorMessage(message) ? "failed" : "completed", result: message.content })));
    const failed = results.filter(({ message }) => isToolErrorMessage(message)).length;
    await this.emit({ type: "tool_batch_finished", step, batchId, succeeded: results.length - failed, failed });
    await this.audit({ sessionId: runOptions.sessionId, runId: runOptions.runId, eventType: "tool_batch_finished", step, status: failed ? "partial_failure" : "completed", metadata: { succeeded: results.length - failed, failed } }, runOptions.auditSink ?? this.options.auditSink);
  }

  private async executeToolBatch(calls: readonly ToolCall[], messages: readonly Message[], step: number, changeTracker: RunChangeTracker | undefined, runOptions: AgentRunOptions, replayToolResults: ReadonlyMap<string, string>): Promise<readonly ToolExecutionOutcome[]> {
    const results: ToolExecutionOutcome[] = [];
    let wave: ToolCall[] = [];
    const flush = async () => {
      if (wave.length === 0) return;
      const current = wave;
      wave = [];
      const values = await Promise.all(current.map((call) => this.executeOnePendingCall(call, messages, step, changeTracker, runOptions, replayToolResults)));
      results.push(...values);
    };
    for (const call of calls) {
      if (!this.isParallelizable(call) || wave.length >= this.options.maxConcurrentToolCalls || this.conflicts(call, wave)) {
        await flush();
        if (!this.isParallelizable(call)) {
          results.push(await this.executeOnePendingCall(call, messages, step, changeTracker, runOptions, replayToolResults));
          continue;
        }
      }
      wave.push(call);
    }
    await flush();
    return calls.map((call) => results.find((result) => result.message.toolCallId === call.id)!).filter(Boolean);
  }

  private async executeOnePendingCall(call: ToolCall, messages: readonly Message[], step: number, changeTracker: RunChangeTracker | undefined, runOptions: AgentRunOptions, replayToolResults: ReadonlyMap<string, string>): Promise<ToolExecutionOutcome> {
    await this.emit({ type: "tool_requested", step, toolName: call.name, toolCallId: call.id });
    const key = `${runOptions.runId ?? "run"}:${step}:${call.id}`;
    const cached = replayToolResults.get(key);
    if (cached !== undefined) {
      const message = { role: "tool", content: cached, toolCallId: call.id, toolName: call.name } as const;
      return { key, message, succeeded: !isToolErrorMessage(message), rawResult: parseCachedToolResult(cached) };
    }
    return { key, ...(await this.executeToolCall(call, messages, step, changeTracker, runOptions)) };
  }

  private isParallelizable(call: ToolCall): boolean { return this.tools.get(call.name)?.manifest?.parallelizable === true; }
  private conflicts(call: ToolCall, wave: readonly ToolCall[]): boolean {
    const tool = this.tools.get(call.name);
    if (!tool?.manifest?.conflictKey) return false;
    let key: string | undefined;
    try { key = tool.manifest.conflictKey(call.input); } catch { return false; }
    return key !== undefined && wave.some((other) => {
      try { return this.tools.get(other.name)?.manifest?.conflictKey?.(other.input) === key; } catch { return false; }
    });
  }

  /** 执行单个工具调用，并保留原始结果供验证器判断。 */
  private async executeToolCall(call: ToolCall, messages: readonly Message[], step: number, changeTracker?: RunChangeTracker, runOptions: AgentRunOptions = {}): Promise<Omit<ToolExecutionOutcome, "key">> {
    try {
      const result = await this.tools.execute(call.name, call.input, {
        messages,
        signal: this.options.signal,
        changeTracker,
        sessionId: runOptions.sessionId,
        runId: runOptions.runId,
        toolOutputStore: this.toolOutputStore,
        auditSink: runOptions.auditSink ?? this.options.auditSink,
      });
      await this.emit({ type: "tool_completed", step, toolName: call.name, toolCallId: call.id });
      await this.audit({ sessionId: runOptions.sessionId, runId: runOptions.runId, eventType: "tool_call", step, toolCallId: call.id, toolName: call.name, status: "completed" }, runOptions.auditSink ?? this.options.auditSink);
      return {
        message: { role: "tool", content: await this.serializeToolResult(result, runOptions), toolCallId: call.id, toolName: call.name },
        succeeded: true,
        rawResult: result,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.emit({ type: "tool_failed", step, toolName: call.name, toolCallId: call.id, error: message });
      await this.audit({ sessionId: runOptions.sessionId, runId: runOptions.runId, eventType: "tool_call", step, toolCallId: call.id, toolName: call.name, status: "failed", metadata: { error: message.slice(0, 1024) } }, runOptions.auditSink ?? this.options.auditSink);
      return { message: { role: "tool", content: JSON.stringify({ error: message }), toolCallId: call.id, toolName: call.name }, succeeded: false };
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

function legacyVerificationEvidence(toolName: string, passed: boolean): VerificationEvidence {
  return {
    evidenceId: crypto.randomUUID(),
    toolName,
    kind: "test",
    status: passed ? "passed" : "failed",
    reason: passed ? "legacy verifier accepted the result" : "legacy verifier rejected the result",
    recordedAt: new Date().toISOString(),
  };
}

function failedVerificationEvidence(toolName: string, reason = "verification tool execution failed"): VerificationEvidence {
  return { evidenceId: crypto.randomUUID(), toolName, kind: "test", status: "failed", reason, recordedAt: new Date().toISOString() };
}

async function checkpoint(runOptions: AgentRunOptions, step: number, phase: "model" | "tool", messages: readonly Message[], toolResults: readonly { key: string; toolCallId: string; toolName: string; status: "completed" | "failed"; result: string }[]): Promise<void> {
  if (!runOptions.checkpoint || !runOptions.sessionId || !runOptions.runId) return;
  await runOptions.checkpoint.save({ sessionId: runOptions.sessionId, runId: runOptions.runId, step, phase, messages: [...messages], toolResults, updatedAt: new Date().toISOString() });
}

function parseCachedToolResult(content: string): unknown {
  try { return JSON.parse(content) as unknown; } catch { return content; }
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

function parseStreamArguments(value: string): unknown { try { return value ? JSON.parse(value) : {}; } catch { throw new Error("Invalid streamed tool arguments"); } }
async function defaultSleep(milliseconds: number, signal?: AbortSignal): Promise<void> { await new Promise<void>((resolve, reject) => { if (signal?.aborted) return reject(signal.reason ?? new Error("aborted")); const timer = setTimeout(resolve, milliseconds); signal?.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason ?? new Error("aborted")); }, { once: true }); }); }

function isToolErrorMessage(message: Extract<Message, { role: "tool" }>): boolean {
  try {
    const value = JSON.parse(message.content) as unknown;
    return Boolean(value && typeof value === "object" && !Array.isArray(value) && "error" in value && Object.keys(value).length === 1);
  } catch { return false; }
}
