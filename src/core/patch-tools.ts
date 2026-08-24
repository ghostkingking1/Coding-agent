import fs from "node:fs/promises";
import type { WorkspacePolicy } from "./security.ts";
import type { Tool } from "./types.ts";

export interface PatchChange {
  readonly path: string;
  readonly find: string;
  readonly replaceWith: string;
}

export interface PatchInput {
  readonly changes: readonly PatchChange[];
}

export interface PatchFileResult {
  readonly path: string;
  readonly changes: number;
}

export interface PatchPreview {
  readonly preview: string;
  readonly files: readonly PatchFileResult[];
}

export interface PatchResult extends PatchPreview {
  readonly applied: boolean;
}

interface PlannedPatch {
  readonly preview: string;
  readonly files: readonly PatchFileResult[];
  readonly writes: readonly { path: string; content: string }[];
}

const MAX_PATCH_CHANGES = 50;
const MAX_PREVIEW_CHARS = 20_000;

export function createPatchTool(policy: WorkspacePolicy): Tool {
  return {
    name: "apply_patch",
    description: "Preview and apply structured text replacements inside the workspace.",
    manifest: { capabilities: ["read", "write"] },
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
  return `${preview.slice(0, MAX_PREVIEW_CHARS)}\n... preview truncated ...`;
}

function throwIfAborted(signal?: AbortSignal): void {
  signal?.throwIfAborted();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
