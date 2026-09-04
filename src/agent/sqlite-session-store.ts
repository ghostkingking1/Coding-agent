import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import type { Message } from "./types.ts";
import type { CompleteRunInput, PersistedRunStatus, SessionRecord, SessionStore, StoredMessage, StoredRunRecord } from "./session-store.ts";

const SCHEMA_VERSION = 2;

/** SQLite 持久化仅保存结构化审计数据；文件 checkpoint 内容继续属于文件系统层。 */
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

  async heartbeatRun(sessionId: string, runId: string, ownerId: string, leaseUntil: string): Promise<void> {
    this.database.prepare("UPDATE runs SET lease_until = ? WHERE id = ? AND session_id = ? AND owner_id = ? AND status = 'running'").run(leaseUntil, runId, sessionId, ownerId);
  }

  async completeRun(input: CompleteRunInput): Promise<void> {
    this.transaction(() => {
      const run = input.run;
      const finishedAt = requiredFinishedAt(run);
      this.database.prepare("UPDATE runs SET status = 'completed', final_text = ?, finished_at = ?, result_json = ? WHERE id = ? AND session_id = ?")
        .run(run.finalText ?? "", finishedAt, JSON.stringify(run.result), run.id, run.sessionId);
      const insert = this.database.prepare("INSERT INTO messages (session_id, run_id, sequence, role, content, tool_call_id, tool_name, tool_calls_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
      for (const message of input.messages) insert.run(message.sessionId, message.runId ?? null, message.sequence, message.message.role, message.message.content, toolCallId(message.message), toolName(message.message), toolCallsJson(message.message), message.createdAt);
      this.database.prepare("UPDATE sessions SET updated_at = ? WHERE id = ?").run(finishedAt, run.sessionId);
    });
  }

  async failRun(input: { readonly sessionId: string; readonly runId: string; readonly status: "failed" | "interrupted"; readonly error: string; readonly finishedAt: string }): Promise<void> {
    this.transaction(() => {
      this.database.prepare("UPDATE runs SET status = ?, error = ?, finished_at = ? WHERE id = ? AND session_id = ?")
        .run(input.status, input.error, input.finishedAt, input.runId, input.sessionId);
      this.database.prepare("UPDATE sessions SET updated_at = ? WHERE id = ?").run(input.finishedAt, input.sessionId);
    });
  }

  async listMessages(sessionId: string): Promise<readonly StoredMessage[]> {
    return (this.database.prepare("SELECT * FROM messages WHERE session_id = ? ORDER BY sequence ASC").all(sessionId) as unknown as MessageRow[])
      .map((row) => ({ sessionId: row.session_id, runId: row.run_id ?? undefined, sequence: row.sequence, message: messageFromRow(row), createdAt: row.created_at }));
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

  async close(): Promise<void> {
    // 关闭前收拢 WAL，避免 Windows 下临时数据库删除时仍被 WAL 文件占用。
    try { this.database.exec("PRAGMA wal_checkpoint(TRUNCATE)"); } catch { /* 数据库已损坏时仍继续释放句柄。 */ }
    this.database.close();
  }

  private async failRunningRuns(sessionId: string, finishedAt: string): Promise<void> {
    this.transaction(() => {
      this.database.prepare("UPDATE runs SET status = 'interrupted', error = 'Process ended before run completion', finished_at = ? WHERE session_id = ? AND status = 'running'")
        .run(finishedAt, sessionId);
      this.database.prepare("UPDATE sessions SET updated_at = ? WHERE id = ?").run(finishedAt, sessionId);
    });
  }

  private transaction(operation: () => void): void {
    this.database.exec("BEGIN IMMEDIATE");
    try { operation(); this.database.exec("COMMIT"); } catch (error) { this.database.exec("ROLLBACK"); throw error; }
  }

  private migrate(): void {
    this.database.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY)");
    const current = (this.database.prepare("SELECT MAX(version) AS version FROM schema_migrations").get() as { version: number | null }).version ?? 0;
    if (current > SCHEMA_VERSION) throw new Error(`Session database schema ${current} is newer than supported ${SCHEMA_VERSION}`);
    if (current === 1) {
      this.transaction(() => { this.database.exec("ALTER TABLE runs ADD COLUMN owner_id TEXT; ALTER TABLE runs ADD COLUMN lease_until TEXT;"); this.database.exec("INSERT INTO schema_migrations(version) VALUES (2)"); });
      return;
    }
    if (current === SCHEMA_VERSION) return;
    this.transaction(() => {
      this.database.exec(`
        CREATE TABLE sessions (id TEXT PRIMARY KEY, workspace_root TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('active', 'closed')), created_at TEXT NOT NULL, updated_at TEXT NOT NULL, schema_version INTEGER NOT NULL);
        CREATE TABLE runs (id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), status TEXT NOT NULL CHECK(status IN ('running', 'completed', 'failed', 'interrupted')), input TEXT NOT NULL, final_text TEXT, error TEXT, started_at TEXT NOT NULL, finished_at TEXT, result_json TEXT, owner_id TEXT, lease_until TEXT);
        CREATE TABLE messages (id INTEGER PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), run_id TEXT REFERENCES runs(id), sequence INTEGER NOT NULL, role TEXT NOT NULL CHECK(role IN ('system', 'user', 'assistant', 'tool')), content TEXT NOT NULL, tool_call_id TEXT, tool_name TEXT, tool_calls_json TEXT, created_at TEXT NOT NULL, UNIQUE(session_id, sequence));
        CREATE INDEX runs_session_started_idx ON runs(session_id, started_at);
        CREATE INDEX messages_session_sequence_idx ON messages(session_id, sequence);
        INSERT INTO schema_migrations(version) VALUES (${SCHEMA_VERSION});
      `);
    });
  }
}

interface SessionRow { id: string; workspace_root: string; status: "active" | "closed"; created_at: string; updated_at: string; schema_version: number; }
interface RunRow { id: string; session_id: string; status: PersistedRunStatus; input: string; final_text: string | null; error: string | null; started_at: string; finished_at: string | null; result_json: string | null; owner_id: string | null; lease_until: string | null; }
interface MessageRow { session_id: string; run_id: string | null; sequence: number; role: Message["role"]; content: string; tool_call_id: string | null; tool_name: string | null; tool_calls_json: string | null; created_at: string; }
function sessionFromRow(row: SessionRow): SessionRecord { return { id: row.id, workspaceRoot: row.workspace_root, status: row.status, createdAt: row.created_at, updatedAt: row.updated_at, schemaVersion: row.schema_version }; }
function runFromRow(row: RunRow): StoredRunRecord { return { id: row.id, sessionId: row.session_id, status: row.status, input: row.input, ...(row.final_text === null ? {} : { finalText: row.final_text }), ...(row.error === null ? {} : { error: row.error }), startedAt: row.started_at, ...(row.finished_at === null ? {} : { finishedAt: row.finished_at }), ...(row.result_json === null ? {} : { result: JSON.parse(row.result_json) as StoredRunRecord["result"] }), ...(row.owner_id === null ? {} : { ownerId: row.owner_id }), ...(row.lease_until === null ? {} : { leaseUntil: row.lease_until }) }; }
function messageFromRow(row: MessageRow): Message { if (row.role === "tool") return { role: "tool", content: row.content, toolCallId: row.tool_call_id!, toolName: row.tool_name! }; if (row.role === "assistant") return { role: "assistant", content: row.content, ...(row.tool_calls_json ? { toolCalls: JSON.parse(row.tool_calls_json) } : {}) }; return { role: row.role, content: row.content }; }
function toolCallId(message: Message): string | null { return message.role === "tool" ? message.toolCallId : null; }
function toolName(message: Message): string | null { return message.role === "tool" ? message.toolName : null; }
function toolCallsJson(message: Message): string | null { return message.role === "assistant" && message.toolCalls ? JSON.stringify(message.toolCalls) : null; }
function requiredFinishedAt(run: StoredRunRecord): string { if (!run.finishedAt) throw new Error("Completed run requires finishedAt"); return run.finishedAt; }
