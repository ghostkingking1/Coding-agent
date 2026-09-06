import type { AgentResult, CheckpointRecord, ContextCheckpoint, Message } from "./types.ts";

export type PersistedSessionStatus = "active" | "closed";
export type PersistedRunStatus = "running" | "completed" | "failed" | "interrupted";

export interface SessionRecord {
  readonly id: string;
  readonly workspaceRoot: string;
  readonly status: PersistedSessionStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly schemaVersion: number;
}

export interface StoredRunRecord {
  readonly id: string;
  readonly sessionId: string;
  readonly status: PersistedRunStatus;
  readonly input: string;
  readonly finalText?: string;
  readonly error?: string;
  readonly startedAt: string;
  readonly finishedAt?: string;
  readonly result?: AgentResult;
  readonly ownerId?: string;
  readonly leaseUntil?: string;
}

export interface StoredMessage {
  readonly sessionId: string;
  readonly runId?: string;
  readonly sequence: number;
  readonly message: Message;
  readonly createdAt: string;
}

export interface CompleteRunInput {
  readonly run: StoredRunRecord;
  readonly messages: readonly StoredMessage[];
}

/** Session 仅依赖这个契约，使 SQLite 和测试替身不会渗入 Agent 执行逻辑。 */
export interface SessionStore {
  createSession(input: { readonly id: string; readonly workspaceRoot: string; readonly createdAt: string }): Promise<SessionRecord>;
  getSession(sessionId: string): Promise<SessionRecord | undefined>;
  listSessions(): Promise<readonly SessionRecord[]>;
  closeSession(sessionId: string, updatedAt: string): Promise<void>;
  startRun(run: StoredRunRecord & { readonly ownerId?: string; readonly leaseUntil?: string }): Promise<void>;
  heartbeatRun(sessionId: string, runId: string, ownerId: string, leaseUntil: string): Promise<void>;
  completeRun(input: CompleteRunInput): Promise<void>;
  failRun(input: { readonly sessionId: string; readonly runId: string; readonly status: "failed" | "interrupted"; readonly error: string; readonly finishedAt: string }): Promise<void>;
  listMessages(sessionId: string): Promise<readonly StoredMessage[]>;
  listRuns(sessionId: string): Promise<readonly StoredRunRecord[]>;
  interruptRunningRuns(sessionId: string, finishedAt: string): Promise<void>;
  interruptExpiredRuns(sessionId: string, now: string, finishedAt: string): Promise<number>;
  saveCheckpoint(checkpoint: CheckpointRecord): Promise<void>;
  getCheckpoint(sessionId: string, runId: string): Promise<CheckpointRecord | undefined>;
  saveContextCheckpoint(checkpoint: ContextCheckpoint): Promise<void>;
  getContextCheckpoint(sessionId: string): Promise<ContextCheckpoint | undefined>;
  close(): Promise<void>;
}
