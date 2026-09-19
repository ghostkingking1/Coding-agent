import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { AuditSink, VerificationEvidence, VerificationSummary } from "./types.ts";

const DEFAULT_IGNORED_DIRECTORIES = [".git", "node_modules", "target", "coverage", "__pycache__"] as const;

export interface WorkspaceCheckpointFile {
  readonly path: string;
  readonly digest: string;
  readonly size: number;
  readonly mode: number;
}

export interface WorkspaceCheckpoint {
  readonly checkpointId: string;
  readonly runId: string;
  readonly workspaceRoot: string;
  readonly createdAt: string;
  readonly tier: "known_good" | "partial";
  readonly rollbackEligible: boolean;
  readonly files: readonly WorkspaceCheckpointFile[];
  readonly omittedPaths: readonly string[];
  readonly totalBytes: number;
  readonly verificationEvidenceId?: string;
}

export interface WorkspaceCheckpointManagerOptions {
  readonly workspaceRoot: string;
  readonly storageRoot: string;
  readonly maxFileBytes?: number;
  readonly maxFiles?: number;
  readonly maxSnapshotBytes?: number;
  readonly maxKnownGood?: number;
  readonly ignoredDirectories?: readonly string[];
  readonly leaseMs?: number;
  readonly auditSink?: AuditSink;
}

export interface RollbackOptions {
  readonly ownerId: string;
  /** 必须在 staging workspace 重新运行可信验证，内容完整性校验不能替代测试。 */
  readonly validate: (stagingRoot: string, checkpoint: WorkspaceCheckpoint) => Promise<VerificationEvidence>;
  readonly sessionId?: string;
  readonly runId?: string;
}

export interface RollbackResult {
  readonly checkpointId: string;
  readonly restoredFiles: number;
  readonly deletedFiles: number;
  readonly evidence: VerificationEvidence;
}

interface SnapshotResult {
  readonly files: WorkspaceCheckpointFile[];
  readonly omittedPaths: string[];
  readonly totalBytes: number;
}

interface RollbackJournal {
  readonly version: 1;
  readonly transactionId: string;
  readonly workspaceRoot: string;
  readonly backupRoot: string;
  readonly originalPaths: readonly string[];
  readonly absentPaths: readonly string[];
}

/** 持久化内容寻址检查点，并在 workspace 级租约内执行可恢复回滚。 */
export class WorkspaceCheckpointManager {
  private readonly root: string;
  private readonly storageRoot: string;
  private readonly maxFileBytes: number;
  private readonly maxFiles: number;
  private readonly maxSnapshotBytes: number;
  private readonly maxKnownGood: number;
  private readonly ignoredDirectories: ReadonlySet<string>;
  private readonly leaseMs: number;
  private readonly auditSink?: AuditSink;

  constructor(options: WorkspaceCheckpointManagerOptions) {
    this.root = path.resolve(options.workspaceRoot);
    this.storageRoot = path.resolve(options.storageRoot);
    if (this.storageRoot === this.root || this.storageRoot.startsWith(`${this.root}${path.sep}`)) throw new Error("checkpoint storageRoot must be outside workspaceRoot");
    this.maxFileBytes = positive(options.maxFileBytes ?? 64 * 1024 * 1024, "maxFileBytes");
    this.maxFiles = positive(options.maxFiles ?? 10_000, "maxFiles");
    this.maxSnapshotBytes = positive(options.maxSnapshotBytes ?? 512 * 1024 * 1024, "maxSnapshotBytes");
    this.maxKnownGood = positive(options.maxKnownGood ?? 10, "maxKnownGood");
    this.ignoredDirectories = new Set(options.ignoredDirectories ?? DEFAULT_IGNORED_DIRECTORIES);
    this.leaseMs = positive(options.leaseMs ?? 30_000, "leaseMs");
    this.auditSink = options.auditSink;
  }

  /** 只有 passed 证据可晋级 known_good；超限快照仍持久化为不可回滚的 partial 记录。 */
  async promote(runId: string, verification: VerificationSummary): Promise<WorkspaceCheckpoint> {
    const evidence = [...verification.evidence].reverse().find((item) => item.status === "passed");
    if (!verification.required || verification.status !== "passed" || !evidence) {
      throw new Error("A known_good checkpoint requires passed verification evidence");
    }
    await this.initialize();
    const snapshot = await this.snapshotToCas();
    const rollbackEligible = snapshot.omittedPaths.length === 0;
    const createdAt = new Date().toISOString();
    const checkpointId = `cp_${crypto.createHash("sha256").update(JSON.stringify({ runId, createdAt, files: snapshot.files })).digest("hex").slice(0, 32)}`;
    const checkpoint: WorkspaceCheckpoint = {
      checkpointId,
      runId,
      workspaceRoot: this.root,
      createdAt,
      tier: rollbackEligible ? "known_good" : "partial",
      rollbackEligible,
      files: snapshot.files,
      omittedPaths: snapshot.omittedPaths,
      totalBytes: snapshot.totalBytes,
      verificationEvidenceId: evidence.evidenceId,
    };
    await writeJsonAtomic(this.checkpointPath(checkpointId), checkpoint);
    await this.audit("checkpoint_promoted", runId, rollbackEligible ? "known_good" : "partial", { checkpointId, rollbackEligible, fileCount: snapshot.files.length, omittedCount: snapshot.omittedPaths.length });
    await this.enforceRetention();
    return checkpoint;
  }

  async list(): Promise<readonly WorkspaceCheckpoint[]> {
    await this.initialize();
    const names = await fs.readdir(this.checkpointsDirectory());
    const values = await Promise.all(names.filter((name) => name.endsWith(".json")).map((name) => this.readCheckpoint(path.join(this.checkpointsDirectory(), name))));
    return values.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async rollback(checkpointId: string, options: RollbackOptions): Promise<RollbackResult> {
    validateId(checkpointId, "checkpointId");
    validateId(options.ownerId, "ownerId");
    await this.initialize();
    return this.withLease(options.ownerId, async () => {
      await this.recoverInterruptedRollback();
      const checkpoint = await this.readCheckpoint(this.checkpointPath(checkpointId));
      if (!checkpoint.rollbackEligible || checkpoint.tier !== "known_good") throw new Error("Checkpoint is not eligible for rollback");
      const stagingRoot = path.join(this.storageRoot, "staging", `${checkpointId}-${crypto.randomUUID()}`);
      try {
        await this.restoreManifest(stagingRoot, checkpoint.files);
        await this.verifyManifest(stagingRoot, checkpoint.files);
        const evidence = await options.validate(stagingRoot, checkpoint);
        if (evidence.status !== "passed") throw new Error(`Staged checkpoint verification did not pass: ${evidence.status}`);
        await this.verifyManifest(stagingRoot, checkpoint.files);
        const result = await this.applyRollback(checkpoint, evidence);
        await this.audit("checkpoint_rolled_back", options.runId ?? checkpoint.runId, "completed", { checkpointId, restoredFiles: result.restoredFiles, deletedFiles: result.deletedFiles }, options.sessionId);
        return result;
      } finally {
        await fs.rm(stagingRoot, { recursive: true, force: true });
      }
    });
  }

  private async initialize(): Promise<void> {
    await fs.mkdir(this.objectsDirectory(), { recursive: true });
    await fs.mkdir(this.checkpointsDirectory(), { recursive: true });
    await fs.mkdir(path.join(this.storageRoot, "leases"), { recursive: true });
    await fs.mkdir(path.join(this.storageRoot, "rollback-journals"), { recursive: true });
    const actualRoot = await fs.realpath(this.root);
    if (path.resolve(actualRoot) !== this.root) throw new Error("workspaceRoot must be canonical");
  }

  private async snapshotToCas(): Promise<SnapshotResult> {
    const files: WorkspaceCheckpointFile[] = [];
    const omittedPaths: string[] = [];
    let totalBytes = 0;
    const visit = async (directory: string): Promise<void> => {
      const entries = (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        if (entry.name.startsWith(".") || (entry.isDirectory() && this.ignoredDirectories.has(entry.name))) continue;
        const absolute = path.join(directory, entry.name);
        const relative = safeRelative(this.root, absolute);
        if (entry.isSymbolicLink()) { omittedPaths.push(relative); continue; }
        if (entry.isDirectory()) { await visit(absolute); continue; }
        if (!entry.isFile()) { omittedPaths.push(relative); continue; }
        const stat = await fs.stat(absolute);
        if (files.length >= this.maxFiles || stat.size > this.maxFileBytes || totalBytes + stat.size > this.maxSnapshotBytes) {
          omittedPaths.push(relative);
          continue;
        }
        const digest = await hashFile(absolute);
        await this.storeObject(absolute, digest);
        files.push({ path: relative, digest, size: stat.size, mode: stat.mode });
        totalBytes += stat.size;
      }
    };
    await visit(this.root);
    return { files, omittedPaths: [...new Set(omittedPaths)].sort(), totalBytes };
  }

  private async storeObject(source: string, digest: string): Promise<void> {
    const target = this.objectPath(digest);
    try { await fs.stat(target); return; } catch { /* CAS miss */ }
    await fs.mkdir(path.dirname(target), { recursive: true });
    const temporary = `${target}.tmp-${crypto.randomUUID()}`;
    await fs.copyFile(source, temporary, (await import("node:fs")).constants.COPYFILE_EXCL);
    if (await hashFile(temporary) !== digest) { await fs.rm(temporary, { force: true }); throw new Error("CAS object changed while being copied"); }
    try { await fs.rename(temporary, target); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      await fs.rm(temporary, { force: true });
    }
  }

  private async restoreManifest(destination: string, files: readonly WorkspaceCheckpointFile[]): Promise<void> {
    await fs.mkdir(destination, { recursive: true });
    for (const file of files) {
      const target = path.join(destination, file.path);
      safeRelative(destination, target);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.copyFile(this.objectPath(file.digest), target);
      await fs.chmod(target, file.mode);
    }
  }

  private async verifyManifest(root: string, files: readonly WorkspaceCheckpointFile[]): Promise<void> {
    for (const file of files) {
      const candidate = path.join(root, file.path);
      if (await hashFile(candidate) !== file.digest) throw new Error(`Checkpoint digest mismatch: ${file.path}`);
    }
  }

  private async applyRollback(checkpoint: WorkspaceCheckpoint, evidence: VerificationEvidence): Promise<RollbackResult> {
    const transactionId = crypto.randomUUID();
    const transactionRoot = path.join(this.storageRoot, "rollback-journals", transactionId);
    const backupRoot = path.join(transactionRoot, "backup");
    const current = await listManagedFiles(this.root, this.ignoredDirectories);
    const desired = new Set(checkpoint.files.map((file) => file.path));
    const affected = [...new Set([...current, ...desired])].sort();
    const originalPaths: string[] = [];
    const absentPaths: string[] = [];
    await fs.mkdir(backupRoot, { recursive: true });
    for (const relative of affected) {
      const source = path.join(this.root, relative);
      if (await exists(source)) {
        const target = path.join(backupRoot, relative);
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.copyFile(source, target);
        originalPaths.push(relative);
      } else absentPaths.push(relative);
    }
    const journal: RollbackJournal = { version: 1, transactionId, workspaceRoot: this.root, backupRoot, originalPaths, absentPaths };
    await writeJsonAtomic(path.join(transactionRoot, "journal.json"), journal);
    try {
      for (const file of checkpoint.files) {
        const target = path.join(this.root, file.path);
        await assertNoSymlinkParents(this.root, target);
        await replaceFile(this.objectPath(file.digest), target, file.mode);
      }
      const extras = current.filter((relative) => !desired.has(relative));
      for (const relative of extras) {
        const target = path.join(this.root, relative);
        await assertNoSymlinkParents(this.root, target);
        await fs.rm(target, { force: true });
      }
      await this.verifyManifest(this.root, checkpoint.files);
      await fs.rm(transactionRoot, { recursive: true, force: true });
      return { checkpointId: checkpoint.checkpointId, restoredFiles: checkpoint.files.length, deletedFiles: extras.length, evidence };
    } catch (error) {
      await this.restoreJournal(journal);
      await fs.rm(transactionRoot, { recursive: true, force: true });
      throw error;
    }
  }

  private async recoverInterruptedRollback(): Promise<void> {
    const directory = path.join(this.storageRoot, "rollback-journals");
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const transactionRoot = path.join(directory, entry.name);
      const journalPath = path.join(transactionRoot, "journal.json");
      if (!await exists(journalPath)) continue;
      const journal = JSON.parse(await fs.readFile(journalPath, "utf8")) as RollbackJournal;
      if (journal.version !== 1 || journal.workspaceRoot !== this.root || journal.backupRoot !== path.join(transactionRoot, "backup") || !Array.isArray(journal.originalPaths) || !Array.isArray(journal.absentPaths)) throw new Error("Invalid rollback journal");
      for (const relative of [...journal.originalPaths, ...journal.absentPaths]) validateRelativePath(relative);
      await this.restoreJournal(journal);
      await fs.rm(transactionRoot, { recursive: true, force: true });
    }
  }

  private async restoreJournal(journal: RollbackJournal): Promise<void> {
    for (const relative of journal.absentPaths) await fs.rm(path.join(this.root, safeRelative(this.root, path.join(this.root, relative))), { force: true });
    for (const relative of journal.originalPaths) await replaceFile(path.join(journal.backupRoot, relative), path.join(this.root, safeRelative(this.root, path.join(this.root, relative))));
  }

  private async withLease<T>(ownerId: string, operation: () => Promise<T>): Promise<T> {
    const lease = await this.acquireLease(ownerId);
    try { return await operation(); } finally { await this.releaseLease(lease); }
  }

  private async acquireLease(ownerId: string): Promise<{ directory: string; token: string }> {
    const workspaceId = crypto.createHash("sha256").update(this.root).digest("hex");
    const directory = path.join(this.storageRoot, "leases", workspaceId);
    const token = crypto.randomUUID();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await fs.mkdir(directory);
        await fs.writeFile(path.join(directory, "lease.json"), JSON.stringify({ ownerId, token, expiresAt: new Date(Date.now() + this.leaseMs).toISOString() }), { flag: "wx" });
        return { directory, token };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const lease = await readJson(path.join(directory, "lease.json")) as { expiresAt?: string } | undefined;
        if (!lease?.expiresAt || lease.expiresAt > new Date().toISOString()) throw new Error("Workspace already has an active lease");
        const expired = `${directory}.expired-${crypto.randomUUID()}`;
        try { await fs.rename(directory, expired); await fs.rm(expired, { recursive: true, force: true }); } catch { throw new Error("Workspace lease changed while reclaiming it"); }
      }
    }
    throw new Error("Could not acquire workspace lease");
  }

  private async releaseLease(lease: { directory: string; token: string }): Promise<void> {
    const value = await readJson(path.join(lease.directory, "lease.json")) as { token?: string } | undefined;
    if (value?.token === lease.token) await fs.rm(lease.directory, { recursive: true, force: true });
  }

  private async enforceRetention(): Promise<void> {
    const checkpoints = await this.list();
    for (const checkpoint of checkpoints.filter((item) => item.tier === "known_good").slice(this.maxKnownGood)) {
      await fs.rm(this.checkpointPath(checkpoint.checkpointId), { force: true });
    }
    for (const checkpoint of checkpoints.filter((item) => item.tier === "partial").slice(this.maxKnownGood)) {
      await fs.rm(this.checkpointPath(checkpoint.checkpointId), { force: true });
    }
    const retained = await this.list();
    const referenced = new Set(retained.flatMap((checkpoint) => checkpoint.files.map((file) => file.digest)));
    await removeUnreferencedObjects(this.objectsDirectory(), referenced);
  }

  private async readCheckpoint(file: string): Promise<WorkspaceCheckpoint> {
    const checkpoint = JSON.parse(await fs.readFile(file, "utf8")) as WorkspaceCheckpoint;
    if (checkpoint.workspaceRoot !== this.root || !/^cp_[0-9a-f]{32}$/.test(checkpoint.checkpointId) || !Array.isArray(checkpoint.files)) throw new Error("Invalid workspace checkpoint");
    const paths = new Set<string>();
    for (const entry of checkpoint.files) {
      validateRelativePath(entry.path);
      if (!/^[0-9a-f]{64}$/.test(entry.digest) || paths.has(entry.path) || !Number.isInteger(entry.size) || entry.size < 0) throw new Error("Invalid workspace checkpoint file");
      paths.add(entry.path);
    }
    return checkpoint;
  }

  private async audit(eventType: string, runId: string, status: string, metadata: Record<string, string | number | boolean>, sessionId?: string): Promise<void> {
    await this.auditSink?.record({ sessionId, runId, eventType, status, metadata, createdAt: new Date().toISOString() });
  }

  private checkpointsDirectory(): string { return path.join(this.storageRoot, "checkpoints"); }
  private objectsDirectory(): string { return path.join(this.storageRoot, "objects"); }
  private checkpointPath(id: string): string { return path.join(this.checkpointsDirectory(), `${id}.json`); }
  private objectPath(digest: string): string { return path.join(this.objectsDirectory(), digest.slice(0, 2), digest); }
}

async function listManagedFiles(root: string, ignored: ReadonlySet<string>): Promise<string[]> {
  const files: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      if (entry.name.startsWith(".") || (entry.isDirectory() && ignored.has(entry.name))) continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile()) files.push(safeRelative(root, absolute));
    }
  };
  await visit(root);
  return files.sort();
}

async function replaceFile(source: string, target: string, mode?: number): Promise<void> {
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.veil-restore-${crypto.randomUUID()}`;
  await fs.copyFile(source, temporary);
  if (mode !== undefined) await fs.chmod(temporary, mode);
  await fs.rm(target, { force: true });
  await fs.rename(temporary, target);
}

async function assertNoSymlinkParents(root: string, target: string): Promise<void> {
  const relative = safeRelative(root, target);
  let current = root;
  for (const part of relative.split(/[\\/]/).slice(0, -1)) {
    current = path.join(current, part);
    try { if ((await fs.lstat(current)).isSymbolicLink()) throw new Error("Rollback target contains a symbolic-link parent"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
}

async function removeUnreferencedObjects(root: string, referenced: ReadonlySet<string>): Promise<void> {
  for (const directory of await fs.readdir(root, { withFileTypes: true })) {
    if (!directory.isDirectory()) continue;
    const absolute = path.join(root, directory.name);
    for (const object of await fs.readdir(absolute, { withFileTypes: true })) {
      if (object.isFile() && !referenced.has(object.name)) await fs.rm(path.join(absolute, object.name), { force: true });
    }
  }
}

async function hashFile(file: string): Promise<string> {
  const hash = crypto.createHash("sha256");
  const handle = await fs.open(file, "r");
  try {
    const buffer = Buffer.allocUnsafe(64 * 1024);
    while (true) { const { bytesRead } = await handle.read(buffer, 0, buffer.length, null); if (!bytesRead) break; hash.update(buffer.subarray(0, bytesRead)); }
  } finally { await handle.close(); }
  return hash.digest("hex");
}

async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${crypto.randomUUID()}`;
  const handle = await fs.open(temporary, "wx");
  try { await handle.writeFile(JSON.stringify(value), "utf8"); await handle.sync(); } finally { await handle.close(); }
  await fs.rename(temporary, file);
}

async function readJson(file: string): Promise<unknown | undefined> {
  try { return JSON.parse(await fs.readFile(file, "utf8")); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}

async function exists(file: string): Promise<boolean> { try { await fs.lstat(file); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; } }
function safeRelative(root: string, candidate: string): string { const relative = path.relative(root, candidate); if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("Checkpoint path escapes workspace"); return relative.replaceAll("\\", "/"); }
function validateRelativePath(relative: string): void { if (!relative || path.isAbsolute(relative) || relative.split(/[\\/]/).some((part) => !part || part === "." || part === "..")) throw new Error("Invalid checkpoint relative path"); }
function validateId(value: string, name: string): void { if (!/^[A-Za-z0-9_-]{3,160}$/.test(value)) throw new Error(`${name} must contain only safe identifier characters`); }
function positive(value: number, name: string): number { if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`); return value; }
