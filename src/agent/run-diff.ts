import fs from "node:fs/promises";
import path from "node:path";
import { createTwoFilesPatch } from "diff";

const DEFAULT_CONTEXT_LINES = 3;
const DEFAULT_MAX_DIFF_CHARS = 64 * 1024;
const DEFAULT_MAX_FILE_BYTES = 1024 * 1024;
const DEFAULT_MAX_FILES = 5000;
const DEFAULT_IGNORED_DIRECTORIES = [".git", "node_modules"] as const;

export interface RunDiffFile {
  readonly path: string;
  readonly diff: string;
}

export interface RunDiff {
  readonly files: readonly RunDiffFile[];
  readonly text: string;
  readonly truncated: boolean;
  readonly complete: boolean;
  readonly omittedPaths: readonly string[];
}

export interface RunChangeTrackerOptions {
  readonly root?: string;
  readonly contextLines?: number;
  readonly maxDiffChars?: number;
  readonly maxFileBytes?: number;
  readonly maxFiles?: number;
  readonly ignoredDirectories?: readonly string[];
}

interface SnapshotFile {
  readonly content: Buffer;
  readonly binary: boolean;
}

interface WorkspaceSnapshot {
  readonly files: ReadonlyMap<string, SnapshotFile>;
  readonly complete: boolean;
  readonly omittedPaths: readonly string[];
}

interface SnapshotOptions {
  readonly maxFileBytes: number;
  readonly maxFiles: number;
  readonly ignoredDirectories: ReadonlySet<string>;
}

interface FallbackFile {
  readonly absolutePath: string;
  readonly relativePath: string;
  readonly originalContent: string;
}

/** 以运行前后的工作区快照为准，捕获 patch、命令和测试脚本产生的文件变化。 */
export class RunChangeTracker {
  private readonly root?: string;
  private readonly contextLines: number;
  private readonly maxDiffChars: number;
  private readonly maxFileBytes: number;
  private readonly maxFiles: number;
  private readonly ignoredDirectories: ReadonlySet<string>;
  private baseline?: WorkspaceSnapshot;
  private readonly fallbackFiles = new Map<string, FallbackFile>();

  constructor(options: RunChangeTrackerOptions = {}) {
    this.root = options.root === undefined ? undefined : path.resolve(options.root);
    this.contextLines = options.contextLines ?? DEFAULT_CONTEXT_LINES;
    this.maxDiffChars = options.maxDiffChars ?? DEFAULT_MAX_DIFF_CHARS;
    this.maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
    this.maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
    this.ignoredDirectories = new Set(options.ignoredDirectories ?? DEFAULT_IGNORED_DIRECTORIES);
    assertInteger(this.contextLines, "contextLines", 0);
    assertInteger(this.maxDiffChars, "maxDiffChars", 1);
    assertInteger(this.maxFileBytes, "maxFileBytes", 1);
    assertInteger(this.maxFiles, "maxFiles", 1);
  }

  /** 在模型和工具循环之前建立快照，保证运行前用户已有修改不被计入。 */
  async start(): Promise<void> {
    if (!this.root || this.baseline) return;
    this.baseline = await snapshotWorkspace(this.root, this.snapshotOptions());
  }

  /** 保留无工作区 root 的直接工具测试和嵌入场景；正式 CLI 使用前后快照。 */
  recordBeforeWrite(absolutePath: string, relativePath: string, originalContent: string): void {
    if (!this.fallbackFiles.has(absolutePath)) this.fallbackFiles.set(absolutePath, { absolutePath, relativePath, originalContent });
  }

  /** 比较运行前后的文件集合，识别新增、修改、删除和二进制文件。 */
  async finish(): Promise<RunDiff> {
    if (!this.root || !this.baseline) return this.finishFallback();
    const after = await snapshotWorkspace(this.root, this.snapshotOptions());
    const paths = [...new Set([...this.baseline.files.keys(), ...after.files.keys()])].sort();
    const files: RunDiffFile[] = [];
    for (const relativePath of paths) {
      const before = this.baseline.files.get(relativePath);
      const current = after.files.get(relativePath);
      if (before && current && buffersEqual(before.content, current.content)) continue;
      files.push({ path: relativePath, diff: renderDiff(relativePath, before, current, this.contextLines) });
    }
    return buildResult(files, this.maxDiffChars, this.baseline.complete && after.complete, unique([...this.baseline.omittedPaths, ...after.omittedPaths]));
  }

  private async finishFallback(): Promise<RunDiff> {
    const files: RunDiffFile[] = [];
    for (const tracked of this.fallbackFiles.values()) {
      const finalContent = await fs.readFile(tracked.absolutePath, "utf8");
      if (tracked.originalContent === finalContent) continue;
      files.push({ path: tracked.relativePath, diff: renderDiff(tracked.relativePath, { content: Buffer.from(tracked.originalContent), binary: tracked.originalContent.includes("\0") }, { content: Buffer.from(finalContent), binary: finalContent.includes("\0") }, this.contextLines) });
    }
    return buildResult(files, this.maxDiffChars, true, []);
  }

  private snapshotOptions(): SnapshotOptions {
    return { maxFileBytes: this.maxFileBytes, maxFiles: this.maxFiles, ignoredDirectories: this.ignoredDirectories };
  }
}

async function snapshotWorkspace(root: string, options: SnapshotOptions): Promise<WorkspaceSnapshot> {
  const resolvedRoot = await fs.realpath(root);
  const files = new Map<string, SnapshotFile>();
  const omittedPaths: string[] = [];
  let complete = true;

  async function visit(directory: string): Promise<void> {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch {
      complete = false;
      omittedPaths.push(relativePath(resolvedRoot, directory));
      return;
    }
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (entry.name.startsWith(".")) continue;
      if (entry.isDirectory() && options.ignoredDirectories.has(entry.name)) continue;
      const absolutePath = path.join(directory, entry.name);
      const relative = relativePath(resolvedRoot, absolutePath);
      if (entry.isDirectory()) {
        await visit(absolutePath);
        continue;
      }
      if (!entry.isFile()) continue;
      if (files.size >= options.maxFiles) {
        complete = false;
        omittedPaths.push(relative);
        continue;
      }
      try {
        const stat = await fs.stat(absolutePath);
        if (stat.size > options.maxFileBytes) {
          complete = false;
          omittedPaths.push(relative);
          continue;
        }
        const content = await fs.readFile(absolutePath);
        files.set(relative, { content, binary: content.includes(0) });
      } catch {
        complete = false;
        omittedPaths.push(relative);
      }
    }
  }

  await visit(resolvedRoot);
  return { files, complete, omittedPaths: unique(omittedPaths) };
}

function renderDiff(relative: string, before: SnapshotFile | undefined, after: SnapshotFile | undefined, context: number): string {
  if (before?.binary || after?.binary) return `Binary files a/${diffPath(relative)} and b/${diffPath(relative)} differ`;
  return createTwoFilesPatch(`a/${diffPath(relative)}`, `b/${diffPath(relative)}`, normalize(before?.content.toString("utf8") ?? ""), normalize(after?.content.toString("utf8") ?? ""), "", "", { context });
}

function buildResult(files: readonly RunDiffFile[], maxChars: number, complete: boolean, omittedPaths: readonly string[]): RunDiff {
  const rawText = files.map((file) => file.diff).join("\n");
  const truncated = rawText.length > maxChars;
  return { files, text: truncated ? `${rawText.slice(0, maxChars)}\n... run diff truncated ...` : rawText, truncated, complete, omittedPaths };
}

function emptyResult(complete: boolean, omittedPaths: readonly string[]): RunDiff {
  return { files: [], text: "", truncated: false, complete, omittedPaths };
}

function normalize(content: string): string {
  return content.replace(/\r\n/g, "\n");
}

function diffPath(relative: string): string {
  return relative.replaceAll("\\", "/");
}

function relativePath(root: string, file: string): string {
  return diffPath(path.relative(root, file));
}

function buffersEqual(left: Buffer, right: Buffer): boolean {
  return left.equals(right);
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)].filter(Boolean).sort();
}

function assertInteger(value: number, name: string, minimum: number): void {
  if (!Number.isInteger(value) || value < minimum) throw new Error(`${name} must be an integer >= ${minimum}`);
}
