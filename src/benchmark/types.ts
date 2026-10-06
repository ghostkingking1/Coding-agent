import type { AgentResult, AuditEvent, AuditSink, ModelUsage, RunEvent } from "../agent/types.ts";
import type { Agent } from "../agent/agent.ts";
import type { RunChangeTracker } from "../agent/run-diff.ts";
import type { SandboxBackend } from "../tools/sandbox.ts";

export interface BenchmarkTask {
  readonly id: string;
  readonly title: string;
  readonly prompt: string;
  readonly fixture: string;
  readonly verification: string;
  readonly baseCommit: string;
  /** 固定 seed tree 的 SHA-256，用于发现误改 fixture；离线 fixture 不是嵌套 Git 仓库。 */
  readonly fixtureDigest: string;
  readonly environment: { readonly node: string; readonly platform?: string };
  readonly limits: { readonly maxDurationMs: number; readonly maxSteps: number };
  readonly diffRules?: { readonly allowedPaths?: readonly string[]; readonly forbiddenPaths?: readonly string[] };
}

export interface BenchmarkRuntimeContext {
  readonly task: BenchmarkTask;
  readonly workspaceRoot: string;
  readonly signal: AbortSignal;
  readonly changeTracker: RunChangeTracker;
  readonly auditSink: AuditSink;
  readonly onEvent: (event: RunEvent) => void;
}

export interface BenchmarkRuntime {
  readonly modelId: string;
  readonly sandbox: SandboxBackend;
  createAgent(context: BenchmarkRuntimeContext): Promise<Agent> | Agent;
}

export interface BenchmarkCheck {
  readonly name: string;
  readonly passed: boolean;
  readonly details?: string;
}

export interface BenchmarkVerifier {
  run(task: BenchmarkTask, workspaceRoot: string, verificationRoot: string, signal: AbortSignal): Promise<readonly BenchmarkCheck[]>;
}

export interface BenchmarkTaskResult {
  readonly taskId: string;
  readonly baseCommit: string;
  readonly fixtureDigest: string;
  readonly environment: BenchmarkTask["environment"];
  readonly modelId: string;
  readonly success: boolean;
  readonly status: "passed" | "failed" | "timed_out" | "error";
  readonly agentStopReason?: AgentResult["stopReason"];
  readonly agentVerification?: AgentResult["verification"];
  readonly durationMs: number;
  readonly steps: number;
  readonly toolCalls: number;
  readonly usage?: ModelUsage;
  readonly verification: readonly BenchmarkCheck[];
  readonly auditEvents: readonly AuditEvent[];
  readonly securityEvents: readonly AuditEvent[];
  readonly trajectory: readonly (RunEvent | { readonly type: "tool_call"; readonly step: number; readonly toolName: string; readonly toolCallId: string; readonly input: string } | { readonly type: "tool_result"; readonly step: number; readonly toolName: string; readonly toolCallId: string; readonly status: "completed" | "failed"; readonly result: string })[];
  readonly diff?: AgentResult["diff"];
  readonly workspacePath?: string;
  readonly error?: string;
}

export interface BenchmarkSummary {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly outputDirectory: string;
  readonly modelId: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly taskCount: number;
  readonly successCount: number;
  readonly testPassCount: number;
  readonly successRate: number;
  readonly averageDurationMs: number;
  readonly totalToolCalls: number;
  readonly totalSteps: number;
  readonly usage?: ModelUsage;
  readonly tasks: readonly BenchmarkTaskResult[];
}

export interface BenchmarkRunnerOptions {
  readonly datasetRoot: string;
  readonly outputRoot: string;
  readonly runtime: BenchmarkRuntime;
  readonly verifier: BenchmarkVerifier;
  readonly taskIds?: readonly string[];
  readonly retainSuccessfulWorkspaces?: boolean;
}
