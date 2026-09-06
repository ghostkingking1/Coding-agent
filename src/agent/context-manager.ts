import crypto from "node:crypto";
import type { ContextBudget, ContextCheckpoint, ContextDegradation, ContextManager, ContextResult, ContextStageResult, ContextSummary, Message, ModelUsage } from "./types.ts";

export interface ContextManagerOptions {
  readonly messagesForSession?: (sessionId: string) => readonly Message[];
  readonly summarize?: (messages: readonly Message[]) => Promise<string>;
  readonly recentTurns?: number;
  readonly maxToolOutputTokens?: number;
}

interface IndexedMessage { readonly message: Message; readonly sourceIndexes: readonly number[]; }

/** 只生成模型视图，不修改 Session 中的完整 transcript。 */
export class DefaultContextManager implements ContextManager {
  private readonly options: ContextManagerOptions;
  private calibrationFactor = 1;
  /** 摘要按完整源消息指纹缓存；同一历史前缀在后续请求中绝不重复摘要。 */
  private readonly summaryCache = new Map<string, string>();
  private readonly restoredSegments = new Map<string, readonly ContextSummary[]>();
  constructor(options: ContextManagerOptions = {}) { this.options = options; }

  estimate(messages: readonly Message[]): number {
    return Math.ceil(this.rawEstimate(messages) * this.calibrationFactor);
  }

  /** 用 provider 返回的真实输入 token 校正后续请求；缺失 usage 时保持启发式估算。 */
  observeUsage(context: ContextResult, usage: ModelUsage): void {
    if (!Number.isFinite(usage.inputTokens) || usage.inputTokens < 1 || context.rawEstimatedTokens < 1) return;
    const observedRatio = usage.inputTokens / context.rawEstimatedTokens;
    // 低估会导致下一次请求越过 provider 上限，因此向上修正立即生效；只有实际持续较小时才缓慢回落。
    const safeRatio = Math.min(2.5, Math.max(0.75, observedRatio * 1.05));
    this.calibrationFactor = safeRatio >= this.calibrationFactor
      ? safeRatio
      : Math.max(0.75, this.calibrationFactor * 0.8 + safeRatio * 0.2);
  }

  private rawEstimate(messages: readonly Message[]): number {
    return messages.reduce((total, message) => {
      const calls = message.role === "assistant" && message.toolCalls ? JSON.stringify(message.toolCalls).length : 0;
      return total + Math.ceil((message.content.length + calls) / 4) + 4;
    }, 0);
  }

  async buildRequestContext(sessionId: string, input: string): Promise<readonly Message[]> {
    const source = [...(this.options.messagesForSession?.(sessionId) ?? []), { role: "user", content: input } as const];
    return (await this.compact(source, { maxInputTokens: 32_000, recentTurns: this.options.recentTurns ?? 10, maxToolOutputTokens: this.options.maxToolOutputTokens ?? 4_000 })).messages;
  }

  async compact(messages: readonly Message[], budget: number | ContextBudget): Promise<ContextResult> {
    const limit = typeof budget === "number" ? budget : budget.maxInputTokens;
    const compactLimit = typeof budget === "number" ? limit : Math.max(1, Math.floor(limit * (budget.compactThresholdRatio ?? 1)));
    if (!Number.isInteger(limit) || limit < 1) throw new Error("context budget must be a positive integer");
    const indexed = messages.map((message, sourceIndex) => ({ message: cloneMessage(message), sourceIndexes: [sourceIndex] }));
    const system = indexed.filter(({ message }) => message.role === "system");
    const currentUser = [...indexed].reverse().find(({ message }) => message.role === "user");
    if (system.length > 0 && this.estimate(toMessages(system)) > limit) throw new Error("System prompt exceeds the configured context budget");
    if (currentUser && this.estimate([currentUser.message]) > limit) throw new Error("Current request exceeds the configured context budget");

    let view: IndexedMessage[] = indexed;
    const stages: ContextStageResult[] = [];
    const summaries: ContextSummary[] = [];
    let degradation: ContextDegradation | undefined;
    const toolLimit = typeof budget === "number" ? 4_000 : budget.maxToolOutputTokens ?? 4_000;
    view = view.map((entry) => {
      if (entry.message.role !== "tool" || this.estimate([entry.message]) <= toolLimit) return entry;
      degradation = "tool_output_truncated";
      const retainedChars = Math.max(32, toolLimit * 2 - 34);
      const head = Math.ceil(retainedChars / 2);
      const tail = Math.floor(retainedChars / 2);
      return { ...entry, message: { ...entry.message, content: `${entry.message.content.slice(0, head)}\n...[tool output truncated]...\n${entry.message.content.slice(-tail)}` } };
    });
    stages.push({ name: "budget_reduction", estimatedTokens: this.estimate(toMessages(view)) });
    view = view.map((entry) => entry.message.role === "tool" ? { ...entry, message: { ...entry.message, content: snip(entry.message.content) } } : entry);
    stages.push({ name: "snip", estimatedTokens: this.estimate(toMessages(view)) });
    if (this.estimate(toMessages(view)) <= compactLimit) return this.result(view, limit, messages, stages, summaries, degradation);

    const currentTurn = turnNumber(view, currentUser?.sourceIndexes[0]);
    const collapsed = collapseHistoricalToolChains(view, currentTurn);
    if (collapsed.changed) degradation = "context_collapsed";
    view = collapsed.messages;
    stages.push({ name: "context_collapse", estimatedTokens: this.estimate(toMessages(view)) });
    if (this.estimate(toMessages(view)) <= compactLimit) return this.result(view, limit, messages, stages, summaries, degradation);

    const recentTurns = typeof budget === "number" ? 10 : budget.recentTurns ?? 10;
    const retained = retainRecentTurnEntries(view, recentTurns, currentUser?.sourceIndexes[0]);
    const retainedIndexes = new Set(retained.flatMap(({ sourceIndexes }) => sourceIndexes));
    const dropped = view.filter(({ message, sourceIndexes }) => message.role !== "system" && !sourceIndexes.some((index) => retainedIndexes.has(index)));
    if (dropped.length > 0) {
      const summaryContent = await this.makeSummary(dropped.map(({ message }) => message));
      const summary: ContextSummary = { summaryId: `sum_${crypto.randomUUID()}`, sourceMessageIndexes: dropped.flatMap(({ sourceIndexes }) => sourceIndexes), content: summaryContent };
      summaries.push(summary);
      view = insertSummary(system, retained, { sourceIndexes: dropped.flatMap(({ sourceIndexes }) => sourceIndexes), message: { role: "assistant", content: `[历史摘要 ${summary.summaryId}]\n${summaryContent}` } });
      view = shrinkSummary(view, limit, (entries) => this.estimate(toMessages(entries)));
      degradation = "old_messages_summarized";
    }
    stages.push({ name: "auto_compact", estimatedTokens: this.estimate(toMessages(view)) });
    if (this.estimate(toMessages(view)) > limit) {
      // 摘要已覆盖全部旧轮次；最终视图只保留系统提示、摘要和当前轮次。
      const summaryEntries = view.filter(({ message }) => message.role === "system" || (message.role === "assistant" && message.content.startsWith("[历史摘要 ")));
      const currentEntries = retainRecentTurnEntries(view, 1, currentUser?.sourceIndexes[0]).filter(({ message }) => message.role !== "system");
      view = shrinkSummary([...summaryEntries, ...currentEntries], limit, (entries) => this.estimate(toMessages(entries)));
    }
    if (this.estimate(toMessages(view)) > limit) throw new Error("Context exceeds the configured budget after compaction");
    return this.result(view, limit, messages, stages, summaries, degradation);
  }

  private result(view: readonly IndexedMessage[], budget: number, original: readonly Message[], stages: readonly ContextStageResult[], summaries: readonly ContextSummary[], degradation?: ContextDegradation): ContextResult {
    const output = toMessages(view);
    return {
      messages: output,
      estimatedTokens: this.estimate(output),
      rawEstimatedTokens: this.rawEstimate(output),
      calibrationFactor: this.calibrationFactor,
      budget,
      compacted: this.estimate(output) < this.estimate(original),
      stages,
      summaries,
      ...(degradation ? { degradation } : {}),
    };
  }

  private async makeSummary(messages: readonly Message[]): Promise<string> {
    const key = summaryKey(messages);
    const cached = this.summaryCache.get(key);
    if (cached !== undefined) return cached;
    let summary: string | undefined;
    try { if (this.options.summarize) summary = await this.options.summarize(messages); } catch { /* 摘要服务失败时使用本地确定性摘要。 */ }
    summary ??= messages.map((message) => `${message.role}: ${message.content.slice(0, 240)}`).join("\n");
    this.summaryCache.set(key, summary);
    return summary;
  }

  async exportCheckpoint(sessionId: string, messages: readonly Message[], budget: ContextBudget = { maxInputTokens: 32_000, recentTurns: this.options.recentTurns ?? 10, maxToolOutputTokens: this.options.maxToolOutputTokens ?? 4_000 }): Promise<ContextCheckpoint | undefined> {
    const result = await this.compact(messages, budget);
    if (result.summaries.length === 0) return undefined;
    const coveredThroughSequence = Math.max(...result.summaries.flatMap((summary) => summary.sourceMessageIndexes));
    const previous = this.restoredSegments.get(sessionId) ?? [];
    const segments = [...previous, ...result.summaries].filter((segment, index, all) => all.findIndex((candidate) => candidate.summaryId === segment.summaryId || JSON.stringify(candidate.sourceMessageIndexes) === JSON.stringify(segment.sourceMessageIndexes)) === index);
    const checkpoint: ContextCheckpoint = { sessionId, coveredThroughSequence, sourcePrefixHash: prefixHash(messages, coveredThroughSequence), summarySegments: segments, retainedTailStart: coveredThroughSequence + 1, updatedAt: new Date().toISOString() };
    this.restoredSegments.set(sessionId, checkpoint.summarySegments);
    return checkpoint;
  }

  restoreCheckpoint(checkpoint: ContextCheckpoint, messages: readonly Message[]): boolean {
    if (checkpoint.coveredThroughSequence >= messages.length || prefixHash(messages, checkpoint.coveredThroughSequence) !== checkpoint.sourcePrefixHash) return false;
    for (const segment of checkpoint.summarySegments) {
      const source = segment.sourceMessageIndexes.map((index) => messages[index]).filter((message): message is Message => message !== undefined);
      if (source.length === segment.sourceMessageIndexes.length) this.summaryCache.set(summaryKey(source), segment.content);
    }
    this.restoredSegments.set(checkpoint.sessionId, checkpoint.summarySegments);
    return true;
  }
}

function summaryKey(messages: readonly Message[]): string {
  return crypto.createHash("sha256").update(JSON.stringify(messages)).digest("hex");
}
function prefixHash(messages: readonly Message[], sequence: number): string { return crypto.createHash("sha256").update(JSON.stringify(messages.slice(0, sequence + 1))).digest("hex"); }

function cloneMessage(message: Message): Message {
  if (message.role === "assistant") return { ...message, ...(message.toolCalls ? { toolCalls: message.toolCalls.map((call) => ({ ...call })) } : {}) };
  return { ...message };
}
function toMessages(entries: readonly IndexedMessage[]): Message[] { return entries.map(({ message }) => message); }
function snip(content: string): string { return content.replace(/\n{3,}/g, "\n\n").replace(/^(.*\n)\1{2,}/gm, "$1"); }

function turnNumber(entries: readonly IndexedMessage[], sourceIndex: number | undefined): number {
  if (sourceIndex === undefined) return Number.MAX_SAFE_INTEGER;
  let turn = 0;
  for (const entry of entries) { if (entry.sourceIndexes[0] > sourceIndex) break; if (entry.message.role === "user") turn += 1; }
  return turn;
}

function retainRecentTurnEntries(entries: readonly IndexedMessage[], count: number, currentSourceIndex: number | undefined): IndexedMessage[] {
  if (count < 1) return currentSourceIndex === undefined ? [] : entries.filter(({ sourceIndexes }) => sourceIndexes.includes(currentSourceIndex));
  const currentTurn = turnNumber(entries, currentSourceIndex);
  const firstTurn = Math.max(1, currentTurn - count + 1);
  return entries.filter((entry) => entry.message.role === "system" || turnNumber(entries, entry.sourceIndexes[0]) >= firstTurn);
}

function collapseHistoricalToolChains(entries: readonly IndexedMessage[], currentTurn: number): { messages: IndexedMessage[]; changed: boolean } {
  const result: IndexedMessage[] = [];
  let changed = false;
  for (let index = 0; index < entries.length;) {
    const first = entries[index];
    if (first.message.role !== "assistant" || !first.message.toolCalls?.length || turnNumber(entries, first.sourceIndexes[0]) >= currentTurn) { result.push(first); index += 1; continue; }
    const calls = first.message.toolCalls;
    const expected = new Set(calls.map((call) => call.id));
    const results: IndexedMessage[] = [];
    let end = index + 1;
    while (end < entries.length && entries[end].message.role === "tool") { results.push(entries[end]); end += 1; }
    const actual = new Set(results.map((entry) => entry.message.role === "tool" ? entry.message.toolCallId : ""));
    const complete = results.length === calls.length && actual.size === expected.size && [...expected].every((id) => actual.has(id));
    if (complete) {
      const names = calls.map((call) => call.name);
      const details = results.map((entry) => entry.message.role === "tool" && /^\s*\{\s*[\"']?error/.test(entry.message.content) ? "failed" : "ok");
      result.push({ sourceIndexes: entries.slice(index, end).flatMap(({ sourceIndexes }) => sourceIndexes), message: { role: "assistant", content: `[连续工具批次已折叠] ${names.join(", ")} (${details.join(", ")})` } });
      changed = true;
      index = end;
    } else { result.push(first); index += 1; }
  }
  return { messages: result, changed };
}

function insertSummary(system: readonly IndexedMessage[], retained: readonly IndexedMessage[], summary: IndexedMessage): IndexedMessage[] {
  const body = retained.filter(({ message }) => message.role !== "system");
  const insertAt = body.findIndex(({ sourceIndexes }) => sourceIndexes[0] > summary.sourceIndexes[0]);
  const ordered = insertAt < 0 ? [...body, summary] : [...body.slice(0, insertAt), summary, ...body.slice(insertAt)];
  return [...system, ...ordered];
}

function shrinkSummary(entries: readonly IndexedMessage[], budget: number, estimate: (entries: readonly IndexedMessage[]) => number): IndexedMessage[] {
  const result = [...entries];
  while (estimate(result) > budget) {
    const index = result.findIndex(({ message }) => message.role === "assistant" && message.content.startsWith("[历史摘要 "));
    if (index < 0) break;
    const entry = result[index];
    if (entry.message.role !== "assistant" || entry.message.content.length <= 32) break;
    result[index] = { ...entry, message: { ...entry.message, content: entry.message.content.slice(0, Math.max(32, Math.floor(entry.message.content.length * 0.75))) } };
  }
  return result;
}
export function createDeterministicContextManager(options: ContextManagerOptions = {}): ContextManager { return new DefaultContextManager(options); }
