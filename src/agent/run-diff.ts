import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createTwoFilesPatch } from "diff";

const DEFAULT_CONTEXT_LINES = 3;
const DEFAULT_MAX_DIFF_CHARS = 64 * 1024;
const DEFAULT_MAX_FILE_BYTES = 1024 * 1024;
const DEFAULT_MAX_FILES = 5000;
const DEFAULT_MAX_SNAPSHOT_BYTES = 64 * 1024 * 1024;
const DEFAULT_IGNORED_DIRECTORIES = [".git", "node_modules"] as const;
const BASELINE_DIRECTORY_PREFIX = "coding-agent-baseline-";
const DEFAULT_STALE_BASELINE_AGE_MS = 24 * 60 * 60 * 1000;

export interface RunDiffFile { readonly path: string; readonly diff: string; }
export interface RunDiff {
  readonly sessionId: string;
  readonly runId: string;
  readonly files: readonly RunDiffFile[];
  readonly text: string;
  readonly truncated: boolean;
  readonly complete: boolean;
  readonly omittedPaths: readonly string[];
  readonly untrackedPaths: readonly string[];
}

export interface RunChangeTrackerOptions {
  readonly root?: string;
  readonly sessionId?: string;
  readonly runId?: string;
  readonly contextLines?: number;
  readonly maxDiffChars?: number;
  readonly maxFileBytes?: number;
  readonly maxFiles?: number;
  readonly maxSnapshotBytes?: number;
  readonly ignoredDirectories?: readonly string[];
}

/** 清理进程崩溃后遗留的项目专属 baseline 临时目录，不触碰其他临时目录。 */
export async function cleanupStaleBaselineDirectories(options: { readonly tempRoot?: string; readonly maxAgeMs?: number } = {}): Promise<void> {
  const tempRoot = options.tempRoot ?? os.tmpdir();
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_STALE_BASELINE_AGE_MS;
  assertInteger(maxAgeMs, "maxAgeMs", 1);
  let entries: import("node:fs").Dirent[];
  try { entries = await fs.readdir(tempRoot, { withFileTypes: true }); } catch { return; }
  const now = Date.now();
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(BASELINE_DIRECTORY_PREFIX)) continue;
    const directory = path.join(tempRoot, entry.name);
    try {
      const stat = await fs.stat(directory);
      if (now - stat.mtimeMs > maxAgeMs) await fs.rm(directory, { recursive: true, force: true });
    } catch {
      // 清理是兜底操作；单个目录失败不能影响 Agent 主流程。
    }
  }
}

interface SnapshotFile {
  readonly fileType: "text" | "binary" | "untracked";
  readonly size: number;
  readonly mtimeMs: number;
  readonly hash?: string;
  readonly baselinePath?: string;
}
interface WorkspaceSnapshot {
  readonly files: ReadonlyMap<string, SnapshotFile>;
  readonly complete: boolean;
  readonly omittedPaths: readonly string[];
  readonly untrackedPaths: readonly string[];
}
interface SnapshotOptions {
  readonly maxFileBytes: number;
  readonly maxFiles: number;
  readonly maxSnapshotBytes: number;
  readonly ignoredDirectories: ReadonlySet<string>;
}
interface FallbackFile { readonly absolutePath: string; readonly relativePath: string; readonly originalContent: string; }

/** 使用磁盘基线和轻量索引捕获整个 Agent run 的文件变化，避免把工作区内容留在内存。 */
export class RunChangeTracker {
  readonly sessionId: string;
  readonly runId: string;
  private readonly root?: string;
  private readonly contextLines: number;
  private readonly maxDiffChars: number;
  private readonly maxFileBytes: number;
  private readonly maxFiles: number;
  private readonly maxSnapshotBytes: number;
  private readonly ignoredDirectories: ReadonlySet<string>;
  private readonly fallbackFiles = new Map<string, FallbackFile>();
  private baseline?: WorkspaceSnapshot;
  private baselineDirectory?: string;
  private temporaryRoot?: string;

  constructor(options: RunChangeTrackerOptions = {}) {
    this.sessionId = options.sessionId ?? `sess_${crypto.randomUUID()}`;
    this.runId = options.runId ?? `run_${crypto.randomUUID()}`;
    validateId(this.sessionId, "sessionId");
    validateId(this.runId, "runId");
    this.root = options.root === undefined ? undefined : path.resolve(options.root);
    this.contextLines = options.contextLines ?? DEFAULT_CONTEXT_LINES;
    this.maxDiffChars = options.maxDiffChars ?? DEFAULT_MAX_DIFF_CHARS;
    this.maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
    this.maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
    this.maxSnapshotBytes = options.maxSnapshotBytes ?? DEFAULT_MAX_SNAPSHOT_BYTES;
    this.ignoredDirectories = new Set(options.ignoredDirectories ?? DEFAULT_IGNORED_DIRECTORIES);
    assertInteger(this.contextLines, "contextLines", 0);
    assertInteger(this.maxDiffChars, "maxDiffChars", 1);
    assertInteger(this.maxFileBytes, "maxFileBytes", 1);
    assertInteger(this.maxFiles, "maxFiles", 1);
    assertInteger(this.maxSnapshotBytes, "maxSnapshotBytes", 1);
  }

  /** 创建唯一 baseline 目录；mkdtemp 由操作系统排他创建，避免目录冲突和覆盖。 */
  async start(): Promise<void> {
    if (!this.root || this.baseline) return;
    this.temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "coding-agent-baseline-"));
    this.baselineDirectory = path.join(this.temporaryRoot, this.sessionId, this.runId, "baseline");
    await fs.mkdir(this.baselineDirectory, { recursive: true });
    this.baseline = await snapshotWorkspace(this.root, this.snapshotOptions(), this.baselineDirectory);
  }

  /** 保留无 root 的直接工具测试兼容入口；正式运行以工作区快照为准。 */
  recordBeforeWrite(absolutePath: string, relativePath: string, originalContent: string): void {
    if (!this.fallbackFiles.has(absolutePath)) this.fallbackFiles.set(absolutePath, { absolutePath, relativePath, originalContent });
  }

  /** 比较运行前后的索引，只读取变化且具备基线的文件来生成 diff。 */
  async finish(): Promise<RunDiff> {
    const result = !this.root || !this.baseline ? await this.finishFallback() : await this.finishSnapshot();
    await this.dispose();
    return result;
  }

  /** 异常、取消或超时时释放临时基线目录。 */
  async dispose(): Promise<void> {
    if (!this.baselineDirectory) return;
    const directory = this.temporaryRoot ?? this.baselineDirectory;
    this.baselineDirectory = undefined;
    this.temporaryRoot = undefined;
    await fs.rm(directory, { recursive: true, force: true });
  }

  private async finishSnapshot(): Promise<RunDiff> {
    const after = await snapshotWorkspace(this.root!, this.snapshotOptions());
    const before = this.baseline!;
    const paths = [...new Set([...before.files.keys(), ...after.files.keys()])].sort();
    const files: RunDiffFile[] = [];
    for (const relativePath of paths) {
      const oldFile = before.files.get(relativePath);
      const newFile = after.files.get(relativePath);
      if (oldFile?.fileType === "untracked" || newFile?.fileType === "untracked") continue;
      if (sameMetadata(oldFile, newFile)) continue;
      files.push({ path: relativePath, diff: await renderDiff(relativePath, oldFile, newFile, this.baselineDirectory, this.root!, this.contextLines) });
    }
    return buildResult(this.sessionId, this.runId, files, this.maxDiffChars, before.complete && after.complete, unique([...before.omittedPaths, ...after.omittedPaths]), unique([...before.untrackedPaths, ...after.untrackedPaths]));
  }

  private async finishFallback(): Promise<RunDiff> {
    const files: RunDiffFile[] = [];
    for (const tracked of this.fallbackFiles.values()) {
      const finalContent = await fs.readFile(tracked.absolutePath, "utf8");
      if (tracked.originalContent !== finalContent) files.push({ path: tracked.relativePath, diff: createTextDiff(tracked.relativePath, tracked.originalContent, finalContent, this.contextLines) });
    }
    return buildResult(this.sessionId, this.runId, files, this.maxDiffChars, true, [], []);
  }

  private snapshotOptions(): SnapshotOptions {
    return { maxFileBytes: this.maxFileBytes, maxFiles: this.maxFiles, maxSnapshotBytes: this.maxSnapshotBytes, ignoredDirectories: this.ignoredDirectories };
  }
}

async function snapshotWorkspace(root: string, options: SnapshotOptions, baselineDirectory?: string): Promise<WorkspaceSnapshot> {
  const resolvedRoot = await fs.realpath(root);
  const files = new Map<string, SnapshotFile>();
  const omittedPaths: string[] = [];
  const untrackedPaths: string[] = [];
  let complete = true;
  let snapshotBytes = 0;

  async function visit(directory: string): Promise<void> {
    let entries: import("node:fs").Dirent[];
    try { entries = await fs.readdir(directory, { withFileTypes: true }); } catch { complete = false; omittedPaths.push(relativePath(resolvedRoot, directory)); return; }
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (entry.name.startsWith(".") || (entry.isDirectory() && options.ignoredDirectories.has(entry.name))) continue;
      const absolutePath = path.join(directory, entry.name);
      const relative = relativePath(resolvedRoot, absolutePath);
      if (entry.isDirectory()) { await visit(absolutePath); continue; }
      if (!entry.isFile()) continue;
      if (files.size >= options.maxFiles) {
        complete = false;
        untrackedPaths.push(relative);
        files.set(relative, { fileType: "untracked", size: 0, mtimeMs: 0 });
        continue;
      }
      try {
        const beforeStat = await fs.stat(absolutePath);
        if (beforeStat.size > options.maxFileBytes || snapshotBytes + beforeStat.size > options.maxSnapshotBytes) {
          complete = false;
          untrackedPaths.push(relative);
          files.set(relative, { fileType: "untracked", size: beforeStat.size, mtimeMs: beforeStat.mtimeMs });
          continue;
        }
        const hash = await hashFile(absolutePath);
        const afterStat = await fs.stat(absolutePath);
        if (beforeStat.size !== afterStat.size || beforeStat.mtimeMs !== afterStat.mtimeMs) { complete = false; omittedPaths.push(relative); continue; }
        const binary = await isBinaryFile(absolutePath);
        let baselinePath: string | undefined;
        if (baselineDirectory && !binary) {
          baselinePath = path.join(baselineDirectory, relative);
          await fs.mkdir(path.dirname(baselinePath), { recursive: true });
          await fs.copyFile(absolutePath, baselinePath);
          if (hash !== await hashFile(baselinePath)) {
            complete = false;
            omittedPaths.push(relative);
            continue;
          }
        }
        snapshotBytes += beforeStat.size;
        files.set(relative, { fileType: binary ? "binary" : "text", size: beforeStat.size, mtimeMs: beforeStat.mtimeMs, hash, baselinePath });
      } catch { complete = false; omittedPaths.push(relative); }
    }
  }
  await visit(resolvedRoot);
  return { files, complete, omittedPaths: unique(omittedPaths), untrackedPaths: unique(untrackedPaths) };
}

async function hashFile(file: string): Promise<string> {
  const hash = crypto.createHash("sha256");
  const handle = await fs.open(file, "r");
  try {
    const buffer = Buffer.allocUnsafe(64 * 1024);
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally { await handle.close(); }
  return hash.digest("hex");
}

async function isBinaryFile(file: string): Promise<boolean> {
  const handle = await fs.open(file, "r");
  try {
    const buffer = Buffer.alloc(8192);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead).includes(0);
  } finally { await handle.close(); }
}

function sameMetadata(before: SnapshotFile | undefined, after: SnapshotFile | undefined): boolean {
  return !!before && !!after && before.fileType !== "untracked" && after.fileType !== "untracked" && before.hash === after.hash;
}

async function renderDiff(relative: string, before: SnapshotFile | undefined, after: SnapshotFile | undefined, baselineDirectory: string | undefined, root: string, context: number): Promise<string> {
  if (before?.fileType === "binary" || after?.fileType === "binary") return `Binary files a/${diffPath(relative)} and b/${diffPath(relative)} differ`;
  const oldContent = before?.baselinePath ? await fs.readFile(before.baselinePath, "utf8") : "";
  const newContent = after ? await fs.readFile(path.join(root, relative), "utf8") : "";
  return createTextDiff(relative, oldContent, newContent, context);
}

function createTextDiff(relative: string, before: string, after: string, context: number): string {
  return createTwoFilesPatch(`a/${diffPath(relative)}`, `b/${diffPath(relative)}`, normalize(before), normalize(after), "", "", { context });
}

function buildResult(sessionId: string, runId: string, files: readonly RunDiffFile[], maxChars: number, complete: boolean, omittedPaths: readonly string[], untrackedPaths: readonly string[]): RunDiff {
  const rawText = files.map((file) => file.diff).join("\n");
  const truncated = rawText.length > maxChars;
  return { sessionId, runId, files, text: truncated ? `${rawText.slice(0, maxChars)}\n... run diff truncated ...` : rawText, truncated, complete, omittedPaths, untrackedPaths };
}

function normalize(content: string): string { return content.replace(/\r\n/g, "\n"); }
function diffPath(relative: string): string { return relative.replaceAll("\\", "/"); }
function relativePath(root: string, file: string): string { return diffPath(path.relative(root, file)); }
function unique(values: readonly string[]): string[] { return [...new Set(values)].filter(Boolean).sort(); }
function validateId(value: string, name: string): void { if (!/^[A-Za-z0-9_-]{3,160}$/.test(value)) throw new Error(`${name} must contain only safe identifier characters`); }
function assertInteger(value: number, name: string, minimum: number): void { if (!Number.isInteger(value) || value < minimum) throw new Error(`${name} must be an integer >= ${minimum}`); }
