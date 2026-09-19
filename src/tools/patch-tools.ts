import fs from "node:fs/promises";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { applyPatchModelInputSchema } from "./model-tool-schemas.ts";
import type { WorkspacePolicy } from "./security.ts";
import { pathInputSchema, stringWithoutNullByteSchema } from "./tool-input-schemas.ts";
import { defineTool } from "./tool-schema.ts";
import type { PreparedToolOperation, Tool, ToolContext } from "../agent/types.ts";

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
  readonly writes: readonly { path: string; content: string; originalHash: string; mode: number }[];
  readonly originals: readonly { path: string; relativePath: string; content: string; hash: string }[];
}

interface PatchJournalEntry { readonly target: string; readonly temporary: string; readonly backup: string; state: "prepared" | "backed_up" | "applied"; }
interface PatchJournal { readonly version: 1; readonly transactionId: string; readonly workspaceRoot: string; readonly entries: PatchJournalEntry[]; }

export interface PatchTransactionOptions {
  /** 测试和平台适配层可注入 rename；生产默认使用带 Windows 重试的实现。 */
  readonly rename?: (source: string, target: string) => Promise<void>;
}

export class PreparedOperationStaleError extends Error {
  constructor(message: string) { super(message); this.name = "PreparedOperationStaleError"; }
}

const MAX_PATCH_CHANGES = 50;
const MAX_PREVIEW_CHARS = 20_000;
const patchInputSchema = z.object({
  changes: z.array(z.object({
    path: pathInputSchema,
    find: stringWithoutNullByteSchema.min(1),
    replaceWith: stringWithoutNullByteSchema,
  }).strict()).min(1).max(MAX_PATCH_CHANGES),
}).strict();

const patchChangeSchema = patchInputSchema.shape.changes.element;

/** 描述一次基于精确文本匹配的文件变更，由 Zod schema 自动推导。 */
export type PatchChange = z.output<typeof patchChangeSchema>;
/** patch 工具输入类型，由 Zod schema 自动推导。 */
export type PatchInput = z.output<typeof patchInputSchema>;

/** 创建一个先生成 diff、再由审批策略决定是否执行写入的 patch 工具。 */
export function createPatchTool(policy: WorkspacePolicy, transactionOptions: PatchTransactionOptions = {}): Tool {
  return defineTool({
    name: "apply_patch",
    description: "Preview and apply structured text replacements inside the workspace.",
    capabilities: ["read", "write"],
    inputSchema: patchInputSchema,
    modelInputSchema: applyPatchModelInputSchema,
    async preview(input, context) {
      const plan = await planPatch(policy, input, context);
      return { preview: plan.preview, files: plan.files } satisfies PatchPreview;
    },
    async prepare(input, context) {
      const plan = await planPatch(policy, input, context);
      return { operationId: `patch_${crypto.randomUUID()}`, preview: { preview: plan.preview, files: plan.files }, approvalDigest: patchPlanDigest(plan), payload: plan };
    },
    async executePrepared(operation, context) {
      return executePatchPlan(policy, preparedPatch(operation), context, transactionOptions);
    },
    async execute(input, context) {
      const plan = await planPatch(policy, input, context);
      return executePatchPlan(policy, plan, context, transactionOptions);
    },
  });
}

async function planPatch(policy: WorkspacePolicy, input: PatchInput, context: ToolContext): Promise<PlannedPatch> {
  const loadedFiles = new Map<string, { content: string; originalContent: string; originalHash: string; mode: number; relativePath: string; changes: number }>();
  const hunks: string[] = [];

  for (const change of input.changes) {
    throwIfAborted(context.signal);
    const resolved = policy.resolveFile(change.path);
    /** 同一文件的多处修改基于内存中的最新内容串行规划，避免后续匹配读到旧文件。 */
    let existing = loadedFiles.get(resolved.path);
    if (!existing) {
      const originalContent = await fs.readFile(resolved.path, "utf8");
      const stat = await fs.stat(resolved.path);
      existing = {
        content: originalContent,
        originalContent,
        originalHash: hashText(originalContent),
        mode: stat.mode,
        relativePath: policy.relative(resolved.path),
        changes: 0,
      };
    }

    const applied = applyExactReplacement(existing.content, change.find, change.replaceWith, existing.relativePath, policy.maxFileBytes);
    existing.content = applied.content;
    existing.changes += 1;
    loadedFiles.set(resolved.path, existing);
    hunks.push(renderHunk(existing.relativePath, applied.startLine, change.find, change.replaceWith));
  }

  const files = [...loadedFiles.entries()].map(([path, value]) => ({ path: value.relativePath, changes: value.changes }));
  const preview = clampPreview(hunks.join("\n\n"));
  const writes = [...loadedFiles.entries()].map(([path, value]) => ({ path, content: value.content, originalHash: value.originalHash, mode: value.mode }));
  const originals = [...loadedFiles.entries()].map(([path, value]) => ({ path, relativePath: value.relativePath, content: value.originalContent, hash: value.originalHash }));
  return { preview, files, writes, originals };
}

async function executePatchPlan(policy: WorkspacePolicy, plan: PlannedPatch, context: ToolContext, transactionOptions: PatchTransactionOptions): Promise<PatchResult> {
  for (const original of plan.originals) {
    const currentPath = policy.resolveFile(original.relativePath).path;
    const current = await fs.readFile(currentPath, "utf8");
    if (currentPath !== original.path || hashText(current) !== original.hash) {
      throw new PreparedOperationStaleError(`Prepared patch is stale for ${original.relativePath}`);
    }
  }
  for (const original of plan.originals) context.changeTracker?.recordBeforeWrite(original.path, original.relativePath, original.content);
  await applyPatchTransaction(policy.root, plan.writes, transactionOptions);
  return { applied: true, preview: plan.preview, files: plan.files };
}

function preparedPatch(operation: PreparedToolOperation): PlannedPatch {
  const plan = operation.payload as PlannedPatch | undefined;
  if (!plan || !Array.isArray(plan.writes) || !Array.isArray(plan.originals) || !Array.isArray(plan.files) || patchPlanDigest(plan) !== operation.approvalDigest) {
    throw new PreparedOperationStaleError("Prepared patch payload does not match its approval digest");
  }
  return plan;
}

function patchPlanDigest(plan: PlannedPatch): string {
  return crypto.createHash("sha256").update(JSON.stringify({
    files: plan.files,
    writes: plan.writes.map((write) => ({ path: write.path, originalHash: write.originalHash, contentHash: hashText(write.content), mode: write.mode })),
  })).digest("hex");
}

async function applyPatchTransaction(workspaceRoot: string, writes: PlannedPatch["writes"], options: PatchTransactionOptions): Promise<void> {
  const rename = options.rename ?? renameWithRetry;
  const transactionId = crypto.randomUUID();
  const entries: PatchJournalEntry[] = writes.map((write) => ({
    target: write.path,
    temporary: `${write.path}.veil-tmp-${transactionId}`,
    backup: `${write.path}.veil-bak-${transactionId}`,
    state: "prepared",
  }));
  const journal: PatchJournal = { version: 1, transactionId, workspaceRoot, entries };
  const journalPath = patchJournalPath(workspaceRoot, transactionId);
  await fs.mkdir(path.dirname(journalPath), { recursive: true });
  try {
    for (let index = 0; index < writes.length; index += 1) {
      const handle = await fs.open(entries[index]!.temporary, "wx", writes[index]!.mode);
      try { await handle.writeFile(writes[index]!.content, "utf8"); await handle.sync(); } finally { await handle.close(); }
      await fs.chmod(entries[index]!.temporary, writes[index]!.mode);
    }
    await saveJournal(journalPath, journal);
    for (const entry of entries) {
      await rename(entry.target, entry.backup);
      await syncDirectory(path.dirname(entry.target));
      entry.state = "backed_up";
      await saveJournal(journalPath, journal);
      await rename(entry.temporary, entry.target);
      await syncDirectory(path.dirname(entry.target));
      entry.state = "applied";
      await saveJournal(journalPath, journal);
    }
    await Promise.all(entries.map((entry) => fs.rm(entry.backup, { force: true })));
    await fs.rm(journalPath, { force: true });
  } catch (error) {
    try { await rollbackJournal(journal, rename); await fs.rm(journalPath, { force: true }); }
    catch (rollbackError) { throw new Error(`Patch transaction requires recovery: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`, { cause: error }); }
    throw error;
  } finally {
    await Promise.all(entries.map((entry) => fs.rm(entry.temporary, { force: true }).catch(() => undefined)));
  }
}

/** 由持有 workspace lease 的恢复流程显式调用，避免并发进程互相回滚。 */
export async function recoverPatchTransactions(workspaceRoot: string): Promise<number> {
  const directory = patchJournalDirectory(workspaceRoot);
  let names: string[];
  try { names = await fs.readdir(directory); } catch { return 0; }
  let recovered = 0;
  for (const name of names.filter((value) => value.endsWith(".json"))) {
    const journalPath = path.join(directory, name);
    const journal = JSON.parse(await fs.readFile(journalPath, "utf8")) as PatchJournal;
    validateJournal(journal, workspaceRoot);
    await rollbackJournal(journal);
    await fs.rm(journalPath, { force: true });
    recovered += 1;
  }
  return recovered;
}

async function rollbackJournal(journal: PatchJournal, rename: (source: string, target: string) => Promise<void> = renameWithRetry): Promise<void> {
  for (const entry of [...journal.entries].reverse()) {
    /** rename 与日志更新之间可能崩溃，以 backup 是否存在作为真实恢复依据。 */
    if (await pathExists(entry.backup)) {
      await fs.rm(entry.target, { force: true });
      await rename(entry.backup, entry.target);
    }
    await fs.rm(entry.temporary, { force: true });
  }
}

function validateJournal(journal: PatchJournal, workspaceRoot: string): void {
  if (!journal || journal.version !== 1 || !UUID_PATTERN.test(journal.transactionId) || path.resolve(journal.workspaceRoot) !== path.resolve(workspaceRoot) || !Array.isArray(journal.entries)) {
    throw new Error("Invalid patch journal workspace");
  }
  const targets = new Set<string>();
  for (const entry of journal.entries) {
    if (!entry || !["prepared", "backed_up", "applied"].includes(entry.state)) throw new Error("Invalid patch journal state");
    const relative = path.relative(workspaceRoot, entry.target);
    if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("Invalid patch journal target");
    if (targets.has(path.resolve(entry.target))) throw new Error("Duplicate patch journal target");
    targets.add(path.resolve(entry.target));
    if (entry.temporary !== `${entry.target}.veil-tmp-${journal.transactionId}` || entry.backup !== `${entry.target}.veil-bak-${journal.transactionId}`) {
      throw new Error("Invalid patch journal staging path");
    }
  }
}

async function saveJournal(journalPath: string, journal: PatchJournal): Promise<void> {
  const temporary = `${journalPath}.tmp`;
  const handle = await fs.open(temporary, "w");
  try { await handle.writeFile(JSON.stringify(journal), "utf8"); await handle.sync(); } finally { await handle.close(); }
  await renameWithRetry(temporary, journalPath);
  await syncDirectory(path.dirname(journalPath));
}

async function renameWithRetry(source: string, target: string): Promise<void> {
  const delays = [0, 25, 50, 100, 200];
  for (let attempt = 0; ; attempt += 1) {
    try { await fs.rename(source, target); return; }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (attempt >= delays.length - 1 || !["EPERM", "EBUSY", "EACCES"].includes(code ?? "")) throw error;
      await new Promise((resolve) => setTimeout(resolve, delays[attempt + 1]));
    }
  }
}

function patchJournalDirectory(workspaceRoot: string): string {
  const workspaceId = crypto.createHash("sha256").update(path.resolve(workspaceRoot)).digest("hex");
  return path.join(os.tmpdir(), "coding-agent-patch-journal", workspaceId);
}
function patchJournalPath(workspaceRoot: string, transactionId: string): string { return path.join(patchJournalDirectory(workspaceRoot), `${transactionId}.json`); }
function hashText(content: string): string { return crypto.createHash("sha256").update(content, "utf8").digest("hex"); }
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function pathExists(candidate: string): Promise<boolean> {
  try { await fs.lstat(candidate); return true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function syncDirectory(directory: string): Promise<void> {
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(directory, "r");
    await handle.sync();
  } catch (error) {
    /** Windows 不保证目录句柄支持 fsync；文件内容和 rename 仍已由前序步骤落盘。 */
    if (process.platform !== "win32" || !["EINVAL", "EPERM", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
  } finally {
    await handle?.close();
  }
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
