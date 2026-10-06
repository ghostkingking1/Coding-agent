import crypto from "node:crypto";
import type { VerificationSummary } from "./types.ts";
import type { SessionStore } from "./session-store.ts";
import { GitRepository, type GitRecoveryTree } from "../repository/git.ts";

export type RecoveryPointStatus = "preparing" | "committed" | "aborted" | "recovery_pending";

export interface WorkspaceRevision {
  readonly provider: "git-object-store";
  readonly objectType: "tree";
  readonly objectId: string;
  readonly refName: string;
  readonly repositoryRoot: string;
}

export interface RecoveryPoint {
  readonly id: string;
  readonly sessionId: string;
  readonly runId: string;
  readonly sequence: number;
  readonly previousRecoveryPointId?: string;
  readonly contextCheckpointId: number;
  readonly workspaceRevision: WorkspaceRevision;
  readonly status: RecoveryPointStatus;
  readonly createdAt: string;
  readonly committedAt?: string;
}

export interface RecoveryPointRef {
  readonly id: string;
  readonly sequence: number;
  readonly status: "committed";
  readonly previousRecoveryPointId?: string;
  readonly contextCheckpointId: number;
  readonly workspaceRevision: WorkspaceRevision;
}

export interface RecoveryPointCoordinatorOptions {
  readonly requireCleanStart?: boolean;
}

/** 将活动上下文与 Git tree object 原子地登记为一个可恢复版本。 */
export class RecoveryPointCoordinator {
  private readonly store: SessionStore;
  private readonly git: GitRepository;
  private readonly requireCleanStart: boolean;

  constructor(store: SessionStore, git: GitRepository, options: RecoveryPointCoordinatorOptions = {}) {
    this.store = store;
    this.git = git;
    this.requireCleanStart = options.requireCleanStart ?? true;
  }

  async canCreate(): Promise<boolean> {
    const status = await this.git.status();
    return status.isRepository === true && status.repositoryRoot === this.git.workspaceRoot && (!this.requireCleanStart || status.files.length === 0);
  }

  async createForCompletedRun(input: { readonly sessionId: string; readonly runId: string; readonly verification: VerificationSummary; readonly eligibleAtStart: boolean }): Promise<RecoveryPointRef | undefined> {
    if (!input.eligibleAtStart || !input.verification.required || !input.verification.writeObserved || input.verification.status !== "passed") return undefined;
    const active = await this.store.freezeContextCheckpoint?.(input.sessionId);
    if (!active) return undefined;
    const id = `rp_${crypto.randomUUID()}`;
    await this.store.prepareRecoveryPoint?.({ id, sessionId: input.sessionId, runId: input.runId, contextCheckpointId: active.id, workspaceRoot: this.git.workspaceRoot, createdAt: new Date().toISOString() });
    try {
      const tree = await this.git.createRecoveryTree(id);
      const point = await this.store.commitRecoveryPoint?.({ id, sessionId: input.sessionId, runId: input.runId, contextCheckpointId: active.id, workspaceRevision: tree, createdAt: new Date().toISOString() });
      if (!point) throw new Error("Recovery point store is unavailable");
      return toRef(point);
    } catch (error) {
      await this.store.abortRecoveryPoint?.(id, error instanceof Error ? error.message : String(error));
      await this.store.record({ sessionId: input.sessionId, runId: input.runId, eventType: "recovery_point_aborted", status: "aborted", metadata: { reason: "git_tree_creation_failed" } });
      return undefined;
    }
  }

  async list(sessionId: string): Promise<readonly RecoveryPoint[]> { return await this.store.listRecoveryPoints?.(sessionId) ?? []; }
  async current(sessionId: string): Promise<RecoveryPoint | undefined> { return (await this.list(sessionId)).find((point) => point.status === "committed"); }
  async previous(sessionId: string, currentId?: string): Promise<RecoveryPoint | undefined> {
    const current = currentId ? (await this.store.getRecoveryPoint?.(sessionId, currentId)) : await this.current(sessionId);
    if (!current?.previousRecoveryPointId) return undefined;
    return await this.store.getRecoveryPoint?.(sessionId, current.previousRecoveryPointId);
  }

  async rollback(recoveryPointId: string, options: { readonly sessionId: string; readonly ownerId: string }): Promise<RecoveryPoint> {
    const point = await this.store.getRecoveryPoint?.(options.sessionId, recoveryPointId);
    if (!point || point.status !== "committed") throw new Error("Recovery point is not committed");
    const context = await this.store.getFrozenContextCheckpoint?.(options.sessionId, point.contextCheckpointId);
    if (!context) throw new Error("Recovery point context checkpoint is missing");
    await this.store.beginRecoveryOperation?.({ id: `ro_${crypto.randomUUID()}`, sessionId: options.sessionId, recoveryPointId, ownerId: options.ownerId });
    try {
      const tree: GitRecoveryTree = { ...point.workspaceRevision, objectType: "tree" };
      await this.git.restoreRecoveryTree(tree);
      await this.store.activateContextCheckpoint?.(options.sessionId, point.contextCheckpointId);
      await this.store.finishRecoveryOperation?.(options.sessionId, recoveryPointId, "committed");
      return point;
    } catch (error) {
      await this.store.markRecoveryPending?.(options.sessionId, recoveryPointId, error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  async rollbackPrevious(sessionId: string, ownerId: string): Promise<RecoveryPoint> {
    const point = await this.previous(sessionId);
    if (!point) throw new Error("No previous recovery point exists");
    return await this.rollback(point.id, { sessionId, ownerId });
  }
}

function toRef(point: RecoveryPoint): RecoveryPointRef {
  return { id: point.id, sequence: point.sequence, status: "committed", ...(point.previousRecoveryPointId ? { previousRecoveryPointId: point.previousRecoveryPointId } : {}), contextCheckpointId: point.contextCheckpointId, workspaceRevision: point.workspaceRevision };
}
