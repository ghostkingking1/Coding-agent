import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import type { AuditEvent, CheckpointRecord, ContextCheckpoint, Message, SummaryCacheEntry } from "./types.ts";
import type { CompleteRunInput, PersistedRunStatus, SessionRecord, SessionStore, StoredMessage, StoredRunRecord } from "./session-store.ts";
import type { RecoveryPoint, WorkspaceRevision } from "./recovery-point.ts";

const SCHEMA_VERSION = 10;

/** SQLite 保存 Session/Run、原始消息归档、活动上下文 checkpoint 和受限审计事件；大文件 artifact 仍属于文件系统层。 */
export class SqliteSessionStore implements SessionStore {
  private readonly database: DatabaseSync;

  constructor(databasePath: string) {
    this.database = new DatabaseSync(path.resolve(databasePath));
    this.database.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    this.migrate();
  }

  async createSession(input: { readonly id: string; readonly workspaceRoot: string; readonly createdAt: string }): Promise<SessionRecord> {
    this.database.prepare("INSERT INTO sessions (id, workspace_root, status, created_at, updated_at, schema_version) VALUES (?, ?, 'active', ?, ?, ?)")
      .run(input.id, input.workspaceRoot, input.createdAt, input.createdAt, SCHEMA_VERSION);
    return { id: input.id, workspaceRoot: input.workspaceRoot, status: "active", createdAt: input.createdAt, updatedAt: input.createdAt, schemaVersion: SCHEMA_VERSION };
  }

  async getSession(sessionId: string): Promise<SessionRecord | undefined> {
    const row = this.database.prepare("SELECT * FROM sessions WHERE id = ?").get(sessionId) as SessionRow | undefined;
    return row && sessionFromRow(row);
  }

  async listSessions(): Promise<readonly SessionRecord[]> {
    return (this.database.prepare("SELECT * FROM sessions ORDER BY updated_at DESC").all() as unknown as SessionRow[]).map(sessionFromRow);
  }

  async closeSession(sessionId: string, updatedAt: string): Promise<void> {
    this.database.prepare("UPDATE sessions SET status = 'closed', updated_at = ? WHERE id = ?").run(updatedAt, sessionId);
  }

  async startRun(run: StoredRunRecord & { readonly ownerId?: string; readonly leaseUntil?: string }): Promise<void> {
    // SQLite 事务同时承担跨进程互斥，避免两个终端在内存锁之外并发占用同一 Session。
    this.transaction(() => {
      const active = this.database.prepare("SELECT id FROM runs WHERE session_id = ? AND status = 'running' LIMIT 1").get(run.sessionId);
      if (active) throw new Error("Session already has an active run");
      this.database.prepare("INSERT INTO runs (id, session_id, status, input, started_at, owner_id, lease_until) VALUES (?, ?, 'running', ?, ?, ?, ?)")
        .run(run.id, run.sessionId, run.input, run.startedAt, run.ownerId ?? "legacy", run.leaseUntil ?? new Date(Date.now() + 30_000).toISOString());
    });
  }

  async resumeRun(sessionId: string, runId: string, ownerId: string, leaseUntil: string): Promise<void> {
    const result = this.database.prepare("UPDATE runs SET status = 'running', error = NULL, finished_at = NULL, owner_id = ?, lease_until = ? WHERE id = ? AND session_id = ? AND status = 'interrupted'").run(ownerId, leaseUntil, runId, sessionId);
    if (result.changes !== 1) throw new Error("Run is not available for recovery");
  }

  async heartbeatRun(sessionId: string, runId: string, ownerId: string, leaseUntil: string): Promise<void> {
    this.database.prepare("UPDATE runs SET lease_until = ? WHERE id = ? AND session_id = ? AND owner_id = ? AND status = 'running'").run(leaseUntil, runId, sessionId, ownerId);
  }

  async completeRun(input: CompleteRunInput): Promise<void> {
    this.transaction(() => {
      const run = input.run;
      const finishedAt = requiredFinishedAt(run);
      // transcriptMessages 仅用于本次归档增量计算，不再复制进 runs.result_json；原始归档只保存在 messages 表。
      const persistedResult = run.result ? (({ transcriptMessages: _transcriptMessages, ...result }) => result)(run.result) : undefined;
      this.database.prepare("UPDATE runs SET status = 'completed', final_text = ?, finished_at = ?, result_json = ?, owner_id = NULL, lease_until = NULL WHERE id = ? AND session_id = ?")
        .run(run.finalText ?? "", finishedAt, persistedResult === undefined ? null : JSON.stringify(persistedResult), run.id, run.sessionId);
      const insert = this.database.prepare("INSERT INTO messages (session_id, run_id, sequence, role, content, tool_call_id, tool_name, tool_calls_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
      for (const message of input.messages) insert.run(message.sessionId, message.runId ?? null, message.sequence, message.message.role, message.message.content, toolCallId(message.message), toolName(message.message), toolCallsJson(message.message), message.createdAt);
      this.database.prepare("UPDATE sessions SET updated_at = ? WHERE id = ?").run(finishedAt, run.sessionId);
    });
  }

  async failRun(input: { readonly sessionId: string; readonly runId: string; readonly status: "failed" | "interrupted"; readonly error: string; readonly finishedAt: string }): Promise<void> {
    this.transaction(() => {
      this.database.prepare("UPDATE runs SET status = ?, error = ?, finished_at = ?, owner_id = NULL, lease_until = NULL WHERE id = ? AND session_id = ?")
        .run(input.status, input.error, input.finishedAt, input.runId, input.sessionId);
      this.database.prepare("UPDATE sessions SET updated_at = ? WHERE id = ?").run(input.finishedAt, input.sessionId);
    });
  }

  async listMessages(sessionId: string): Promise<readonly StoredMessage[]> {
    return (this.database.prepare("SELECT * FROM messages WHERE session_id = ? ORDER BY sequence ASC").all(sessionId) as unknown as MessageRow[])
      .map((row) => ({ sessionId: row.session_id, runId: row.run_id ?? undefined, sequence: row.sequence, message: messageFromRow(row), createdAt: row.created_at }));
  }

  async listMessagesFrom(sessionId: string, sequence: number): Promise<readonly StoredMessage[]> {
    if (!Number.isInteger(sequence) || sequence < 0) throw new Error("message sequence must be a non-negative integer");
    return (this.database.prepare("SELECT * FROM messages WHERE session_id = ? AND sequence >= ? ORDER BY sequence ASC").all(sessionId, sequence) as unknown as MessageRow[])
      .map((row) => ({ sessionId: row.session_id, runId: row.run_id ?? undefined, sequence: row.sequence, message: messageFromRow(row), createdAt: row.created_at }));
  }

  async countMessages(sessionId: string): Promise<number> {
    return Number((this.database.prepare("SELECT COUNT(*) AS count FROM messages WHERE session_id = ?").get(sessionId) as { count: number }).count);
  }

  async listRuns(sessionId: string): Promise<readonly StoredRunRecord[]> {
    return (this.database.prepare("SELECT * FROM runs WHERE session_id = ? ORDER BY started_at ASC").all(sessionId) as unknown as RunRow[]).map(runFromRow);
  }

  async interruptRunningRuns(sessionId: string, finishedAt: string): Promise<void> {
    await this.failRunningRuns(sessionId, finishedAt);
  }

  async interruptExpiredRuns(sessionId: string, now: string, finishedAt: string): Promise<number> {
    const result = this.database.prepare("UPDATE runs SET status = 'interrupted', error = 'Process ended before run completion', finished_at = ?, owner_id = NULL, lease_until = NULL WHERE session_id = ? AND status = 'running' AND (lease_until IS NULL OR lease_until <= ?)").run(finishedAt, sessionId, now);
    return Number(result.changes);
  }

  async saveCheckpoint(checkpoint: CheckpointRecord): Promise<void> {
    const metadata = JSON.stringify({ sessionId: checkpoint.sessionId, runId: checkpoint.runId, step: checkpoint.step, phase: checkpoint.phase, verification: checkpoint.verification, taskState: checkpoint.taskState, updatedAt: checkpoint.updatedAt });
    this.transaction(() => {
      const existing = this.database.prepare("SELECT id FROM checkpoints WHERE run_id = ? AND checkpoint_kind = 'run'").get(checkpoint.runId) as { id: number } | undefined;
      if (existing) {
        this.database.prepare("UPDATE checkpoints SET session_id = ?, step = ?, phase = ?, context_json = ?, tool_results_json = ?, metadata_json = ?, updated_at = ? WHERE id = ?")
          .run(checkpoint.sessionId, checkpoint.step, checkpoint.phase, JSON.stringify(checkpoint.messages), JSON.stringify(checkpoint.toolResults), metadata, checkpoint.updatedAt, existing.id);
      } else {
        this.database.prepare("INSERT INTO checkpoints (session_id, run_id, checkpoint_kind, step, phase, context_json, tool_results_json, metadata_json, updated_at) VALUES (?, ?, 'run', ?, ?, ?, ?, ?, ?)")
          .run(checkpoint.sessionId, checkpoint.runId, checkpoint.step, checkpoint.phase, JSON.stringify(checkpoint.messages), JSON.stringify(checkpoint.toolResults), metadata, checkpoint.updatedAt);
      }
    });
  }

  async getCheckpoint(sessionId: string, runId: string): Promise<CheckpointRecord | undefined> {
    const row = this.database.prepare("SELECT * FROM checkpoints WHERE session_id = ? AND run_id = ? AND checkpoint_kind = 'run'").get(sessionId, runId) as UnifiedCheckpointRow | undefined;
    if (!row) return undefined;
    const metadata = JSON.parse(row.metadata_json) as Omit<CheckpointRecord, "messages" | "toolResults">;
    return { ...metadata, sessionId: row.session_id, runId: row.run_id!, step: row.step!, phase: row.phase!, messages: JSON.parse(row.context_json ?? "[]") as Message[], toolResults: JSON.parse(row.tool_results_json ?? "[]") as CheckpointRecord["toolResults"], updatedAt: row.updated_at };
  }
  async saveContextCheckpoint(checkpoint: ContextCheckpoint): Promise<void> {
    const { resumeMessages: _resumeMessages, ...metadata } = checkpoint;
    this.transaction(() => {
      const existing = this.database.prepare("SELECT id FROM checkpoints WHERE session_id = ? AND checkpoint_kind = 'context' AND checkpoint_state = 'active'").get(checkpoint.sessionId) as { id: number } | undefined;
      if (existing) {
        this.database.prepare("UPDATE checkpoints SET context_json = ?, metadata_json = ?, updated_at = ? WHERE id = ?")
          .run(checkpoint.resumeMessages ? JSON.stringify(checkpoint.resumeMessages) : null, JSON.stringify(metadata), checkpoint.updatedAt, existing.id);
      } else {
        this.database.prepare("INSERT INTO checkpoints (session_id, run_id, checkpoint_kind, context_json, metadata_json, updated_at) VALUES (?, NULL, 'context', ?, ?, ?)")
          .run(checkpoint.sessionId, checkpoint.resumeMessages ? JSON.stringify(checkpoint.resumeMessages) : null, JSON.stringify(metadata), checkpoint.updatedAt);
      }
    });
  }
  async getContextCheckpoint(sessionId: string): Promise<ContextCheckpoint | undefined> {
    const row = this.database.prepare("SELECT * FROM checkpoints WHERE session_id = ? AND checkpoint_kind = 'context' AND checkpoint_state = 'active'").get(sessionId) as UnifiedCheckpointRow | undefined;
    if (!row) return undefined;
    const metadata = JSON.parse(row.metadata_json) as Omit<ContextCheckpoint, "resumeMessages">;
    return { ...metadata, sessionId: row.session_id, ...(row.context_json ? { resumeMessages: JSON.parse(row.context_json) as Message[] } : {}), updatedAt: row.updated_at };
  }

  async freezeContextCheckpoint(sessionId: string): Promise<{ readonly id: number; readonly checkpoint: ContextCheckpoint } | undefined> {
    return this.transaction(() => {
      const row = this.database.prepare("SELECT * FROM checkpoints WHERE session_id = ? AND checkpoint_kind = 'context' AND checkpoint_state = 'active'").get(sessionId) as UnifiedCheckpointRow | undefined;
      if (!row) return undefined;
      const frozen = this.database.prepare("INSERT INTO checkpoints (session_id, run_id, checkpoint_kind, checkpoint_state, step, phase, context_json, tool_results_json, metadata_json, updated_at) VALUES (?, NULL, 'context', 'frozen', NULL, NULL, ?, NULL, ?, ?)").run(row.session_id, row.context_json, row.metadata_json, row.updated_at);
      return { id: Number(frozen.lastInsertRowid), checkpoint: contextFromRow(row) };
    });
  }

  async getFrozenContextCheckpoint(sessionId: string, checkpointId: number): Promise<ContextCheckpoint | undefined> {
    const row = this.database.prepare("SELECT * FROM checkpoints WHERE id = ? AND session_id = ? AND checkpoint_kind = 'context' AND checkpoint_state = 'frozen'").get(checkpointId, sessionId) as UnifiedCheckpointRow | undefined;
    return row && contextFromRow(row);
  }

  async activateContextCheckpoint(sessionId: string, checkpointId: number): Promise<void> {
    this.transaction(() => {
      const frozen = this.database.prepare("SELECT * FROM checkpoints WHERE id = ? AND session_id = ? AND checkpoint_kind = 'context' AND checkpoint_state = 'frozen'").get(checkpointId, sessionId) as UnifiedCheckpointRow | undefined;
      if (!frozen) throw new Error("Frozen context checkpoint is missing");
      const active = this.database.prepare("SELECT id FROM checkpoints WHERE session_id = ? AND checkpoint_kind = 'context' AND checkpoint_state = 'active'").get(sessionId) as { id: number } | undefined;
      if (active) this.database.prepare("UPDATE checkpoints SET context_json = ?, metadata_json = ?, updated_at = ? WHERE id = ?").run(frozen.context_json, frozen.metadata_json, frozen.updated_at, active.id);
      else this.database.prepare("INSERT INTO checkpoints (session_id, run_id, checkpoint_kind, checkpoint_state, context_json, metadata_json, updated_at) VALUES (?, NULL, 'context', 'active', ?, ?, ?)").run(sessionId, frozen.context_json, frozen.metadata_json, frozen.updated_at);
    });
  }

  async prepareRecoveryPoint(input: { readonly id: string; readonly sessionId: string; readonly runId: string; readonly contextCheckpointId: number; readonly workspaceRoot: string; readonly createdAt: string }): Promise<void> {
    this.database.prepare("INSERT INTO recovery_points (id, session_id, run_id, sequence, previous_recovery_point_id, context_checkpoint_id, workspace_root, workspace_revision_json, status, created_at, committed_at) VALUES (?, ?, ?, NULL, NULL, ?, ?, NULL, 'preparing', ?, NULL)").run(input.id, input.sessionId, input.runId, input.contextCheckpointId, input.workspaceRoot, input.createdAt);
  }

  async commitRecoveryPoint(input: { readonly id: string; readonly sessionId: string; readonly runId: string; readonly contextCheckpointId: number; readonly workspaceRevision: WorkspaceRevision; readonly createdAt: string }): Promise<RecoveryPoint> {
    return this.transaction(() => {
      const previous = this.database.prepare("SELECT id, sequence FROM recovery_points WHERE session_id = ? AND status = 'committed' ORDER BY sequence DESC LIMIT 1").get(input.sessionId) as { id: string; sequence: number } | undefined;
      const sequence = (previous?.sequence ?? 0) + 1;
      const committedAt = new Date().toISOString();
      const result = this.database.prepare("UPDATE recovery_points SET sequence = ?, previous_recovery_point_id = ?, context_checkpoint_id = ?, workspace_revision_json = ?, status = 'committed', committed_at = ? WHERE id = ? AND session_id = ? AND status = 'preparing'").run(sequence, previous?.id ?? null, input.contextCheckpointId, JSON.stringify(input.workspaceRevision), committedAt, input.id, input.sessionId);
      if (result.changes !== 1) throw new Error("Recovery point is not preparing");
      return { id: input.id, sessionId: input.sessionId, runId: input.runId, sequence, ...(previous ? { previousRecoveryPointId: previous.id } : {}), contextCheckpointId: input.contextCheckpointId, workspaceRevision: input.workspaceRevision, status: "committed", createdAt: input.createdAt, committedAt };
    });
  }

  async abortRecoveryPoint(id: string, _reason: string): Promise<void> { this.database.prepare("UPDATE recovery_points SET status = 'aborted' WHERE id = ? AND status = 'preparing'").run(id); }
  async getRecoveryPoint(sessionId: string, id: string): Promise<RecoveryPoint | undefined> {
    const row = this.database.prepare("SELECT * FROM recovery_points WHERE session_id = ? AND id = ?").get(sessionId, id) as RecoveryPointRow | undefined;
    return row && recoveryPointFromRow(row);
  }
  async listRecoveryPoints(sessionId: string): Promise<readonly RecoveryPoint[]> {
    return (this.database.prepare("SELECT * FROM recovery_points WHERE session_id = ? AND status = 'committed' ORDER BY sequence DESC").all(sessionId) as unknown as RecoveryPointRow[]).map(recoveryPointFromRow);
  }
  async beginRecoveryOperation(input: { readonly id: string; readonly sessionId: string; readonly recoveryPointId: string; readonly ownerId: string }): Promise<void> {
    this.database.prepare("INSERT INTO recovery_operations (id, session_id, recovery_point_id, owner_id, status, reason, created_at, updated_at) VALUES (?, ?, ?, ?, 'running', NULL, ?, ?)").run(input.id, input.sessionId, input.recoveryPointId, input.ownerId, new Date().toISOString(), new Date().toISOString());
  }
  async finishRecoveryOperation(sessionId: string, recoveryPointId: string, status: "committed"): Promise<void> { this.database.prepare("UPDATE recovery_operations SET status = ?, updated_at = ? WHERE session_id = ? AND recovery_point_id = ? AND status = 'running'").run(status, new Date().toISOString(), sessionId, recoveryPointId); }
  async markRecoveryPending(sessionId: string, recoveryPointId: string, reason: string): Promise<void> { this.database.prepare("UPDATE recovery_operations SET status = 'recovery_pending', reason = ?, updated_at = ? WHERE session_id = ? AND recovery_point_id = ? AND status = 'running'").run(reason, new Date().toISOString(), sessionId, recoveryPointId); }

  async getSummaryCache(cacheKey: string): Promise<SummaryCacheEntry | undefined> {
    const row = this.database.prepare("SELECT cache_key, source_hash, summary_version, compression_strategy_version, content, created_at FROM summary_cache WHERE cache_key = ?").get(cacheKey) as SummaryCacheRow | undefined;
    return row && { cacheKey: row.cache_key, sourceHash: row.source_hash, summaryVersion: row.summary_version, compressionStrategyVersion: row.compression_strategy_version, content: row.content, createdAt: row.created_at };
  }

  async saveSummaryCache(entry: SummaryCacheEntry): Promise<void> {
    if (!/^[0-9a-f]{64}:summary-v[0-9]+:context-compaction-v[0-9]+$/.test(entry.cacheKey) || !/^[0-9a-f]{64}$/.test(entry.sourceHash) || entry.content.length > 64_000) throw new Error("Invalid summary cache entry");
    this.transaction(() => {
      this.database.prepare("INSERT INTO summary_cache (cache_key, source_hash, summary_version, compression_strategy_version, content, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(cache_key) DO UPDATE SET content=excluded.content, created_at=excluded.created_at").run(entry.cacheKey, entry.sourceHash, entry.summaryVersion, entry.compressionStrategyVersion, entry.content, entry.createdAt);
      // 持久缓存只用于避免重复计算，保留最近 1000 条，避免数据库无限增长。
      this.database.prepare("DELETE FROM summary_cache WHERE cache_key NOT IN (SELECT cache_key FROM summary_cache ORDER BY created_at DESC LIMIT 1000)").run();
    });
  }

  async record(event: AuditEvent): Promise<void> {
    const sessionId = event.sessionId ?? "unknown";
    this.transaction(() => {
      // BEGIN IMMEDIATE 串行化 sequence 分配，避免并发审计写入拿到同一个 MAX+1。
      const sequence = event.sequence ?? Number((this.database.prepare("SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM audit_events WHERE session_id = ?").get(sessionId) as { sequence: number }).sequence);
      this.database.prepare("INSERT INTO audit_events (session_id, run_id, sequence, event_type, step, tool_call_id, tool_name, attempt, status, error_code, request_id, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(sessionId, event.runId ?? null, sequence, event.eventType, event.step ?? null, event.toolCallId ?? null, event.toolName ?? null, event.attempt ?? null, event.status ?? null, event.errorCode ?? null, event.requestId ?? null, event.metadata ? JSON.stringify(event.metadata) : null, event.createdAt ?? new Date().toISOString());
    });
  }

  async listAuditEvents(sessionId: string, runId?: string): Promise<readonly AuditEvent[]> {
    const rows = (runId ? this.database.prepare("SELECT * FROM audit_events WHERE session_id = ? AND run_id = ? ORDER BY sequence ASC").all(sessionId, runId) : this.database.prepare("SELECT * FROM audit_events WHERE session_id = ? ORDER BY sequence ASC").all(sessionId)) as unknown as AuditRow[];
    return rows.map((row) => ({ sessionId: row.session_id, ...(row.run_id ? { runId: row.run_id } : {}), sequence: row.sequence, eventType: row.event_type, ...(row.step === null ? {} : { step: row.step }), ...(row.tool_call_id ? { toolCallId: row.tool_call_id } : {}), ...(row.tool_name ? { toolName: row.tool_name } : {}), ...(row.attempt === null ? {} : { attempt: row.attempt }), ...(row.status ? { status: row.status } : {}), ...(row.error_code ? { errorCode: row.error_code } : {}), ...(row.request_id ? { requestId: row.request_id } : {}), ...(row.metadata_json ? { metadata: JSON.parse(row.metadata_json) } : {}), createdAt: row.created_at }));
  }

  async close(): Promise<void> {
    // 关闭前完成 WAL checkpoint，尽量在释放句柄前把日志合并回主库。
    try { this.database.exec("PRAGMA wal_checkpoint=FULL"); } catch { /* 数据库已损坏时仍继续释放句柄。 */ }
    this.database.close();
  }

  private async failRunningRuns(sessionId: string, finishedAt: string): Promise<void> {
    this.transaction(() => {
      this.database.prepare("UPDATE runs SET status = 'interrupted', error = 'Process ended before run completion', finished_at = ?, owner_id = NULL, lease_until = NULL WHERE session_id = ? AND status = 'running'")
        .run(finishedAt, sessionId);
      this.database.prepare("UPDATE sessions SET updated_at = ? WHERE id = ?").run(finishedAt, sessionId);
    });
  }

  private transaction<T>(operation: () => T): T {
    this.database.exec("BEGIN IMMEDIATE");
    try { const result = operation(); this.database.exec("COMMIT"); return result; } catch (error) { this.database.exec("ROLLBACK"); throw error; }
  }

  /** 将旧的运行 checkpoint 与会话上下文 checkpoint 合并为一张表，并去掉重复消息载荷。 */
  private mergeCheckpointTables(): void {
    const hasRunTable = Boolean(this.database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'checkpoints'").get());
    const hasContextTable = Boolean(this.database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'context_checkpoints'").get());
    const hasSessionsTable = Boolean(this.database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sessions'").get());
    const hasRunsTable = Boolean(this.database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'runs'").get());
    this.transaction(() => {
      const runRows = hasRunTable
        ? this.database.prepare("SELECT session_id, run_id, step, phase, payload_json, updated_at FROM checkpoints").all() as unknown as LegacyRunCheckpointRow[]
        : [];
      const contextRows = hasContextTable
        ? this.database.prepare("SELECT * FROM context_checkpoints").all() as unknown as LegacyContextCheckpointRow[]
        : [];
      if (hasRunTable) this.database.exec("ALTER TABLE checkpoints RENAME TO checkpoints_legacy");
      if (hasContextTable) this.database.exec("ALTER TABLE context_checkpoints RENAME TO context_checkpoints_legacy");
      this.database.exec(`CREATE TABLE checkpoints (id INTEGER PRIMARY KEY, session_id TEXT NOT NULL${hasSessionsTable ? " REFERENCES sessions(id)" : ""}, run_id TEXT${hasRunsTable ? " REFERENCES runs(id)" : ""}, checkpoint_kind TEXT NOT NULL CHECK(checkpoint_kind IN ('run', 'context')), checkpoint_state TEXT NOT NULL DEFAULT 'active' CHECK(checkpoint_state IN ('active', 'frozen')), step INTEGER, phase TEXT CHECK(phase IN ('model', 'tool') OR phase IS NULL), context_json TEXT, tool_results_json TEXT, metadata_json TEXT NOT NULL, updated_at TEXT NOT NULL); CREATE UNIQUE INDEX checkpoints_run_idx ON checkpoints(run_id) WHERE run_id IS NOT NULL; CREATE UNIQUE INDEX checkpoints_context_active_idx ON checkpoints(session_id) WHERE checkpoint_kind = 'context' AND checkpoint_state = 'active';`);
      const insert = this.database.prepare("INSERT INTO checkpoints (session_id, run_id, checkpoint_kind, checkpoint_state, step, phase, context_json, tool_results_json, metadata_json, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
      for (const row of runRows) {
        const payload = JSON.parse(row.payload_json) as CheckpointRecord;
        insert.run(row.session_id, row.run_id, "run", "active", row.step, row.phase, JSON.stringify(payload.messages ?? []), JSON.stringify(payload.toolResults ?? []), JSON.stringify({ sessionId: payload.sessionId ?? row.session_id, runId: payload.runId ?? row.run_id, step: payload.step ?? row.step, phase: payload.phase ?? row.phase, verification: payload.verification, taskState: payload.taskState, updatedAt: payload.updatedAt ?? row.updated_at }), row.updated_at);
      }
      for (const row of contextRows) {
        const metadata = { sessionId: row.session_id, coveredThroughSequence: row.covered_through_sequence, sourcePrefixHash: row.source_prefix_hash, summarySegments: JSON.parse(row.summary_segments_json), retainedTailStart: row.retained_tail_start, ...(row.source_message_count === null || row.source_message_count === undefined ? {} : { sourceMessageCount: row.source_message_count }), ...(row.version === null || row.version === undefined ? {} : { version: row.version }), ...(row.parent_version === null || row.parent_version === undefined ? {} : { parentVersion: row.parent_version }), ...(row.summary_version === null || row.summary_version === undefined ? {} : { summaryVersion: row.summary_version }), ...(row.compression_strategy_version === null || row.compression_strategy_version === undefined ? {} : { compressionStrategyVersion: row.compression_strategy_version }) };
        insert.run(row.session_id, null, "context", "active", null, null, row.resume_messages_json ?? null, null, JSON.stringify(metadata), row.updated_at);
      }
      if (hasRunTable) this.database.exec("DROP TABLE checkpoints_legacy");
      if (hasContextTable) this.database.exec("DROP TABLE context_checkpoints_legacy");
      this.database.exec("INSERT INTO schema_migrations(version) VALUES (9)");
    });
  }

  private migrate(): void {
    this.database.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY)");
    let current = (this.database.prepare("SELECT MAX(version) AS version FROM schema_migrations").get() as { version: number | null }).version ?? 0;
    if (current > SCHEMA_VERSION) throw new Error(`Session database schema ${current} is newer than supported ${SCHEMA_VERSION}`);
    if (current === 1) {
      this.transaction(() => { this.database.exec("ALTER TABLE runs ADD COLUMN owner_id TEXT; ALTER TABLE runs ADD COLUMN lease_until TEXT;"); this.database.exec("INSERT INTO schema_migrations(version) VALUES (2)"); });
      current = 2;
    }
    if (current === 2) {
      this.transaction(() => { this.database.exec("CREATE TABLE checkpoints (session_id TEXT NOT NULL REFERENCES sessions(id), run_id TEXT PRIMARY KEY REFERENCES runs(id), step INTEGER NOT NULL, phase TEXT NOT NULL CHECK(phase IN ('model', 'tool')), payload_json TEXT NOT NULL, updated_at TEXT NOT NULL);"); this.database.exec("INSERT INTO schema_migrations(version) VALUES (3)"); });
      current = 3;
    }
    if (current === 3) {
      this.transaction(() => { this.database.exec("CREATE TABLE context_checkpoints (session_id TEXT PRIMARY KEY REFERENCES sessions(id), covered_through_sequence INTEGER NOT NULL, source_prefix_hash TEXT NOT NULL, summary_segments_json TEXT NOT NULL, retained_tail_start INTEGER NOT NULL, updated_at TEXT NOT NULL);"); this.database.exec("INSERT INTO schema_migrations(version) VALUES (4)"); });
      current = 4;
    }
    if (current === 4) {
      this.transaction(() => { this.database.exec("CREATE TABLE audit_events (id INTEGER PRIMARY KEY, session_id TEXT NOT NULL, run_id TEXT, sequence INTEGER NOT NULL, event_type TEXT NOT NULL, step INTEGER, tool_call_id TEXT, tool_name TEXT, attempt INTEGER, status TEXT, error_code TEXT, request_id TEXT, metadata_json TEXT, created_at TEXT NOT NULL, UNIQUE(session_id, sequence)); CREATE INDEX audit_session_run_idx ON audit_events(session_id, run_id, sequence); INSERT INTO schema_migrations(version) VALUES (5);"); });
      current = 5;
    }
    if (current === 5) {
      this.transaction(() => { this.database.exec("ALTER TABLE context_checkpoints ADD COLUMN resume_messages_json TEXT; ALTER TABLE context_checkpoints ADD COLUMN source_message_count INTEGER; INSERT INTO schema_migrations(version) VALUES (6);"); });
      current = 6;
    }
    if (current === 6) {
      this.transaction(() => { this.database.exec("ALTER TABLE context_checkpoints ADD COLUMN version INTEGER; ALTER TABLE context_checkpoints ADD COLUMN parent_version INTEGER; ALTER TABLE context_checkpoints ADD COLUMN summary_version TEXT; ALTER TABLE context_checkpoints ADD COLUMN compression_strategy_version TEXT; INSERT INTO schema_migrations(version) VALUES (7);"); });
      current = 7;
    }
    if (current === 7) {
      this.transaction(() => { this.database.exec("CREATE TABLE summary_cache (cache_key TEXT PRIMARY KEY, source_hash TEXT NOT NULL, summary_version TEXT NOT NULL, compression_strategy_version TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL); CREATE INDEX summary_cache_created_idx ON summary_cache(created_at DESC);"); this.database.exec("INSERT INTO schema_migrations(version) VALUES (8)"); });
      current = 8;
    }
    if (current === 8) {
      this.mergeCheckpointTables();
      current = 9;
    }
    if (current === 9) {
      this.transaction(() => {
        const columns = this.database.prepare("PRAGMA table_info(checkpoints)").all() as Array<{ name: string }>;
        if (!columns.some((column) => column.name === "checkpoint_state")) this.database.exec("ALTER TABLE checkpoints ADD COLUMN checkpoint_state TEXT NOT NULL DEFAULT 'active' CHECK(checkpoint_state IN ('active', 'frozen'));");
        this.database.exec("DROP INDEX IF EXISTS checkpoints_context_idx; CREATE UNIQUE INDEX IF NOT EXISTS checkpoints_context_active_idx ON checkpoints(session_id) WHERE checkpoint_kind = 'context' AND checkpoint_state = 'active';");
        this.database.exec("CREATE TABLE recovery_points (id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), run_id TEXT NOT NULL REFERENCES runs(id), sequence INTEGER, previous_recovery_point_id TEXT REFERENCES recovery_points(id), context_checkpoint_id INTEGER NOT NULL REFERENCES checkpoints(id), workspace_root TEXT NOT NULL, workspace_revision_json TEXT, status TEXT NOT NULL CHECK(status IN ('preparing', 'committed', 'aborted', 'recovery_pending')), created_at TEXT NOT NULL, committed_at TEXT);");
        this.database.exec("CREATE UNIQUE INDEX recovery_points_session_sequence_idx ON recovery_points(session_id, sequence) WHERE sequence IS NOT NULL; CREATE INDEX recovery_points_session_status_idx ON recovery_points(session_id, status);");
        this.database.exec("CREATE TABLE recovery_operations (id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), recovery_point_id TEXT NOT NULL REFERENCES recovery_points(id), owner_id TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('running', 'committed', 'recovery_pending')), reason TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);");
        this.database.exec("INSERT INTO schema_migrations(version) VALUES (10);");
      });
      current = 10;
    }
    if (current === SCHEMA_VERSION) return;
    this.transaction(() => {
      this.database.exec(`
        CREATE TABLE sessions (id TEXT PRIMARY KEY, workspace_root TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('active', 'closed')), created_at TEXT NOT NULL, updated_at TEXT NOT NULL, schema_version INTEGER NOT NULL);
        CREATE TABLE runs (id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), status TEXT NOT NULL CHECK(status IN ('running', 'completed', 'failed', 'interrupted')), input TEXT NOT NULL, final_text TEXT, error TEXT, started_at TEXT NOT NULL, finished_at TEXT, result_json TEXT, owner_id TEXT, lease_until TEXT);
        CREATE TABLE messages (id INTEGER PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), run_id TEXT REFERENCES runs(id), sequence INTEGER NOT NULL, role TEXT NOT NULL CHECK(role IN ('system', 'user', 'assistant', 'tool')), content TEXT NOT NULL, tool_call_id TEXT, tool_name TEXT, tool_calls_json TEXT, created_at TEXT NOT NULL, UNIQUE(session_id, sequence));
        CREATE INDEX runs_session_started_idx ON runs(session_id, started_at);
        CREATE INDEX messages_session_sequence_idx ON messages(session_id, sequence);
        CREATE TABLE checkpoints (id INTEGER PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), run_id TEXT REFERENCES runs(id), checkpoint_kind TEXT NOT NULL CHECK(checkpoint_kind IN ('run', 'context')), checkpoint_state TEXT NOT NULL DEFAULT 'active' CHECK(checkpoint_state IN ('active', 'frozen')), step INTEGER, phase TEXT CHECK(phase IN ('model', 'tool') OR phase IS NULL), context_json TEXT, tool_results_json TEXT, metadata_json TEXT NOT NULL, updated_at TEXT NOT NULL);
        CREATE UNIQUE INDEX checkpoints_run_idx ON checkpoints(run_id) WHERE run_id IS NOT NULL;
        CREATE UNIQUE INDEX checkpoints_context_active_idx ON checkpoints(session_id) WHERE checkpoint_kind = 'context' AND checkpoint_state = 'active';
        CREATE TABLE recovery_points (id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), run_id TEXT NOT NULL REFERENCES runs(id), sequence INTEGER, previous_recovery_point_id TEXT REFERENCES recovery_points(id), context_checkpoint_id INTEGER NOT NULL REFERENCES checkpoints(id), workspace_root TEXT NOT NULL, workspace_revision_json TEXT, status TEXT NOT NULL CHECK(status IN ('preparing', 'committed', 'aborted', 'recovery_pending')), created_at TEXT NOT NULL, committed_at TEXT);
        CREATE UNIQUE INDEX recovery_points_session_sequence_idx ON recovery_points(session_id, sequence) WHERE sequence IS NOT NULL;
        CREATE INDEX recovery_points_session_status_idx ON recovery_points(session_id, status);
        CREATE TABLE recovery_operations (id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), recovery_point_id TEXT NOT NULL REFERENCES recovery_points(id), owner_id TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('running', 'committed', 'recovery_pending')), reason TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
        CREATE TABLE summary_cache (cache_key TEXT PRIMARY KEY, source_hash TEXT NOT NULL, summary_version TEXT NOT NULL, compression_strategy_version TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL);
        CREATE INDEX summary_cache_created_idx ON summary_cache(created_at DESC);
        CREATE TABLE audit_events (id INTEGER PRIMARY KEY, session_id TEXT NOT NULL, run_id TEXT, sequence INTEGER NOT NULL, event_type TEXT NOT NULL, step INTEGER, tool_call_id TEXT, tool_name TEXT, attempt INTEGER, status TEXT, error_code TEXT, request_id TEXT, metadata_json TEXT, created_at TEXT NOT NULL, UNIQUE(session_id, sequence));
        CREATE INDEX audit_session_run_idx ON audit_events(session_id, run_id, sequence);
        INSERT INTO schema_migrations(version) VALUES (${SCHEMA_VERSION});
      `);
    });
  }
}

interface SessionRow { id: string; workspace_root: string; status: "active" | "closed"; created_at: string; updated_at: string; schema_version: number; }
interface RunRow { id: string; session_id: string; status: PersistedRunStatus; input: string; final_text: string | null; error: string | null; started_at: string; finished_at: string | null; result_json: string | null; owner_id: string | null; lease_until: string | null; }
interface MessageRow { session_id: string; run_id: string | null; sequence: number; role: Message["role"]; content: string; tool_call_id: string | null; tool_name: string | null; tool_calls_json: string | null; created_at: string; }
interface UnifiedCheckpointRow { id: number; session_id: string; run_id: string | null; checkpoint_kind: "run" | "context"; checkpoint_state: "active" | "frozen"; step: number | null; phase: "model" | "tool" | null; context_json: string | null; tool_results_json: string | null; metadata_json: string; updated_at: string; }
interface RecoveryPointRow { id: string; session_id: string; run_id: string; sequence: number | null; previous_recovery_point_id: string | null; context_checkpoint_id: number; workspace_root: string; workspace_revision_json: string | null; status: "preparing" | "committed" | "aborted" | "recovery_pending"; created_at: string; committed_at: string | null; }
interface LegacyRunCheckpointRow { session_id: string; run_id: string; step: number; phase: "model" | "tool"; payload_json: string; updated_at: string; }
interface LegacyContextCheckpointRow { session_id: string; covered_through_sequence: number; source_prefix_hash: string; summary_segments_json: string; retained_tail_start: number; resume_messages_json?: string | null; source_message_count?: number | null; version?: number | null; parent_version?: number | null; summary_version?: string | null; compression_strategy_version?: string | null; updated_at: string; }
interface SummaryCacheRow { cache_key: string; source_hash: string; summary_version: string; compression_strategy_version: string; content: string; created_at: string; }
interface AuditRow { session_id: string; run_id: string | null; sequence: number; event_type: string; step: number | null; tool_call_id: string | null; tool_name: string | null; attempt: number | null; status: string | null; error_code: string | null; request_id: string | null; metadata_json: string | null; created_at: string; }
function sessionFromRow(row: SessionRow): SessionRecord { return { id: row.id, workspaceRoot: row.workspace_root, status: row.status, createdAt: row.created_at, updatedAt: row.updated_at, schemaVersion: row.schema_version }; }
function runFromRow(row: RunRow): StoredRunRecord { return { id: row.id, sessionId: row.session_id, status: row.status, input: row.input, ...(row.final_text === null ? {} : { finalText: row.final_text }), ...(row.error === null ? {} : { error: row.error }), startedAt: row.started_at, ...(row.finished_at === null ? {} : { finishedAt: row.finished_at }), ...(row.result_json === null ? {} : { result: JSON.parse(row.result_json) as StoredRunRecord["result"] }), ...(row.owner_id === null ? {} : { ownerId: row.owner_id }), ...(row.lease_until === null ? {} : { leaseUntil: row.lease_until }) }; }
function messageFromRow(row: MessageRow): Message { if (row.role === "tool") return { role: "tool", content: row.content, toolCallId: row.tool_call_id!, toolName: row.tool_name! }; if (row.role === "assistant") return { role: "assistant", content: row.content, ...(row.tool_calls_json ? { toolCalls: JSON.parse(row.tool_calls_json) } : {}) }; return { role: row.role, content: row.content }; }
function toolCallId(message: Message): string | null { return message.role === "tool" ? message.toolCallId : null; }
function toolName(message: Message): string | null { return message.role === "tool" ? message.toolName : null; }
function toolCallsJson(message: Message): string | null { return message.role === "assistant" && message.toolCalls ? JSON.stringify(message.toolCalls) : null; }
function requiredFinishedAt(run: StoredRunRecord): string { if (!run.finishedAt) throw new Error("Completed run requires finishedAt"); return run.finishedAt; }
function contextFromRow(row: UnifiedCheckpointRow): ContextCheckpoint {
  const metadata = JSON.parse(row.metadata_json) as Omit<ContextCheckpoint, "resumeMessages">;
  return { ...metadata, sessionId: row.session_id, ...(row.context_json ? { resumeMessages: JSON.parse(row.context_json) as Message[] } : {}), updatedAt: row.updated_at };
}
function recoveryPointFromRow(row: RecoveryPointRow): RecoveryPoint {
  if (row.status !== "committed" || row.sequence === null || !row.workspace_revision_json || !row.committed_at) throw new Error("Recovery point is not committed");
  return { id: row.id, sessionId: row.session_id, runId: row.run_id, sequence: row.sequence, ...(row.previous_recovery_point_id ? { previousRecoveryPointId: row.previous_recovery_point_id } : {}), contextCheckpointId: row.context_checkpoint_id, workspaceRevision: JSON.parse(row.workspace_revision_json) as WorkspaceRevision, status: row.status, createdAt: row.created_at, committedAt: row.committed_at };
}
