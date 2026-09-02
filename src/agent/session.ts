import crypto from "node:crypto";
import { Agent } from "./agent.ts";
import type { AgentResult, Message } from "./types.ts";

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
}

/** 管理多个 Agent run 共享的消息上下文和生命周期。 */
export class Session {
  readonly sessionId: string;
  private readonly agent: Agent;
  private context: Message[] = [];
  private readonly runHistory: SessionRun[] = [];
  private statusValue: SessionStatus = "active";
  private running = false;

  constructor(agent: Agent, options: SessionOptions = {}) {
    this.agent = agent;
    this.sessionId = options.sessionId ?? `sess_${crypto.randomUUID()}`;
    validateId(this.sessionId, "sessionId");
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
  async run(input: string): Promise<RunResult> {
    if (this.statusValue === "closed") throw new Error("Session is closed");
    if (this.running) throw new Error("Session already has a run in progress");
    const runId = `run_${crypto.randomUUID()}`;
    validateId(runId, "runId");
    const startedAt = new Date().toISOString();
    this.running = true;
    try {
      const result = await this.agent.run(input, {
        initialMessages: this.context,
        sessionId: this.sessionId,
        runId,
      });
      const finishedAt = new Date().toISOString();
      const runResult: RunResult = { ...result, status: "completed", sessionId: this.sessionId, runId, startedAt, finishedAt };
      this.context = [...result.messages];
      this.runHistory.push(runResult);
      return runResult;
    } catch (error) {
      const finishedAt = new Date().toISOString();
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
  close(): SessionResult {
    if (this.running) throw new Error("Cannot close Session while a run is in progress");
    this.statusValue = "closed";
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

function validateId(value: string, name: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value)) {
    throw new Error(`${name} must contain only letters, numbers, underscores, and hyphens`);
  }
}
