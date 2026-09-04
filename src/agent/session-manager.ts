import path from "node:path";
import { Session } from "./session.ts";
import type { Agent } from "./agent.ts";
import type { SessionRecord, SessionStore } from "./session-store.ts";

/** 管理多会话的创建与恢复；恢复只还原已提交上下文，绝不重放副作用。 */
export class SessionManager {
  private readonly agent: Agent;
  private readonly store: SessionStore;
  private readonly workspaceRoot: string;

  constructor(agent: Agent, store: SessionStore, workspaceRoot: string) {
    this.agent = agent;
    this.store = store;
    this.workspaceRoot = workspaceRoot;
  }

  async create(sessionId?: string): Promise<Session> {
    const session = new Session(this.agent, { sessionId, store: this.store, workspaceRoot: this.workspaceRoot });
    await session.initialize();
    return session;
  }

  async load(sessionId: string): Promise<Session> {
    const record = await this.requireSession(sessionId);
    if (path.resolve(record.workspaceRoot) !== path.resolve(this.workspaceRoot)) throw new Error("Session workspace does not match the current workspace");
    await this.store.interruptRunningRuns(sessionId, new Date().toISOString());
    const messages = await this.store.listMessages(sessionId);
    const runs = await this.store.listRuns(sessionId);
    return Session.restore(this.agent, { record, store: this.store, messages, runs });
  }

  list(): Promise<readonly SessionRecord[]> { return this.store.listSessions(); }
  private async requireSession(sessionId: string): Promise<SessionRecord> { const record = await this.store.getSession(sessionId); if (!record) throw new Error(`Session not found: ${sessionId}`); return record; }
}
