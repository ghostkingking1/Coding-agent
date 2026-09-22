import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { defineTool } from "../tools/tool-schema.ts";
import type { Tool, ToolCapability } from "./types.ts";

export type ExecutionMode = "plan" | "execute";
export type AccessMode = "ask" | "full";
export type ApprovalDecision = "once" | "session" | "deny";

export interface WorkModeState {
  readonly executionMode: ExecutionMode;
  readonly accessMode: AccessMode;
}

export interface PlanCommandScope {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
}

export interface PlanScope {
  readonly capabilities: readonly ToolCapability[];
  readonly tools: readonly string[];
  /** 文件使用工作区相对路径；以 / 结尾表示允许整个目录。 */
  readonly paths: readonly string[];
  /** 命令、参数和 cwd 必须完全相同，避免计划被扩大为任意终端权限。 */
  readonly commands: readonly PlanCommandScope[];
}

const planScopeSchema = z.object({
  capabilities: z.array(z.enum(["read", "write", "execute", "network"])).default([]),
  tools: z.array(z.string().min(1)).default([]),
  paths: z.array(z.string().min(1)).default([]),
  commands: z.array(z.object({ command: z.string().min(1), args: z.array(z.string()).default([]), cwd: z.string().min(1).default(".") }).strict()).default([]),
}).strict();

/** REPL 会话级工作模式；模型输出不能修改该状态。 */
export class WorkModeController {
  private stateValue: WorkModeState = { executionMode: "execute", accessMode: "ask" };
  private readonly grants = new Set<string>();
  private activePlanValue?: PlanDocument;

  get state(): WorkModeState { return this.stateValue; }
  get executionMode(): ExecutionMode { return this.stateValue.executionMode; }
  get accessMode(): AccessMode { return this.stateValue.accessMode; }
  get activePlan(): PlanDocument | undefined { return this.activePlanValue; }

  setPlan(): WorkModeState {
    this.stateValue = { executionMode: "plan", accessMode: "ask" };
    this.activePlanValue = undefined;
    return this.stateValue;
  }

  setExecute(): WorkModeState {
    // /mode execute 不会隐式退出 full；用户必须使用 /mode execute normal。
    this.stateValue = { ...this.stateValue, executionMode: "execute" };
    return this.stateValue;
  }

  setNormalExecute(): WorkModeState {
    this.stateValue = { executionMode: "execute", accessMode: "ask" };
    return this.stateValue;
  }

  setActivePlan(plan: PlanDocument | undefined): void { this.activePlanValue = plan; }

  setFullExecute(): WorkModeState {
    this.stateValue = { executionMode: "execute", accessMode: "full" };
    return this.stateValue;
  }

  hasGrant(key: string): boolean { return this.grants.has(key); }
  grant(key: string): void { this.grants.add(key); }
  clearGrants(): void { this.grants.clear(); }
}

/** 审批绑定工具和完整参数；参数任一变化都会生成新的授权键。 */
export function approvalKey(toolName: string, input: unknown, approvalDigest?: string): string {
  const canonical = JSON.stringify({ toolName, input: canonicalize(input), approvalDigest: approvalDigest ?? null });
  return crypto.createHash("sha256").update(canonical, "utf8").digest("hex");
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonicalize(item)]));
  }
  return value;
}

export type PlanStatus = "planning" | "planned" | "awaiting-approval" | "executing" | "validating" | "completed" | "blocked" | "needs-plan-update" | "cancelled";

export interface PlanDocument {
  readonly taskId: string;
  readonly sessionId: string;
  readonly version: number;
  readonly status: PlanStatus;
  readonly hash: string;
  readonly body: string;
  readonly updatedAt: string;
  readonly scope: PlanScope;
}

export class PlanIntegrityError extends Error {
  constructor(message: string) { super(message); this.name = "PlanIntegrityError"; }
}

export class PlanScopeViolationError extends Error {
  readonly taskId: string;
  constructor(taskId: string, message: string) { super(message); this.taskId = taskId; this.name = "PlanScopeViolationError"; }
}

/** 返回越界原因；undefined 表示工具调用仍在已批准的计划范围内。 */
export function planScopeViolation(plan: PlanDocument, tool: Pick<Tool, "name" | "manifest">, input: unknown, workspaceRoot: string): string | undefined {
  if (tool.name === "write_plan") return undefined;
  const effectCapabilities = tool.manifest?.capabilities.filter((item) => item !== "read") ?? [];
  const toolAllowed = plan.scope.tools.includes(tool.name)
    || (effectCapabilities.length > 0 && effectCapabilities.every((item) => plan.scope.capabilities.includes(item)));
  if (!toolAllowed) return `Tool ${tool.name} is outside plan scope`;

  const value = input && typeof input === "object" ? input as Record<string, unknown> : {};
  if (tool.name === "apply_patch") {
    const changes = Array.isArray(value.changes) ? value.changes : [];
    for (const change of changes) {
      const candidate = change && typeof change === "object" ? (change as Record<string, unknown>).path : undefined;
      if (typeof candidate !== "string" || !scopeAllowsPath(plan.scope.paths, candidate, workspaceRoot)) return `Path ${String(candidate)} is outside plan scope`;
    }
  }
  if (tool.name === "run_command") {
    const command = typeof value.command === "string" ? value.command : "";
    const args = Array.isArray(value.args) && value.args.every((item) => typeof item === "string") ? value.args as string[] : [];
    const cwd = typeof value.cwd === "string" ? value.cwd : ".";
    if (!plan.scope.commands.some((item) => item.command === command && item.cwd === normalizeScopePath(cwd) && arraysEqual(item.args, args))) return `Command ${command} is outside plan scope`;
  }
  if (tool.name === "run_tests") {
    const script = typeof value.script === "string" ? value.script : "test";
    const args = Array.isArray(value.args) && value.args.every((item) => typeof item === "string") ? value.args as string[] : [];
    const cwd = typeof value.cwd === "string" ? value.cwd : ".";
    const commandArgs = ["run", script, "--", ...args];
    if (!plan.scope.commands.some((item) => item.command === "npm" && item.cwd === normalizeScopePath(cwd) && arraysEqual(item.args, commandArgs))) return `Test command npm ${commandArgs.join(" ")} is outside plan scope`;
  }
  return undefined;
}

function scopeAllowsPath(allowedPaths: readonly string[], candidate: string, workspaceRoot: string): boolean {
  const normalizedCandidate = comparablePath(path.resolve(workspaceRoot, candidate));
  return allowedPaths.some((entry) => {
    const directory = /[\\/]$/.test(entry);
    const normalized = comparablePath(path.resolve(workspaceRoot, entry));
    if (directory) return normalizedCandidate === normalized || normalizedCandidate.startsWith(`${normalized}/`);
    return normalizedCandidate === normalized;
  });
}

function normalizeScopePath(value: string): string { return value.replaceAll("\\", "/").replace(/^\.\//, ""); }
function comparablePath(value: string): string { const normalized = normalizeScopePath(path.normalize(value)); return process.platform === "win32" ? normalized.toLowerCase() : normalized; }
function arraysEqual(left: readonly string[], right: readonly string[]): boolean { return left.length === right.length && left.every((item, index) => item === right[index]); }

/** 计划状态只能沿显式边迁移，避免恢复时把拒绝或越界误判成完成。 */
export class PlanTaskStateMachine {
  private readonly currentValue: PlanStatus;

  constructor(current: PlanStatus = "planning") { this.currentValue = current; }

  get current(): PlanStatus { return this.currentValue; }

  canTransition(next: PlanStatus): boolean {
    if (this.currentValue === next) return true;
    const allowed: Record<PlanStatus, readonly PlanStatus[]> = {
      planning: ["planned", "blocked", "cancelled"],
      planned: ["awaiting-approval", "executing", "blocked", "cancelled"],
      "awaiting-approval": ["planned", "executing", "blocked", "cancelled"],
      executing: ["validating", "planned", "needs-plan-update", "blocked", "cancelled"],
      validating: ["completed", "planned", "needs-plan-update", "blocked", "cancelled"],
      completed: ["planned"],
      blocked: ["planned", "cancelled"],
      "needs-plan-update": ["planning", "planned", "cancelled"],
      cancelled: [],
    };
    return allowed[this.currentValue].includes(next);
  }

  transition(next: PlanStatus): PlanTaskStateMachine {
    if (!this.canTransition(next)) throw new Error(`Invalid plan state transition: ${this.currentValue} -> ${next}`);
    return new PlanTaskStateMachine(next);
  }
}

/** 将计划保存为用户和模型都能阅读的 Markdown；front matter 只承载恢复索引。 */
export class PlanStore {
  readonly directory: string;
  private currentTaskId?: string;

  readonly workspaceRoot: string;
  private database?: DatabaseSync;

  constructor(workspaceRoot: string) {
    this.workspaceRoot = workspaceRoot;
    this.directory = path.join(workspaceRoot, ".veil", "plans");
  }

  setCurrentTask(taskId = `task-${crypto.randomUUID()}`): string {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(taskId)) throw new Error("Invalid plan task id");
    this.currentTaskId = taskId;
    return taskId;
  }
  getCurrentTask(): string | undefined { return this.currentTaskId; }
  filePath(taskId = this.currentTaskId): string {
    if (!taskId) throw new Error("No active plan task");
    return path.join(this.directory, `${taskId}.md`);
  }

  async write(body: string, sessionId: string, taskId = this.currentTaskId): Promise<PlanDocument> {
    return this.writeScoped(body, emptyPlanScope(), sessionId, taskId);
  }

  async writeScoped(body: string, scope: PlanScope, sessionId: string, taskId = this.currentTaskId): Promise<PlanDocument> {
    if (!body.trim()) throw new Error("Plan body must not be empty");
    validatePlanBody(body);
    const normalizedScope = normalizePlanScope(scope);
    const activeTaskId = taskId ?? this.setCurrentTask();
    const file = this.filePath(activeTaskId);
    await fs.mkdir(this.directory, { recursive: true });
    let previous: PlanDocument | undefined;
    try { previous = await this.read(activeTaskId); }
    catch (error) {
      if (!isMissingFileError(error)) throw error;
    }
    const version = (previous?.version ?? 0) + 1;
    const updatedAt = new Date().toISOString();
    const hash = crypto.createHash("sha256").update(body.trim(), "utf8").digest("hex");
    const document: PlanDocument = { taskId: activeTaskId, sessionId, version, status: "awaiting-approval", hash, body: body.trim(), updatedAt, scope: normalizedScope };
    const frontMatter = serializeFrontMatter(document);
    const temporary = `${file}.tmp-${crypto.randomUUID()}`;
    try {
      await fs.writeFile(temporary, `${frontMatter}${document.body}\n`, "utf8");
      // 先提交索引再替换 Markdown；进程中断会留下可检测的不一致，而不是静默采用半次写入。
      this.upsertIndex(document, file);
      await fs.rename(temporary, file);
    } finally { await fs.rm(temporary, { force: true }).catch(() => undefined); }
    return document;
  }

  async read(taskId = this.currentTaskId): Promise<PlanDocument> {
    const file = this.filePath(taskId);
    const text = await fs.readFile(file, "utf8");
    const match = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
    if (!match) throw new Error("Invalid plan document front matter");
    const fields = new Map(match[1]!.split("\n").map((line) => { const index = line.indexOf(":"); return [line.slice(0, index), line.slice(index + 1).trim()] as const; }));
    const body = match[2]!.trim();
    const hash = crypto.createHash("sha256").update(body, "utf8").digest("hex");
    if (hash !== fields.get("hash")) throw new PlanIntegrityError(`Plan document hash mismatch: ${path.basename(file)}`);
    const version = Number(fields.get("version"));
    if (!Number.isInteger(version) || version < 1) throw new Error("Invalid plan version");
    const status = parsePlanStatus(fields.get("status"));
    const scope = parsePlanScope(fields.get("scope"));
    const document = { taskId: fields.get("taskId") ?? (() => { throw new Error("Plan taskId missing"); })(), sessionId: fields.get("sessionId") ?? "", version, status, hash, body, updatedAt: fields.get("updatedAt") ?? "", scope };
    if (taskId && document.taskId !== taskId) throw new PlanIntegrityError(`Plan taskId does not match filename: ${path.basename(file)}`);
    this.assertIndex(document, file);
    return document;
  }

  /** 原子更新状态但不增加计划版本；版本只代表计划正文的单调变更。 */
  async updateStatus(taskId: string, status: PlanStatus): Promise<PlanDocument> {
    const current = await this.read(taskId);
    new PlanTaskStateMachine(current.status).transition(status);
    const updatedAt = new Date().toISOString();
    const file = this.filePath(taskId);
    const document: PlanDocument = { ...current, status, updatedAt };
    const frontMatter = serializeFrontMatter(document);
    const temporary = `${file}.tmp-${crypto.randomUUID()}`;
    await fs.writeFile(temporary, `${frontMatter}${current.body}\n`, "utf8");
    try { this.upsertIndex(document, file); await fs.rename(temporary, file); } finally { await fs.rm(temporary, { force: true }).catch(() => undefined); }
    return document;
  }

  async markNeedsPlanUpdate(taskId = this.currentTaskId): Promise<PlanDocument> {
    if (!taskId) throw new Error("No active plan task");
    return this.updateStatus(taskId, "needs-plan-update");
  }

  async listUnfinished(): Promise<PlanDocument[]> {
    let names: string[];
    try { names = await fs.readdir(this.directory); }
    catch (error) { if (isMissingFileError(error)) return []; throw error; }
    const indexed = this.index().prepare("SELECT task_id, path FROM plans").all() as unknown as { task_id: string; path: string }[];
    const markdownNames = new Set(names.filter((item) => item.endsWith(".md")));
    for (const row of indexed) if (!markdownNames.has(`${row.task_id}.md`) || path.resolve(row.path) !== path.resolve(this.filePath(row.task_id))) throw new PlanIntegrityError(`Plan index has no matching Markdown document: ${row.task_id}`);
    const result: PlanDocument[] = [];
    for (const name of names.filter((item) => item.endsWith(".md"))) {
      try { const plan = await this.read(name.slice(0, -3)); if (!["completed", "cancelled"].includes(plan.status)) result.push(plan); }
      catch (error) { throw new PlanIntegrityError(`Cannot recover plan ${name}: ${error instanceof Error ? error.message : String(error)}`); }
    }
    return result.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  close(): void { this.database?.close(); this.database = undefined; }

  private index(): DatabaseSync {
    if (this.database) return this.database;
    this.database = new DatabaseSync(path.join(this.directory, "plans.sqlite"));
    this.database.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; CREATE TABLE IF NOT EXISTS plans (task_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, workspace_root TEXT NOT NULL, version INTEGER NOT NULL, status TEXT NOT NULL, hash TEXT NOT NULL, path TEXT NOT NULL, scope_json TEXT NOT NULL, updated_at TEXT NOT NULL);");
    return this.database;
  }

  private upsertIndex(document: PlanDocument, file: string): void {
    this.index().prepare("INSERT INTO plans (task_id, session_id, workspace_root, version, status, hash, path, scope_json, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(task_id) DO UPDATE SET session_id=excluded.session_id, workspace_root=excluded.workspace_root, version=excluded.version, status=excluded.status, hash=excluded.hash, path=excluded.path, scope_json=excluded.scope_json, updated_at=excluded.updated_at")
      .run(document.taskId, document.sessionId, this.workspaceRoot, document.version, document.status, document.hash, file, JSON.stringify(document.scope), document.updatedAt);
  }

  private assertIndex(document: PlanDocument, file: string): void {
    const row = this.index().prepare("SELECT version, status, hash, path, scope_json FROM plans WHERE task_id = ?").get(document.taskId) as { version: number; status: string; hash: string; path: string; scope_json: string } | undefined;
    if (!row) { this.upsertIndex(document, file); return; } // 兼容升级前已有的 Markdown 计划。
    if (row.version !== document.version || row.status !== document.status || row.hash !== document.hash || path.resolve(row.path) !== path.resolve(file) || row.scope_json !== JSON.stringify(document.scope)) {
      throw new PlanIntegrityError(`Plan index mismatch: ${document.taskId}`);
    }
  }
}

export function createPlanTool(store: PlanStore): Tool {
  return defineTool({
    name: "write_plan",
    description: "Write the current task plan as a human-readable Markdown document.",
    capabilities: ["write"],
    inputSchema: z.object({ body: z.string().min(1), scope: planScopeSchema }).strict(),
    modelInputSchema: {
      type: "object",
      properties: {
        body: { type: "string", description: "Complete Markdown plan with the required Chinese headings and numbered execution steps." },
        scope: {
          type: "object",
          properties: {
            capabilities: { type: "array", items: { type: "string", enum: ["read", "write", "execute", "network"] } },
            tools: { type: "array", items: { type: "string" } },
            paths: { type: "array", items: { type: "string", description: "Workspace-relative exact path, or a directory ending in /." } },
            commands: {
              type: "array",
              items: {
                type: "object",
                properties: { command: { type: "string" }, args: { type: "array", items: { type: "string" } }, cwd: { type: "string" } },
                required: ["command", "args", "cwd"],
                additionalProperties: false,
              },
            },
          },
          required: ["capabilities", "tools", "paths", "commands"],
          additionalProperties: false,
        },
      },
      required: ["body", "scope"],
      additionalProperties: false,
    },
    async execute(input, context) { return store.writeScoped(input.body, input.scope, context.sessionId ?? "unknown"); },
  });
}

const PLAN_STATUSES: readonly PlanStatus[] = ["planning", "planned", "awaiting-approval", "executing", "validating", "completed", "blocked", "needs-plan-update", "cancelled"];

function parsePlanStatus(value: string | undefined): PlanStatus {
  if (!PLAN_STATUSES.includes(value as PlanStatus)) throw new PlanIntegrityError(`Invalid plan status: ${value ?? "missing"}`);
  return value as PlanStatus;
}

function emptyPlanScope(): PlanScope { return { capabilities: [], tools: [], paths: [], commands: [] }; }

function normalizePlanScope(scope: PlanScope): PlanScope {
  const parsed = planScopeSchema.parse(scope);
  return {
    capabilities: [...new Set(parsed.capabilities)].sort(),
    tools: [...new Set(parsed.tools.map((item) => item.trim()).filter(Boolean))].sort(),
    paths: [...new Set(parsed.paths.map((item) => item.replaceAll("\\", "/").replace(/^\.\//, "")))].sort(),
    commands: parsed.commands.map((item) => ({ command: item.command, args: [...item.args], cwd: item.cwd.replaceAll("\\", "/") })),
  };
}

function parsePlanScope(value: string | undefined): PlanScope {
  if (!value) return emptyPlanScope(); // 兼容早期计划文档。
  try { return normalizePlanScope(JSON.parse(value) as PlanScope); }
  catch { throw new PlanIntegrityError("Invalid plan scope"); }
}

function serializeFrontMatter(document: PlanDocument): string {
  return ["---", "schemaVersion: 1", `taskId: ${document.taskId}`, `sessionId: ${document.sessionId}`, `version: ${document.version}`, `status: ${document.status}`, `hash: ${document.hash}`, `updatedAt: ${document.updatedAt}`, `scope: ${JSON.stringify(document.scope)}`, "---", ""].join("\n");
}

function validatePlanBody(body: string): void {
  const required = ["# 任务目标", "# 执行计划", "# 完成标准", "# 边界情况", "# 不应修改的内容", "# 测试与验证"];
  for (const heading of required) if (!body.includes(heading)) throw new Error(`Plan body missing required section: ${heading}`);
  const execution = body.split("# 执行计划")[1]?.split(/^# /m)[0] ?? "";
  if (!/^\s*1\.\s+\S/m.test(execution)) throw new Error("Plan execution section must contain a numbered list");
}

function isMissingFileError(error: unknown): boolean { return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT"; }
