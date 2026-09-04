import crypto from "node:crypto";
import { Agent } from "./agent.ts";
import type { AgentResult, AgentRunOptions, Message } from "./types.ts";
import { RunChangeTracker } from "./run-diff.ts";
import type { SessionRecord, SessionStore, StoredMessage, StoredRunRecord } from "./session-store.ts";

export type SessionStatus = "active" | "closed";
export type RunStatus = "completed" | "failed";

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
  readonly status: "failed";
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

/** 管理多个 Agent run 共享的消息上下文和生命周期。 */
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
  private persisted = false;
  private readonly ownerId = `pid-${process.pid}-${crypto.randomUUID()}`;

  constructor(agent: Agent, options: SessionOptions = {}) {
    this.agent = agent;
    this.sessionId = options.sessionId ?? `sess_${crypto.randomUUID()}`;
    validateId(this.sessionId, "sessionId");
    this.changeTracker = options.changeTracker;
    this.store = options.store;
    this.workspaceRoot = options.workspaceRoot;
    if (this.store && !this.workspaceRoot) throw new Error("workspaceRoot is required when a SessionStore is configured");
  }

  /** 创建新会话的持久化记录；恢复会话使用 restore，不会重复插入。 */
  async initialize(): Promise<void> {
    if (!this.store || this.persisted) return;
    await this.store.createSession({ id: this.sessionId, workspaceRoot: this.workspaceRoot!, createdAt: new Date().toISOString() });
    this.persisted = true;
  }

  /** 从已提交记录恢复；未完成 run 已由 SessionManager 标记为 interrupted。 */
  static restore(agent: Agent, input: { readonly record: SessionRecord; readonly store: SessionStore; readonly messages: readonly StoredMessage[]; readonly runs: readonly StoredRunRecord[] }): Session {
    const session = new Session(agent, { sessionId: input.record.id, store: input.store, workspaceRoot: input.record.workspaceRoot });
    session.context = input.messages.map((message) => message.message);
    session.statusValue = input.record.status;
    session.persisted = true;
    session.runHistory.push(...input.runs.flatMap((run) => toSessionRun(run)));
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

  /** 顺序执行一次 run；成功的完整消息上下文才会提交到 Session。 */
  async run(input: string, options: Pick<AgentRunOptions, "changeTracker"> = {}): Promise<RunResult> {
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
      heartbeat = this.store ? setInterval(() => { void this.store?.heartbeatRun(this.sessionId, runId, this.ownerId, new Date(Date.now() + 30_000).toISOString()); }, 5_000) : undefined;
      const changeTracker = options.changeTracker ?? this.changeTracker;
      // 由 Session 分配的 runId 决定本轮 baseline 目录，保证磁盘审计身份和运行记录一致。
      await changeTracker?.start(runId);
      const result = await this.agent.run(input, {
        initialMessages: this.context,
        sessionId: this.sessionId,
        runId,
        changeTracker,
      });
      const finishedAt = new Date().toISOString();
      if (heartbeat) clearInterval(heartbeat);
      const runResult: RunResult = { ...result, status: "completed", sessionId: this.sessionId, runId, startedAt, finishedAt };
      const newMessages = result.messages.slice(this.context.length);
      await this.store?.completeRun({
        run: { id: runId, sessionId: this.sessionId, status: "completed", input, finalText: result.finalText, startedAt, finishedAt, result },
        messages: newMessages.map((message, index) => ({ sessionId: this.sessionId, runId, sequence: this.context.length + index, message, createdAt: finishedAt })),
      });
      this.context = [...result.messages];
      this.runHistory.push(runResult);
      return runResult;
    } catch (error) {
      if (heartbeat) clearInterval(heartbeat);
      const finishedAt = new Date().toISOString();
      await this.store?.failRun({ sessionId: this.sessionId, runId, status: "failed", error: error instanceof Error ? error.message : String(error), finishedAt });
      this.runHistory.push({
        sessionId: this.sessionId,
        runId,
        status: "failed",
        startedAt,
        finishedAt,
        error: error instanceof Error ? error.message : String(error),
      });
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
  if ((run.status === "failed" || run.status === "interrupted") && run.finishedAt) return [{ sessionId: run.sessionId, runId: run.id, status: "failed", startedAt: run.startedAt, finishedAt: run.finishedAt, error: run.error ?? run.status }];
  return [];
}

function validateId(value: string, name: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value)) {
    throw new Error(`${name} must contain only letters, numbers, underscores, and hyphens`);
  }
}
