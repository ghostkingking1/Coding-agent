import type { AgentResult, AuditEvent, CheckpointRecord, ContextCheckpoint, Message, SummaryCacheEntry } from "./types.ts";
import type { RecoveryPoint, WorkspaceRevision } from "./recovery-point.ts";

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
  resumeRun(sessionId: string, runId: string, ownerId: string, leaseUntil: string): Promise<void>;
  heartbeatRun(sessionId: string, runId: string, ownerId: string, leaseUntil: string): Promise<void>;
  completeRun(input: CompleteRunInput): Promise<void>;
  failRun(input: { readonly sessionId: string; readonly runId: string; readonly status: "failed" | "interrupted"; readonly error: string; readonly finishedAt: string }): Promise<void>;
  listMessages(sessionId: string): Promise<readonly StoredMessage[]>;
  listMessagesFrom?(sessionId: string, sequence: number): Promise<readonly StoredMessage[]>;
  countMessages?(sessionId: string): Promise<number>;
  listRuns(sessionId: string): Promise<readonly StoredRunRecord[]>;
  interruptRunningRuns(sessionId: string, finishedAt: string): Promise<void>;
  interruptExpiredRuns(sessionId: string, now: string, finishedAt: string): Promise<number>;
  saveCheckpoint(checkpoint: CheckpointRecord): Promise<void>;
  getCheckpoint(sessionId: string, runId: string): Promise<CheckpointRecord | undefined>;
  saveContextCheckpoint(checkpoint: ContextCheckpoint): Promise<void>;
  getContextCheckpoint(sessionId: string): Promise<ContextCheckpoint | undefined>;
  getSummaryCache(cacheKey: string): Promise<SummaryCacheEntry | undefined>;
  saveSummaryCache(entry: SummaryCacheEntry): Promise<void>;
  record(event: AuditEvent): Promise<void>;
  listAuditEvents(sessionId: string, runId?: string): Promise<readonly AuditEvent[]>;
  freezeContextCheckpoint?(sessionId: string): Promise<{ readonly id: number; readonly checkpoint: ContextCheckpoint } | undefined>;
  getFrozenContextCheckpoint?(sessionId: string, checkpointId: number): Promise<ContextCheckpoint | undefined>;
  activateContextCheckpoint?(sessionId: string, checkpointId: number): Promise<void>;
  prepareRecoveryPoint?(input: { readonly id: string; readonly sessionId: string; readonly runId: string; readonly contextCheckpointId: number; readonly workspaceRoot: string; readonly createdAt: string }): Promise<void>;
  commitRecoveryPoint?(input: { readonly id: string; readonly sessionId: string; readonly runId: string; readonly contextCheckpointId: number; readonly workspaceRevision: WorkspaceRevision; readonly createdAt: string }): Promise<RecoveryPoint>;
  abortRecoveryPoint?(id: string, reason: string): Promise<void>;
  getRecoveryPoint?(sessionId: string, id: string): Promise<RecoveryPoint | undefined>;
  listRecoveryPoints?(sessionId: string): Promise<readonly RecoveryPoint[]>;
  beginRecoveryOperation?(input: { readonly id: string; readonly sessionId: string; readonly recoveryPointId: string; readonly ownerId: string }): Promise<void>;
  finishRecoveryOperation?(sessionId: string, recoveryPointId: string, status: "committed"): Promise<void>;
  markRecoveryPending?(sessionId: string, recoveryPointId: string, reason: string): Promise<void>;
  close(): Promise<void>;
}
