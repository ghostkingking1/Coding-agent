import fs from "node:fs/promises";
import { createTwoFilesPatch } from "diff";

const DEFAULT_CONTEXT_LINES = 3;
const DEFAULT_MAX_DIFF_CHARS = 64 * 1024;

export interface RunDiffFile {
  readonly path: string;
  readonly diff: string;
}

export interface RunDiff {
  readonly files: readonly RunDiffFile[];
  readonly text: string;
  readonly truncated: boolean;
}

interface TrackedFile {
  readonly absolutePath: string;
  readonly relativePath: string;
  readonly originalContent: string;
}

/** 记录一次 Agent 运行中成功写入文件的初始内容，并在结束时汇总最终差异。 */
export class RunChangeTracker {
  private readonly files = new Map<string, TrackedFile>();
  private readonly contextLines: number;
  private readonly maxDiffChars: number;

  constructor(options: { readonly contextLines?: number; readonly maxDiffChars?: number } = {}) {
    this.contextLines = options.contextLines ?? DEFAULT_CONTEXT_LINES;
    this.maxDiffChars = options.maxDiffChars ?? DEFAULT_MAX_DIFF_CHARS;
    if (!Number.isInteger(this.contextLines) || this.contextLines < 0) throw new Error("contextLines must be a non-negative integer");
    if (!Number.isInteger(this.maxDiffChars) || this.maxDiffChars < 1) throw new Error("maxDiffChars must be a positive integer");
  }

  /** 在第一次成功写入前保存原文；同一文件的后续 patch 继续使用这份快照。 */
  recordBeforeWrite(absolutePath: string, relativePath: string, originalContent: string): void {
    if (!this.files.has(absolutePath)) this.files.set(absolutePath, { absolutePath, relativePath, originalContent });
  }

  /** 读取当前文件并生成本次运行的最终差异。 */
  async finish(): Promise<RunDiff> {
    const files: RunDiffFile[] = [];
    for (const tracked of this.files.values()) {
      const finalContent = await fs.readFile(tracked.absolutePath, "utf8");
      if (tracked.originalContent === finalContent) continue;
      files.push({
        path: tracked.relativePath,
        diff: createTwoFilesPatch(`a/${diffPath(tracked.relativePath)}`, `b/${diffPath(tracked.relativePath)}`, normalizeLineEndings(tracked.originalContent), normalizeLineEndings(finalContent), "", "", { context: this.contextLines }),
      });
    }
    const text = files.map((file) => file.diff).join("\n");
    if (text.length <= this.maxDiffChars) return { files, text, truncated: false };
    return { files, text: `${text.slice(0, this.maxDiffChars)}\n... run diff truncated ...`, truncated: true };
  }
}

function normalizeLineEndings(content: string): string {
  return content.replace(/\r\n/g, "\n");
}

function diffPath(relativePath: string): string {
  return relativePath.replaceAll("\\", "/");
}
