import fs from "node:fs/promises";
import type { WorkspacePolicy } from "./security.ts";
import type { Tool, ToolInputSchema } from "./types.ts";

/** 描述一次基于精确文本匹配的文件变更。 */
export interface PatchChange {
  /** 工作区内的目标文件路径。 */
  readonly path: string;
  /** 必须唯一匹配的原始文本。 */
  readonly find: string;
  /** 用于替换原始文本的新文本；空字符串表示删除。 */
  readonly replaceWith: string;
}

/** patch 工具的输入结构。 */
export interface PatchInput {
  /** 按顺序应用的文件变更列表。 */
  readonly changes: readonly PatchChange[];
}

/** 单个文件在 patch 中的变更摘要。 */
export interface PatchFileResult {
  /** 相对于工作区根目录的文件路径。 */
  readonly path: string;
  /** 该文件应用的变更数量。 */
  readonly changes: number;
}

/** patch 预览结果，不包含实际写入内容。 */
export interface PatchPreview {
  /** 面向审批方和调用方展示的 unified diff 文本。 */
  readonly preview: string;
  /** 受影响文件的摘要。 */
  readonly files: readonly PatchFileResult[];
}

/** patch 应用成功后的结果。 */
export interface PatchResult extends PatchPreview {
  /** 是否已经完成写入。 */
  readonly applied: boolean;
}

interface PlannedPatch {
  readonly preview: string;
  readonly files: readonly PatchFileResult[];
  readonly writes: readonly { path: string; content: string }[];
}

const MAX_PATCH_CHANGES = 50;
const MAX_PREVIEW_CHARS = 20_000;
const patchInputSchema: ToolInputSchema = {
  type: "object",
  properties: {
    changes: {
      type: "array",
      minItems: 1,
      maxItems: MAX_PATCH_CHANGES,
      items: {
        type: "object",
        properties: {
          path: { type: "string", minLength: 1 },
          find: { type: "string", minLength: 1 },
          replaceWith: { type: "string" },
        },
        required: ["path", "find", "replaceWith"],
        additionalProperties: false,
      },
    },
  },
  required: ["changes"],
  additionalProperties: false,
};

/** 创建一个先生成 diff、再由审批策略决定是否执行写入的 patch 工具。 */
export function createPatchTool(policy: WorkspacePolicy): Tool {
  return {
    name: "apply_patch",
    description: "Preview and apply structured text replacements inside the workspace.",
    manifest: { capabilities: ["read", "write"], inputSchema: patchInputSchema },
    async preview(input, context) {
      const plan = await planPatch(policy, input, context);
      return { preview: plan.preview, files: plan.files } satisfies PatchPreview;
    },
    async execute(input, context) {
      const plan = await planPatch(policy, input, context);
      for (const write of plan.writes) {
        await fs.writeFile(write.path, write.content, "utf8");
      }
      return { applied: true, preview: plan.preview, files: plan.files } satisfies PatchResult;
    },
  };
}

async function planPatch(policy: WorkspacePolicy, input: unknown, context: { readonly signal?: AbortSignal }): Promise<PlannedPatch> {
  const value = assertPatchInput(input);
  if (value.changes.length === 0) throw new Error("changes must not be empty");
  if (value.changes.length > MAX_PATCH_CHANGES) {
    throw new Error(`changes must not exceed ${MAX_PATCH_CHANGES}`);
  }

  const loadedFiles = new Map<string, { content: string; relativePath: string; changes: number }>();
  const hunks: string[] = [];

  for (const change of value.changes) {
    throwIfAborted(context.signal);
    const find = assertFind(change.find, "find");
    const replaceWith = assertReplacement(change.replaceWith, "replaceWith");
    const resolved = policy.resolveFile(change.path);
    /** 同一文件的多处修改基于内存中的最新内容串行规划，避免后续匹配读到旧文件。 */
    const existing = loadedFiles.get(resolved.path) ?? {
      content: await fs.readFile(resolved.path, "utf8"),
      relativePath: policy.relative(resolved.path),
      changes: 0,
    };

    const applied = applyExactReplacement(existing.content, find, replaceWith, existing.relativePath, policy.maxFileBytes);
    existing.content = applied.content;
    existing.changes += 1;
    loadedFiles.set(resolved.path, existing);
    hunks.push(renderHunk(existing.relativePath, applied.startLine, find, replaceWith));
  }

  const files = [...loadedFiles.entries()].map(([path, value]) => ({ path: value.relativePath, changes: value.changes }));
  const preview = clampPreview(hunks.join("\n\n"));
  const writes = [...loadedFiles.entries()].map(([path, value]) => ({ path, content: value.content }));
  return { preview, files, writes };
}

function assertPatchInput(input: unknown): PatchInput {
  if (!isRecord(input)) throw new Error("Patch input must be an object");
  if (!Array.isArray(input.changes)) throw new Error("changes must be an array");
  return {
    changes: input.changes.map((change, index) => assertPatchChange(change, index)),
  };
}

function assertPatchChange(change: unknown, index: number): PatchChange {
  if (!isRecord(change)) throw new Error(`changes[${index}] must be an object`);
  return {
    path: assertPath(change.path, `changes[${index}].path`),
    find: assertFind(change.find, `changes[${index}].find`),
    replaceWith: assertReplacement(change.replaceWith, `changes[${index}].replaceWith`),
  };
}

function assertPath(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  if (value.includes("\0")) throw new Error(`${label} must not contain a null byte`);
  return value;
}

function assertFind(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} must be a non-empty string`);
  if (value.includes("\0")) throw new Error(`${label} must not contain a null byte`);
  return value;
}

function assertReplacement(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  if (value.includes("\0")) throw new Error(`${label} must not contain a null byte`);
  return value;
}

function applyExactReplacement(content: string, find: string, replaceWith: string, relativePath: string, maxFileBytes: number): { content: string; startLine: number } {
  const index = content.indexOf(find);
  if (index < 0) throw new Error(`Patch text not found in ${relativePath}`);
  /** 只接受唯一匹配，避免模糊修改错误位置。 */
  if (content.indexOf(find, index + find.length) >= 0) {
    throw new Error(`Patch text is ambiguous in ${relativePath}`);
  }
  const nextContent = `${content.slice(0, index)}${replaceWith}${content.slice(index + find.length)}`;
  if (Buffer.byteLength(nextContent, "utf8") > maxFileBytes) {
    throw new Error(`Patched file exceeds the ${maxFileBytes}-byte limit`);
  }
  if (nextContent.includes("\0")) throw new Error(`Patch would introduce a null byte in ${relativePath}`);
  return { content: nextContent, startLine: countLines(content.slice(0, index)) + 1 };
}

function renderHunk(relativePath: string, startLine: number, before: string, after: string): string {
  const beforeLines = splitLines(before);
  const afterLines = splitLines(after);
  return [
    `--- ${relativePath}`,
    `+++ ${relativePath}`,
    `@@ -${startLine},${lineCount(before)} +${startLine},${lineCount(after)} @@`,
    ...beforeLines.map((line) => `- ${line}`),
    ...afterLines.map((line) => `+ ${line}`),
  ].join("\n");
}

function splitLines(text: string): string[] {
  return text === "" ? [] : text.split(/\r?\n/);
}

function countLines(text: string): number {
  if (!text) return 0;
  return text.split(/\r?\n/).length - 1;
}

function lineCount(text: string): number {
  return splitLines(text).length;
}

function clampPreview(preview: string): string {
  if (preview.length <= MAX_PREVIEW_CHARS) return preview;
  /** 预览本身也必须有上限，避免审批上下文被超大 diff 占满。 */
  return `${preview.slice(0, MAX_PREVIEW_CHARS)}\n... preview truncated ...`;
}

function throwIfAborted(signal?: AbortSignal): void {
  signal?.throwIfAborted();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
