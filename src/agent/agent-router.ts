import type { AgentResult, JsonObject, VerificationSummary } from "./types.ts";
import type { PlanDocument } from "./work-modes.ts";
import type { RunDiff } from "./run-diff.ts";
import { z } from "zod";

/** Review/Reflection 使用独立协议；解析失败必须安全失败，不能把自然语言默认当作 pass。 */
export const reviewProtocolSchema = z.object({
  decision: z.enum(["pass", "needs_repair", "blocked"]),
  findings: z.array(z.object({ severity: z.enum(["blocker", "major", "minor", "risk"]), title: z.string().min(1).max(300), evidence: z.string().min(1).max(4_000), path: z.string().min(1).max(4_096).optional(), line: z.number().int().positive().optional() }).strict()).max(100),
}).strict();

export const reflectionProtocolSchema = z.object({
  worthwhile: z.boolean(),
  summary: z.string().max(4_000),
  reusableStrategies: z.array(z.string().min(1).max(500)).max(50),
}).strict();

export class RoleProtocolError extends Error {
  constructor(role: "review" | "reflection") { super(`${role} role returned an invalid structured protocol`); this.name = "RoleProtocolError"; }
}

export function parseReviewProtocol(value: string): Pick<ReviewArtifact, "decision" | "findings"> {
  try { return reviewProtocolSchema.parse(JSON.parse(stripJsonFence(value))); }
  catch { throw new RoleProtocolError("review"); }
}

export function parseReflectionProtocol(value: string): Pick<ReflectionArtifact, "worthwhile" | "summary" | "reusableStrategies"> {
  try { return reflectionProtocolSchema.parse(JSON.parse(stripJsonFence(value))); }
  catch { throw new RoleProtocolError("reflection"); }
}

/** 由路由器决定哪些角色需要参与；Execute 是唯一默认角色。 */
export type AgentRole = "planner" | "execute" | "review" | "reflection";

export interface AgentRoutingPolicy {
  readonly plannerScoreThreshold?: number;
  readonly reviewFileThreshold?: number;
  readonly reviewLineThreshold?: number;
  readonly reviewToolFailureThreshold?: number;
  readonly reflectionRepairThreshold?: number;
  readonly reflectionFileThreshold?: number;
}

export interface AgentRoutingSignals {
  readonly requestCharacters: number;
  readonly highRiskTerms: readonly string[];
  readonly planMode: boolean;
  readonly observedToolCalls: number;
  readonly observedToolFailures: number;
  readonly repairAttempts: number;
  readonly changedFiles: number;
  readonly changedLines: number;
  readonly crossModuleChange: boolean;
  readonly verificationStatus?: string;
  readonly sandboxFailure: boolean;
}

export interface AgentRouteDecision {
  readonly phase: "initial" | "post_execute";
  readonly roles: readonly AgentRole[];
  readonly score: number;
  readonly reasons: readonly string[];
  readonly signals: AgentRoutingSignals;
  /** Reflection 是候选而非必然调用；Reflection Agent 仍需判断是否有经验可提炼。 */
  readonly reflectionCandidate: boolean;
}

export interface PlanArtifact {
  readonly kind: "plan";
  readonly plan: PlanDocument;
  readonly source: "planner";
  readonly version: number;
}

export interface ReviewFinding {
  readonly severity: "blocker" | "major" | "minor" | "risk";
  readonly title: string;
  readonly evidence: string;
  readonly path?: string;
  readonly line?: number;
}

export interface ReviewArtifact {
  readonly kind: "review";
  readonly decision: "pass" | "needs_repair" | "blocked";
  readonly findings: readonly ReviewFinding[];
  readonly source: "reviewer";
}

export interface ReflectionArtifact {
  readonly kind: "reflection";
  readonly triggeredBy: readonly string[];
  readonly worthwhile: boolean;
  readonly summary: string;
  readonly reusableStrategies: readonly string[];
  readonly source: "reflection";
}

/**
 * Agent 间只交换这个任务上下文的版本化 artifact 和事件摘要，不共享隐藏对话。
 * 原始 transcript 仍由 Session 保存；角色只拿到其职责所需的最小输入包。
 */
export interface TaskContext {
  readonly taskId: string;
  readonly userRequest: string;
  readonly plan?: PlanArtifact;
  readonly execution?: ExecutionArtifact;
  readonly review?: ReviewArtifact;
  readonly reflection?: ReflectionArtifact;
  readonly events: readonly TaskEvent[];
}

export interface ExecutionArtifact {
  readonly kind: "execution";
  readonly result: AgentResult;
  readonly toolCallCount: number;
  readonly toolFailureCount: number;
  readonly repairAttempts: number;
  readonly source: "execute";
}

export interface AgentRoleHandlers {
  readonly planner?: (input: JsonObject, context: TaskContext) => Promise<PlanArtifact>;
  readonly execute: (input: JsonObject, context: TaskContext) => Promise<ExecutionArtifact>;
  readonly review?: (input: JsonObject, context: TaskContext) => Promise<ReviewArtifact>;
  readonly reflection?: (input: JsonObject, context: TaskContext) => Promise<ReflectionArtifact>;
}

export interface TaskOrchestratorOptions {
  readonly taskId: string;
  readonly request: string;
  readonly planMode?: boolean;
  readonly planningOnly?: boolean;
  readonly router?: AgentRouter;
  readonly handlers: AgentRoleHandlers;
  readonly initialEvents?: readonly TaskEvent[];
  readonly onRoute?: (decision: AgentRouteDecision) => void | Promise<void>;
  /** Review 要求修复时最多重新执行多少轮；默认一轮。 */
  readonly maxReviewRepairAttempts?: number;
}

export interface TaskOrchestratorResult {
  readonly context: TaskContext;
  readonly initialDecision: AgentRouteDecision;
  readonly postExecutionDecision?: AgentRouteDecision;
}

export type TaskEvent =
  | { readonly type: "tool_failed"; readonly toolName: string; readonly errorClass?: string }
  | { readonly type: "verification_failed"; readonly reason: string }
  | { readonly type: "repair_started"; readonly attempt: number }
  | { readonly type: "sandbox_failed"; readonly reason: string }
  | { readonly type: "task_completed"; readonly changedFiles: number; readonly changedLines: number };

const DEFAULT_POLICY: Required<AgentRoutingPolicy> = {
  plannerScoreThreshold: 4,
  reviewFileThreshold: 3,
  reviewLineThreshold: 80,
  reviewToolFailureThreshold: 1,
  reflectionRepairThreshold: 1,
  reflectionFileThreshold: 8,
};

const HIGH_RISK_TERMS = ["security", "vulnerability", "race condition", "rollback", "migration", "architecture", "concurrency", "安全", "漏洞", "竞态", "回滚", "迁移", "架构", "并发"] as const;

export class AgentRouter {
  private readonly policy: Required<AgentRoutingPolicy>;

  constructor(policy: AgentRoutingPolicy = {}) {
    this.policy = { ...DEFAULT_POLICY, ...policy };
    for (const [name, value] of Object.entries(this.policy)) {
      if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
    }
  }

  decideInitial(input: { readonly request: string; readonly planMode?: boolean; readonly observedToolCalls?: number; readonly observedToolFailures?: number; readonly repairAttempts?: number; }): AgentRouteDecision {
    const signals = this.signals(input);
    let score = 0;
    const reasons: string[] = [];
    if (signals.planMode) { score += this.policy.plannerScoreThreshold; reasons.push("explicit_plan_mode"); }
    if (signals.highRiskTerms.length) { score += signals.highRiskTerms.length >= 2 ? 4 : 2; reasons.push("high_risk_scope"); }
    if (signals.requestCharacters >= 2_000) { score += 1; reasons.push("large_request"); }
    if (signals.observedToolCalls >= 3) { score += 1; reasons.push("observed_tool_calls"); }
    const planner = signals.planMode || score >= this.policy.plannerScoreThreshold;
    return this.decision("initial", planner ? ["planner", "execute"] : ["execute"], score, reasons, signals, false);
  }

  decidePostExecution(input: { readonly request: string; readonly planMode?: boolean; readonly toolCallCount?: number; readonly toolFailureCount?: number; readonly repairAttempts?: number; readonly diff?: RunDiff; readonly verification?: VerificationSummary; readonly sandboxFailure?: boolean; }): AgentRouteDecision {
    const signals = this.signals(input);
    const reasons: string[] = [];
    const fileCount = signals.changedFiles;
    const review = fileCount >= this.policy.reviewFileThreshold
      || signals.changedLines >= this.policy.reviewLineThreshold
      || signals.crossModuleChange
      || signals.observedToolFailures >= this.policy.reviewToolFailureThreshold
      || signals.highRiskTerms.length > 0;
    if (fileCount >= this.policy.reviewFileThreshold) reasons.push("changed_file_threshold");
    if (signals.changedLines >= this.policy.reviewLineThreshold) reasons.push("changed_line_threshold");
    if (signals.crossModuleChange) reasons.push("cross_module_change");
    if (signals.observedToolFailures >= this.policy.reviewToolFailureThreshold) reasons.push("observed_tool_failure");
    if (signals.highRiskTerms.length > 0) reasons.push("high_risk_scope");

    const reflection = signals.sandboxFailure
      || signals.repairAttempts >= this.policy.reflectionRepairThreshold
      || signals.changedFiles >= this.policy.reflectionFileThreshold
      || signals.verificationStatus === "failed"
      || signals.verificationStatus === "inconclusive"
      || signals.verificationStatus === "unavailable";
    if (signals.sandboxFailure) reasons.push("sandbox_failure");
    if (signals.repairAttempts >= this.policy.reflectionRepairThreshold) reasons.push("multi_step_repair");
    if (signals.verificationStatus === "failed" || signals.verificationStatus === "inconclusive" || signals.verificationStatus === "unavailable") reasons.push("verification_issue");
    if (signals.changedFiles >= this.policy.reflectionFileThreshold) reasons.push("large_task_success_or_failure");
    const roles: AgentRole[] = ["execute"];
    if (review) roles.push("review");
    if (reflection) roles.push("reflection");
    return this.decision("post_execute", roles, 0, reasons, signals, reflection);
  }

  private signals(input: { readonly request: string; readonly planMode?: boolean; readonly observedToolCalls?: number; readonly observedToolFailures?: number; readonly repairAttempts?: number; readonly diff?: RunDiff; readonly verification?: VerificationSummary; readonly sandboxFailure?: boolean; }): AgentRoutingSignals {
    const diffFiles = input.diff?.files ?? [];
    const paths = diffFiles.map((file) => file.path.replaceAll("\\", "/"));
    const roots = new Set(paths.map((file) => file.split("/")[0]).filter(Boolean));
    const changedLines = diffFiles.reduce((sum, file) => sum + (file.addedLines ?? 0) + (file.removedLines ?? 0), 0);
    const normalized = input.request.toLowerCase();
    return {
      requestCharacters: input.request.length,
      highRiskTerms: HIGH_RISK_TERMS.filter((term) => normalized.includes(term.toLowerCase())),
      planMode: input.planMode === true,
      observedToolCalls: input.observedToolCalls ?? 0,
      observedToolFailures: input.observedToolFailures ?? 0,
      repairAttempts: input.repairAttempts ?? 0,
      changedFiles: diffFiles.length,
      changedLines,
      crossModuleChange: roots.size > 1,
      ...(input.verification ? { verificationStatus: input.verification.status } : {}),
      sandboxFailure: input.sandboxFailure === true,
    };
  }

  private decision(phase: AgentRouteDecision["phase"], roles: readonly AgentRole[], score: number, reasons: readonly string[], signals: AgentRoutingSignals, reflectionCandidate: boolean): AgentRouteDecision {
    return { phase, roles, score, reasons, signals, reflectionCandidate };
  }
}

/**
 * 只编排角色，不实现 Execute 的模型循环。这样角色之间通过 artifact 传递数据，
 * 并且执行中出现的失败只能进入 Reflection 候选，不会重新触发 Planner。
 */
export class TaskOrchestrator {
  private readonly router: AgentRouter;
  private readonly options: TaskOrchestratorOptions;

  constructor(options: TaskOrchestratorOptions) {
    if (!options.taskId.trim()) throw new Error("taskId must not be empty");
    if (!options.request.trim()) throw new Error("request must not be empty");
    if (options.maxReviewRepairAttempts !== undefined && (!Number.isInteger(options.maxReviewRepairAttempts) || options.maxReviewRepairAttempts < 0)) throw new Error("maxReviewRepairAttempts must be a non-negative integer");
    this.router = options.router ?? new AgentRouter();
    this.options = options;
  }

  async run(): Promise<TaskOrchestratorResult> {
    const events = [...(this.options.initialEvents ?? [])];
    let context: TaskContext = { taskId: this.options.taskId, userRequest: this.options.request, events };
    const initialDecision = this.router.decideInitial({ request: this.options.request, planMode: this.options.planMode });
    await this.options.onRoute?.(initialDecision);
    if (initialDecision.roles.includes("planner")) {
      if (!this.options.handlers.planner) throw new Error("Planner was routed but no planner handler was provided");
      const plan = await this.options.handlers.planner(roleInput(context, "planner"), context);
      context = { ...context, plan };
    }
    if (this.options.planningOnly) return { context, initialDecision };
    let execution = await this.options.handlers.execute(roleInput(context, "execute"), context);
    context = { ...context, execution };
    let postExecutionDecision: AgentRouteDecision;
    let reviewRepairAttempts = 0;
    const maxReviewRepairAttempts = this.options.maxReviewRepairAttempts ?? 1;
    for (;;) {
      postExecutionDecision = this.router.decidePostExecution({
        request: this.options.request,
        planMode: this.options.planMode,
        toolCallCount: execution.toolCallCount,
        toolFailureCount: execution.toolFailureCount,
        repairAttempts: execution.repairAttempts,
        diff: execution.result.diff,
        verification: execution.result.verification,
        sandboxFailure: events.some((event) => event.type === "sandbox_failed"),
      });
      await this.options.onRoute?.(postExecutionDecision);
      // 修复后的结果必须再次经过 Review，即使新的 diff 已经低于静态路由阈值。
      // 否则旧的 NEEDS_REPAIR 结论会被保留，却没有证据证明修复真的完成。
      const reviewRequired = postExecutionDecision.roles.includes("review") || reviewRepairAttempts > 0;
      if (!reviewRequired) break;
      if (!this.options.handlers.review) throw new Error("Review was routed but no review handler was provided");
      const review = await this.options.handlers.review(roleInput(context, "review"), context);
      context = { ...context, review };
      if (review.decision !== "needs_repair" || reviewRepairAttempts >= maxReviewRepairAttempts) break;
      reviewRepairAttempts += 1;
      // Review 的修复请求必须回到 Execute，不能只把 NEEDS_REPAIR 当成展示文本。
      execution = await this.options.handlers.execute(roleInput(context, "execute"), context);
      context = { ...context, execution };
    }
    if (postExecutionDecision!.reflectionCandidate) {
      if (!this.options.handlers.reflection) throw new Error("Reflection was routed but no reflection handler was provided");
      const reflection = await this.options.handlers.reflection(roleInput(context, "reflection"), context);
      context = { ...context, reflection };
    }
    return { context, initialDecision, postExecutionDecision: postExecutionDecision! };
  }
}

/** 为角色生成最小输入包，避免把完整 transcript 交给每个 Agent。 */
export function roleInput(context: TaskContext, role: AgentRole): JsonObject {
  const base: JsonObject = { taskId: context.taskId, userRequest: context.userRequest };
  if (role === "planner") return base;
  if (role === "execute") return { ...base, ...(context.plan ? { plan: context.plan } : {}) } as unknown as JsonObject;
  if (role === "review") return { ...base, ...(context.plan ? { plan: context.plan } : {}), ...(context.execution ? { execution: context.execution } : {}) } as unknown as JsonObject;
  return { ...base, ...(context.plan ? { plan: context.plan } : {}), ...(context.execution ? { execution: context.execution } : {}), ...(context.review ? { review: context.review } : {}), events: context.events } as unknown as JsonObject;
}

function stripJsonFence(value: string): string {
  const trimmed = value.trim();
  const match = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  return match?.[1]?.trim() ?? trimmed;
}
