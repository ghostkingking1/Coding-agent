import crypto from "node:crypto";
import { Agent } from "./agent.ts";
import type { AgentResult, AgentRunOptions, CheckpointRecord, Message } from "./types.ts";
import { RunChangeTracker } from "./run-diff.ts";
import type { SessionRecord, SessionStore, StoredMessage, StoredRunRecord } from "./session-store.ts";
import { RecoveryPointCoordinator } from "./recovery-point.ts";
import { GitRepository } from "../repository/git.ts";

export type SessionStatus = "active" | "closed";
export type RunStatus = "completed" | "failed" | "interrupted";

export interface RunResult extends AgentResult {
  readonly status: "completed";
  readonly sessionId: string;
  readonly runId: string;
  readonly startedAt: string;
  readonly finishedAt: string;
}

export interface FailedRun {
  readonly sessionId: string;
  readonly runId: string;
  readonly status: "failed" | "interrupted";
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly error: string;
}

export type SessionRun = RunResult | FailedRun;

export interface SessionResult {
  readonly sessionId: string;
  readonly status: SessionStatus;
  readonly messages: readonly Message[];
  readonly runs: readonly SessionRun[];
  readonly finalText: string;
}

export interface SessionOptions {
  readonly sessionId?: string;
  /** 可选的工作区 tracker；Session 会在多个 run 间复用其 baseline。 */
  readonly changeTracker?: RunChangeTracker;
  readonly store?: SessionStore;
  readonly workspaceRoot?: string;
}

  /** 管理多个 Agent run 共享的活动上下文和生命周期；原始消息由 Store 归档。 */
export class Session {
  readonly sessionId: string;
  private readonly agent: Agent;
  private context: Message[] = [];
  private readonly runHistory: SessionRun[] = [];
  private statusValue: SessionStatus = "active";
  private running = false;
  private readonly changeTracker?: RunChangeTracker;
  private readonly store?: SessionStore;
  private readonly workspaceRoot?: string;
  private readonly recoveryCoordinator?: RecoveryPointCoordinator;
  private recoveryEligible = false;
  private persisted = false;
  /** 内存 context 可能已压缩，数据库 sequence 必须独立按完整 transcript 递增。 */
  private persistedMessageCount = 0;
  private readonly ownerId = `pid-${process.pid}-${crypto.randomUUID()}`;
  private resumable?: { readonly run: StoredRunRecord; readonly checkpoint: CheckpointRecord };

  constructor(agent: Agent, options: SessionOptions = {}) {
    this.agent = agent;
    this.sessionId = options.sessionId ?? `sess_${crypto.randomUUID()}`;
    validateId(this.sessionId, "sessionId");
    this.changeTracker = options.changeTracker;
    this.store = options.store;
    this.workspaceRoot = options.workspaceRoot;
    if (this.store && this.workspaceRoot) {
      this.recoveryCoordinator = new RecoveryPointCoordinator(this.store, new GitRepository(this.workspaceRoot));
    }
    if (this.store && !this.workspaceRoot) throw new Error("workspaceRoot is required when a SessionStore is configured");
  }

  /** 创建新会话的持久化记录；恢复会话使用 restore，不会重复插入。 */
  async initialize(): Promise<void> {
    if (!this.store || this.persisted) return;
    await this.store.createSession({ id: this.sessionId, workspaceRoot: this.workspaceRoot!, createdAt: new Date().toISOString() });
    this.persisted = true;
  }

  /** 从已提交记录恢复；未完成 run 已由 SessionManager 标记为 interrupted。 */
  static restore(agent: Agent, input: { readonly record: SessionRecord; readonly store: SessionStore; readonly messages: readonly StoredMessage[]; readonly persistedMessageCount?: number; readonly runs: readonly StoredRunRecord[]; readonly contextCheckpoint?: import("./types.ts").ContextCheckpoint; readonly resumable?: { readonly run: StoredRunRecord; readonly checkpoint: CheckpointRecord } }): Session {
    const session = new Session(agent, { sessionId: input.record.id, store: input.store, workspaceRoot: input.record.workspaceRoot });
    session.context = input.messages.map((message) => message.message);
    session.statusValue = input.record.status;
    session.persisted = true;
    session.persistedMessageCount = input.persistedMessageCount ?? input.messages.length;
    session.runHistory.push(...input.runs.flatMap((run) => toSessionRun(run)));
    if (input.contextCheckpoint) agent.restoreContextCheckpoint(input.contextCheckpoint, session.context);
    session.resumable = input.resumable;
    return session;
  }

  get status(): SessionStatus {
    return this.statusValue;
  }

  get messages(): readonly Message[] {
    return [...this.context];
  }

  get runs(): readonly SessionRun[] {
    return [...this.runHistory];
  }

  /** 清空当前对话上下文；不删除已持久化的运行记录。 */
  clearContext(): void {
    if (this.statusValue === "closed") throw new Error("Session is closed");
    if (this.running) throw new Error("Session has a run in progress");
    this.context = [];
  }

  /** 显式续跑已中断 run；尚未完成的工具仍会经过原审批策略。 */
  async resume(options: { readonly signal?: AbortSignal } = {}): Promise<RunResult> {
    const pending = this.resumable;
    if (!pending) throw new Error("Session has no resumable checkpoint");
    if (this.running) throw new Error("Session already has a run in progress");
    this.running = true;
    this.recoveryEligible = await this.recoveryCoordinator?.canCreate() ?? false;
    let heartbeat: NodeJS.Timeout | undefined;
    try {
      const leaseUntil = new Date(Date.now() + 30_000).toISOString();
      await this.store!.resumeRun(this.sessionId, pending.run.id, this.ownerId, leaseUntil);
      await this.store!.record({ sessionId: this.sessionId, runId: pending.run.id, eventType: "run_resumed" });
      heartbeat = setInterval(() => { void this.store?.heartbeatRun(this.sessionId, pending.run.id, this.ownerId, new Date(Date.now() + 30_000).toISOString()); }, 5_000);
      const result = await this.agent.run(pending.run.input, {
        initialMessages: this.context,
        sessionId: this.sessionId,
        runId: pending.run.id,
        checkpoint: { save: (checkpoint) => this.store!.saveCheckpoint(checkpoint) },
        auditSink: { record: (event) => this.store!.record(event) },
        summaryCache: this.store,
        resumeCheckpoint: pending.checkpoint,
        signal: options.signal,
        persistContext: (messages) => this.persistActiveContext(messages),
      });
      const finishedAt = new Date().toISOString();
      clearInterval(heartbeat);
      const runResult: RunResult = { ...result, status: "completed", sessionId: this.sessionId, runId: pending.run.id, startedAt: pending.run.startedAt, finishedAt };
      const newMessages = (result.transcriptMessages ?? result.messages).slice(this.context.length);
      await this.store!.completeRun({ run: { id: pending.run.id, sessionId: this.sessionId, status: "completed", input: pending.run.input, finalText: result.finalText, startedAt: pending.run.startedAt, finishedAt, result }, messages: newMessages.map((message, index) => ({ sessionId: this.sessionId, runId: pending.run.id, sequence: this.persistedMessageCount + index, message, createdAt: finishedAt })) });
      await this.store!.record({ sessionId: this.sessionId, runId: pending.run.id, eventType: "run_completed" });
      this.persistedMessageCount += newMessages.length;
      this.context = [...result.messages];
      const resumedContextCheckpoint = await this.agent.exportContextCheckpoint(this.sessionId, this.context);
      if (resumedContextCheckpoint) {
        // Transcript 仍按完整消息追加；后续运行只以 checkpoint 的模型视图为内存基线。
        const state = { ...resumedContextCheckpoint, coveredThroughSequence: this.persistedMessageCount - 1, sourceMessageCount: this.persistedMessageCount };
        await this.store!.saveContextCheckpoint(state);
        if (state.resumeMessages) this.context = [...state.resumeMessages];
      }
      await this.recoveryCoordinator?.createForCompletedRun({ sessionId: this.sessionId, runId: pending.run.id, verification: result.verification, eligibleAtStart: this.recoveryEligible });
      this.resumable = undefined;
      this.runHistory.push(runResult);
      return runResult;
    } catch (error) {
      if (heartbeat) clearInterval(heartbeat);
      const interrupted = isAbortError(error, options.signal);
      const finishedAt = new Date().toISOString();
      await this.store!.failRun({ sessionId: this.sessionId, runId: pending.run.id, status: interrupted ? "interrupted" : "failed", error: error instanceof Error ? error.message : String(error), finishedAt });
      await this.store!.record({ sessionId: this.sessionId, runId: pending.run.id, eventType: interrupted ? "run_interrupted" : "run_failed", status: interrupted ? "interrupted" : "failed" });
      if (!interrupted) this.resumable = undefined;
      throw error;
    } finally { this.running = false; }
  }

  /** 顺序执行一次 run；成功后提交活动上下文，并把本轮原始增量写入归档。 */
  async run(input: string, options: Pick<AgentRunOptions, "changeTracker" | "gitChangeTracker" | "signal"> = {}): Promise<RunResult> {
    if (this.statusValue === "closed") throw new Error("Session is closed");
    if (this.running) throw new Error("Session already has a run in progress");
    const runId = `run_${crypto.randomUUID()}`;
    validateId(runId, "runId");
    const startedAt = new Date().toISOString();
    this.running = true;
    let heartbeat: NodeJS.Timeout | undefined;
    try {
      await this.initialize();
      const leaseUntil = new Date(Date.now() + 30_000).toISOString();
      await this.store?.startRun({ id: runId, sessionId: this.sessionId, status: "running", input, startedAt, ownerId: this.ownerId, leaseUntil });
      await this.store?.record({ sessionId: this.sessionId, runId, eventType: "run_started" });
      heartbeat = this.store ? setInterval(() => { void this.store?.heartbeatRun(this.sessionId, runId, this.ownerId, new Date(Date.now() + 30_000).toISOString()); }, 5_000) : undefined;
      const changeTracker = options.changeTracker ?? this.changeTracker;
      this.recoveryEligible = await this.recoveryCoordinator?.canCreate() ?? false;
      // 由 Session 分配的 runId 决定本轮 baseline 目录，保证磁盘审计身份和运行记录一致。
      await changeTracker?.start(runId);
      const result = await this.agent.run(input, {
        initialMessages: this.context,
        sessionId: this.sessionId,
        runId,
        changeTracker,
        gitChangeTracker: options.gitChangeTracker,
        checkpoint: this.store ? { save: (checkpoint) => this.store!.saveCheckpoint(checkpoint) } : undefined,
        auditSink: this.store ? { record: (event) => this.store!.record(event) } : undefined,
        summaryCache: this.store,
        signal: options.signal,
        persistContext: (messages) => this.persistActiveContext(messages),
      });
      const finishedAt = new Date().toISOString();
      if (heartbeat) clearInterval(heartbeat);
      const runResult: RunResult = { ...result, status: "completed", sessionId: this.sessionId, runId, startedAt, finishedAt };
      const newMessages = (result.transcriptMessages ?? result.messages).slice(this.context.length);
      await this.store?.completeRun({
        run: { id: runId, sessionId: this.sessionId, status: "completed", input, finalText: result.finalText, startedAt, finishedAt, result },
        messages: newMessages.map((message, index) => ({ sessionId: this.sessionId, runId, sequence: this.persistedMessageCount + index, message, createdAt: finishedAt })),
      });
      await this.store?.record({ sessionId: this.sessionId, runId, eventType: "run_completed" });
      this.persistedMessageCount += newMessages.length;
      this.context = [...result.messages];
      const contextCheckpoint = await this.agent.exportContextCheckpoint(this.sessionId, this.context);
      if (contextCheckpoint) {
        // Checkpoint 游标使用 Transcript 全局序号，不能使用压缩视图内的数组 index。
        const state = { ...contextCheckpoint, coveredThroughSequence: this.persistedMessageCount - 1, sourceMessageCount: this.persistedMessageCount };
        await this.store?.saveContextCheckpoint(state);
        if (state.resumeMessages) this.context = [...state.resumeMessages];
      }
      await this.recoveryCoordinator?.createForCompletedRun({ sessionId: this.sessionId, runId, verification: result.verification, eligibleAtStart: this.recoveryEligible });
      this.runHistory.push(runResult);
      return runResult;
    } catch (error) {
      if (heartbeat) clearInterval(heartbeat);
      const finishedAt = new Date().toISOString();
      const interrupted = isAbortError(error, options.signal);
      await this.store?.failRun({ sessionId: this.sessionId, runId, status: interrupted ? "interrupted" : "failed", error: error instanceof Error ? error.message : String(error), finishedAt });
      await this.store?.record({ sessionId: this.sessionId, runId, eventType: interrupted ? "run_interrupted" : "run_failed", status: interrupted ? "interrupted" : "failed" });
      this.runHistory.push({
        sessionId: this.sessionId,
        runId,
        status: interrupted ? "interrupted" : "failed",
        startedAt,
        finishedAt,
        error: error instanceof Error ? error.message : String(error),
      });
      if (interrupted && this.store) {
        const checkpoint = await this.store.getCheckpoint(this.sessionId, runId);
        if (checkpoint) this.resumable = { run: { id: runId, sessionId: this.sessionId, status: "interrupted", input, startedAt, finishedAt, error: "Run interrupted" }, checkpoint };
      }
      throw error;
    } finally {
      this.running = false;
    }
  }

  /** 关闭 Session；关闭后只允许读取最终结果，不能再创建 run。 */
  async close(): Promise<SessionResult> {
    if (this.running) throw new Error("Cannot close Session while a run is in progress");
    this.statusValue = "closed";
    await this.store?.closeSession(this.sessionId, new Date().toISOString());
    void this.changeTracker?.dispose();
    const last = this.runHistory.at(-1);
    return {
      sessionId: this.sessionId,
      status: this.statusValue,
      messages: [...this.context],
      runs: [...this.runHistory],
      finalText: last?.status === "completed" ? last.finalText : "",
    };
  }

  private async persistActiveContext(messages: readonly Message[]): Promise<void> {
    if (!this.store) return;
    const checkpoint = await this.agent.exportContextCheckpoint(this.sessionId, messages);
    if (checkpoint) await this.store.saveContextCheckpoint(checkpoint);
  }

  async listRecoveryPoints(): Promise<readonly import("./recovery-point.ts").RecoveryPoint[]> {
    if (!this.recoveryCoordinator) return [];
    return await this.recoveryCoordinator.list(this.sessionId);
  }

  async rollbackRecoveryPoint(recoveryPointId: string, ownerId = this.ownerId): Promise<void> {
    if (this.running) throw new Error("Session has a run in progress");
    if (!this.recoveryCoordinator) throw new Error("Recovery points require a persistent Session");
    await this.recoveryCoordinator.rollback(recoveryPointId, { sessionId: this.sessionId, ownerId });
    const restored = await this.store?.getContextCheckpoint(this.sessionId);
    if (restored?.resumeMessages) this.context = [...restored.resumeMessages];
  }

  async rollbackPreviousRecoveryPoint(ownerId = this.ownerId): Promise<void> {
    if (this.running) throw new Error("Session has a run in progress");
    if (!this.recoveryCoordinator) throw new Error("Recovery points require a persistent Session");
    await this.recoveryCoordinator.rollbackPrevious(this.sessionId, ownerId);
    const restored = await this.store?.getContextCheckpoint(this.sessionId);
    if (restored?.resumeMessages) this.context = [...restored.resumeMessages];
  }

  /** 获取当前 Session 的不可变结果快照。 */
  result(): SessionResult {
    const last = this.runHistory.at(-1);
    return {
      sessionId: this.sessionId,
      status: this.statusValue,
      messages: [...this.context],
      runs: [...this.runHistory],
      finalText: last?.status === "completed" ? last.finalText : "",
    };
  }
}

function toSessionRun(run: StoredRunRecord): SessionRun[] {
  if (run.status === "completed" && run.result && run.finishedAt) return [{ ...run.result, status: "completed", sessionId: run.sessionId, runId: run.id, startedAt: run.startedAt, finishedAt: run.finishedAt }];
  if ((run.status === "failed" || run.status === "interrupted") && run.finishedAt) return [{ sessionId: run.sessionId, runId: run.id, status: run.status, startedAt: run.startedAt, finishedAt: run.finishedAt, error: run.error ?? run.status }];
  return [];
}

function isAbortError(error: unknown, signal?: AbortSignal): boolean {
  return Boolean(signal?.aborted) || (error instanceof Error && (error.name === "AbortError" || error.message.toLowerCase().includes("aborted")));
}

function validateId(value: string, name: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value)) {
    throw new Error(`${name} must contain only letters, numbers, underscores, and hyphens`);
  }
}
