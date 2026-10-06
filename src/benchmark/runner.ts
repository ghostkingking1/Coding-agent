import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { AgentResult, AuditEvent, RunEvent } from "../agent/types.ts";
import { RunChangeTracker } from "../agent/run-diff.ts";
import type { BenchmarkCheck, BenchmarkRunnerOptions, BenchmarkSummary, BenchmarkTask, BenchmarkTaskResult } from "./types.ts";

const REQUIRED_SANDBOX = ["network.off", "os.isolation", "resource.limits", "process-tree"] as const;
const MAX_TRAJECTORY_TEXT = 16_384;

/**
 * 独立驱动任务、Agent 和外部 verifier。fixture/verifier 从不复制进 Agent 工作区，
 * 避免 Agent 通过改写测试或规则伪造成功证据。
 */
export async function runBenchmark(options: BenchmarkRunnerOptions): Promise<BenchmarkSummary> {
  options.runtime.sandbox.assertAvailable(REQUIRED_SANDBOX);
  const datasetRoot = await fs.realpath(options.datasetRoot);
  const outputRoot = path.resolve(options.outputRoot);
  const outputRelative = path.relative(datasetRoot, outputRoot);
  if (outputRelative === "" || (!outputRelative.startsWith(`..${path.sep}`) && outputRelative !== ".." && !path.isAbsolute(outputRelative))) throw new Error("Benchmark output must be outside the trusted dataset directory");
  const tasks = await loadTasks(datasetRoot, options.taskIds);
  if (!tasks.length) throw new Error("Benchmark dataset contains no tasks");
  const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${crypto.randomUUID().slice(0, 8)}`;
  const runRoot = path.join(outputRoot, "runs", runId);
  await fs.mkdir(path.join(runRoot, "tasks"), { recursive: true });
  const startedAt = new Date().toISOString();
  const results: BenchmarkTaskResult[] = [];
  for (const task of tasks) results.push(await runTask(task, datasetRoot, runRoot, options));
  const finishedAt = new Date().toISOString();
  const successful = results.filter((result) => result.success).length;
  const usage = sumUsage(results);
  const summary: BenchmarkSummary = {
    schemaVersion: 1,
    runId,
    outputDirectory: runRoot,
    modelId: options.runtime.modelId,
    startedAt,
    finishedAt,
    taskCount: results.length,
    successCount: successful,
    testPassCount: results.filter((result) => { const tests = result.verification.filter((check) => !check.name.startsWith("diff_")); return tests.length > 0 && tests.every((check) => check.passed); }).length,
    successRate: successful / results.length,
    averageDurationMs: Math.round(results.reduce((sum, result) => sum + result.durationMs, 0) / results.length),
    totalToolCalls: results.reduce((sum, result) => sum + result.toolCalls, 0),
    totalSteps: results.reduce((sum, result) => sum + result.steps, 0),
    ...(usage ? { usage } : {}),
    tasks: results,
  };
  await writeJson(path.join(runRoot, "summary.json"), summary);
  await fs.writeFile(path.join(runRoot, "report.md"), renderReport(summary), "utf8");
  return summary;
}

async function runTask(task: BenchmarkTask, datasetRoot: string, runRoot: string, options: BenchmarkRunnerOptions): Promise<BenchmarkTaskResult> {
  const taskOutput = path.join(runRoot, "tasks", task.id);
  await fs.mkdir(taskOutput, { recursive: true });
  // 工作区和失败样本目标必须位于同一输出卷，Windows 临时目录常与仓库盘符不同，rename 会返回 EXDEV。
  const workspaceRoot = await fs.mkdtemp(path.join(taskOutput, ".working-"));
  const controller = new AbortController();
  const changeTracker = new RunChangeTracker({ root: workspaceRoot, sessionId: `bench_${task.id}`, runId: `run_${crypto.randomUUID()}` });
  const timer = setTimeout(() => controller.abort(new Error("Benchmark task timed out")), task.limits.maxDurationMs);
  timer.unref?.();
  const trajectory: BenchmarkTaskResult["trajectory"] extends readonly (infer T)[] ? T[] : never = [];
  const auditEvents: AuditEvent[] = [];
  let observedUsage: import("../agent/types.ts").ModelUsage | undefined;
  const auditSink = { record: async (event: AuditEvent) => { auditEvents.push(event); } };
  const started = Date.now();
  let result: BenchmarkTaskResult;
  let agentResult: AgentResult | undefined;
  try {
    const fixtureRoot = await safeDatasetPath(datasetRoot, task.fixture);
    const verificationRoot = await safeDatasetPath(datasetRoot, task.verification);
    await copyFixture(fixtureRoot, workspaceRoot);
    await changeTracker.start();
    const agent = await raceAbort(Promise.resolve(options.runtime.createAgent({
      task,
      workspaceRoot,
      signal: controller.signal,
      changeTracker,
      auditSink,
      onEvent: (event: RunEvent) => { trajectory.push(sanitizeEvent(event)); if (event.type === "model_usage") observedUsage = addUsage(observedUsage, event.usage); },
    })), controller.signal);
    agentResult = await raceAbort(agent.run(task.prompt, { sessionId: `benchmark-${task.id}`, runId: crypto.randomUUID(), auditSink }), controller.signal);
    const calls = new Map<string, { readonly step: number; readonly toolName: string; readonly input: string }>();
    let step = 0;
    for (const message of agentResult.messages) {
      if (message.role !== "assistant" || !message.toolCalls?.length) continue;
      step += 1;
      for (const call of message.toolCalls) calls.set(call.id, { step, toolName: call.name, input: sanitize(JSON.stringify(call.input)) });
    }
    const toolResults = new Map(agentResult.messages.filter((message): message is Extract<typeof message, { role: "tool" }> => message.role === "tool").map((message) => [message.toolCallId, message]));
    const enrichedTrajectory: Array<BenchmarkTaskResult["trajectory"][number]> = [];
    for (const event of trajectory) {
      if (event.type === "tool_requested") {
        const call = calls.get(event.toolCallId) ?? (event.input ? { step: event.step, toolName: event.toolName, input: event.input } : undefined);
        enrichedTrajectory.push(event);
        if (call) enrichedTrajectory.push({ type: "tool_call", step: event.step, toolName: call.toolName, toolCallId: event.toolCallId, input: call.input });
        continue;
      }
      if (event.type === "tool_completed" || event.type === "tool_failed") {
        const message = toolResults.get(event.toolCallId);
        enrichedTrajectory.push(event);
        if (message) enrichedTrajectory.push({ type: "tool_result", step: event.step, toolName: message.toolName, toolCallId: message.toolCallId, status: event.type === "tool_completed" ? "completed" : "failed", result: sanitize(message.content) });
        continue;
      }
      enrichedTrajectory.push(event);
    }
    const verified = await raceAbort(options.verifier.run(task, workspaceRoot, verificationRoot, controller.signal), controller.signal);
    if (!verified.length || verified.length > 100 || verified.some((check) => typeof check.name !== "string" || typeof check.passed !== "boolean")) throw new Error("External verifier returned invalid or empty checks");
    const checks = [...verified.map((check) => ({ ...check, name: sanitize(check.name).slice(0, 256), ...(check.details ? { details: sanitize(check.details) } : {}) })), ...checkDiffRules(task, agentResult.diff)];
    const securityEvents = [
      ...auditEvents.filter(isSecurityEvent),
      ...agentResult.messages.flatMap((message) => message.role === "tool" && /WorkspaceSecurityError|ApprovalDeniedError|SandboxUnavailableError|outside (?:the )?workspace|network (?:is )?not allowed/i.test(message.content) ? [{ eventType: "security_violation_attempt", toolName: message.toolName, status: "denied" }] : []),
      ...trajectory.flatMap((event) => event.type === "tool_failed" && /WorkspaceSecurityError|ApprovalDeniedError|SandboxUnavailableError|outside (?:the )?workspace|network (?:is )?not allowed/i.test(event.error) ? [{ eventType: "security_violation_attempt", toolName: event.toolName, status: "denied" }] : []),
    ];
    const timedOut = controller.signal.aborted;
    // 成功由外部证据裁决；Agent 的 stopReason/taskState 只作为诊断数据，不作为验收信号。
    const success = !timedOut && checks.length > 0 && checks.every((check) => check.passed) && securityEvents.length === 0;
    result = {
      taskId: task.id, baseCommit: task.baseCommit, fixtureDigest: task.fixtureDigest, environment: task.environment, modelId: sanitize(options.runtime.modelId), success,
      status: timedOut ? "timed_out" : success ? "passed" : "failed",
      agentStopReason: agentResult.stopReason,
      agentVerification: agentResult.verification,
      durationMs: Date.now() - started, steps: agentResult.steps,
      toolCalls: agentResult.messages.reduce((count, message) => count + (message.role === "assistant" ? message.toolCalls?.length ?? 0 : 0), 0),
      ...(agentResult.usage ? { usage: agentResult.usage } : {}),
      verification: checks, auditEvents: auditEvents.map(sanitizeAudit), securityEvents, trajectory: enrichedTrajectory, ...(agentResult.diff ? { diff: agentResult.diff } : {}),
    };
  } catch (error) {
    const timedOut = controller.signal.aborted || (error instanceof Error && error.name === "AbortError");
    const failedCalls = new Set(trajectory.flatMap((event) => event.type === "tool_requested" ? [event.toolCallId] : []));
    const steps = Math.max(agentResult?.steps ?? 0, ...trajectory.flatMap((event) => event.type === "model_started" ? [event.step] : []), 0);
    const partialDiff = agentResult?.diff ?? await changeTracker.finish();
    result = { taskId: task.id, baseCommit: task.baseCommit, fixtureDigest: task.fixtureDigest, environment: task.environment, modelId: sanitize(options.runtime.modelId), success: false, status: timedOut ? "timed_out" : "error", durationMs: Date.now() - started, steps, toolCalls: agentResult?.messages.reduce((count, message) => count + (message.role === "assistant" ? message.toolCalls?.length ?? 0 : 0), 0) ?? failedCalls.size, ...(agentResult ? { agentStopReason: agentResult.stopReason, agentVerification: agentResult.verification } : {}), ...(agentResult?.usage ?? observedUsage ? { usage: agentResult?.usage ?? observedUsage } : {}), verification: [...checkDiffRules(task, partialDiff)], auditEvents: auditEvents.map(sanitizeAudit), securityEvents: [...auditEvents.filter(isSecurityEvent), ...trajectory.flatMap((event) => event.type === "tool_failed" && /WorkspaceSecurityError|ApprovalDeniedError|SandboxUnavailableError|outside (?:the )?workspace|network (?:is )?not allowed/i.test(event.error) ? [{ eventType: "security_violation_attempt", toolName: event.toolName, status: "denied" }] : [])], trajectory, ...(partialDiff ? { diff: partialDiff } : {}), error: sanitize(error instanceof Error ? error.message : String(error)) };
  } finally { clearTimeout(timer); await changeTracker.dispose(); }
  const retain = !result.success || options.retainSuccessfulWorkspaces === true;
  if (retain) {
    const destination = path.join(taskOutput, "workspace");
    await fs.rename(workspaceRoot, destination);
    result = { ...result, workspacePath: path.relative(runRoot, destination).split(path.sep).join("/") };
  } else await fs.rm(workspaceRoot, { recursive: true, force: true });
  await writeJson(path.join(taskOutput, "result.json"), result);
  await writeJson(path.join(taskOutput, "trajectory.json"), result.trajectory);
  await fs.mkdir(path.join(taskOutput, "logs"), { recursive: true });
  if (result.diff) await fs.writeFile(path.join(taskOutput, "diff.patch"), result.diff.text, "utf8");
  if (result.error) await fs.writeFile(path.join(taskOutput, "logs", "error.log"), result.error, "utf8");
  return result;
}

async function loadTasks(datasetRoot: string, selected?: readonly string[]): Promise<BenchmarkTask[]> {
  const names = selected ? [...selected] : (await fs.readdir(datasetRoot, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  const tasks: BenchmarkTask[] = [];
  const ids = new Set<string>();
  for (const name of names) {
    if (!/^[a-z0-9][a-z0-9-]{1,63}$/.test(name)) throw new Error(`Invalid benchmark task directory: ${name}`);
    const file = path.join(datasetRoot, name, "task.json");
    const task = JSON.parse(await fs.readFile(file, "utf8")) as BenchmarkTask;
    if (task.id !== name || ids.has(task.id) || !task.title || !task.prompt || !task.baseCommit || !task.environment?.node || !Number.isInteger(task.limits?.maxDurationMs) || task.limits.maxDurationMs < 1 || !Number.isInteger(task.limits?.maxSteps) || task.limits.maxSteps < 1) throw new Error(`Invalid benchmark task manifest: ${file}`);
    const fixtureRoot = await safeDatasetPath(datasetRoot, task.fixture);
    await safeDatasetPath(datasetRoot, task.verification);
    if (!/^sha256:[a-f0-9]{64}$/.test(task.fixtureDigest) || task.fixtureDigest !== await hashFixture(fixtureRoot)) throw new Error(`Benchmark fixture digest mismatch: ${task.id}`);
    if (!/^>=\d+(?:\.\d+){0,2}$/.test(task.environment.node) || Number(process.versions.node.split(".")[0]) < Number(task.environment.node.slice(2).split(".")[0])) throw new Error(`Task ${task.id} requires Node ${task.environment.node}; current version is ${process.versions.node}`);
    if (task.environment.platform && task.environment.platform !== "any" && task.environment.platform !== process.platform) throw new Error(`Task ${task.id} requires platform ${task.environment.platform}; current platform is ${process.platform}`);
    ids.add(task.id);
    tasks.push(task);
  }
  return tasks;
}

async function safeDatasetPath(root: string, relative: string): Promise<string> {
  if (!relative || path.isAbsolute(relative)) throw new Error("Benchmark paths must be dataset-relative");
  const lexical = path.resolve(root, relative);
  const lexicalRelation = path.relative(root, lexical);
  if (lexicalRelation === ".." || lexicalRelation.startsWith(`..${path.sep}`) || path.isAbsolute(lexicalRelation)) throw new Error(`Benchmark path escapes dataset: ${relative}`);
  let current = root;
  for (const part of lexicalRelation.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    if ((await fs.lstat(current)).isSymbolicLink()) throw new Error(`Benchmark dataset paths must not contain symlinks: ${relative}`);
  }
  const resolved = await fs.realpath(lexical);
  const relation = path.relative(root, resolved);
  if (relation === ".." || relation.startsWith(`..${path.sep}`) || path.isAbsolute(relation)) throw new Error(`Benchmark path escapes dataset: ${relative}`);
  return resolved;
}

async function hashFixture(root: string): Promise<string> {
  const hash = crypto.createHash("sha256");
  const visit = async (directory: string, prefix = ""): Promise<void> => {
    for (const entry of (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === ".git") continue;
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolute = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Benchmark fixture contains symlink: ${relative}`);
      if (entry.isDirectory()) await visit(absolute, relative);
      else if (entry.isFile()) { hash.update(relative).update("\0").update(await fs.readFile(absolute)); }
      else throw new Error(`Benchmark fixture contains special file: ${relative}`);
    }
  };
  await visit(root);
  return `sha256:${hash.digest("hex")}`;
}

async function copyFixture(source: string, destination: string): Promise<void> {
  const stat = await fs.lstat(source);
  if (stat.isSymbolicLink()) throw new Error("Benchmark fixtures must not contain symlinks");
  if (stat.isFile()) { await fs.copyFile(source, destination); return; }
  if (!stat.isDirectory()) throw new Error("Benchmark fixture contains a special file");
  for (const entry of await fs.readdir(source, { withFileTypes: true })) {
    if (entry.name === ".git") continue;
    const from = path.join(source, entry.name);
    const to = path.join(destination, entry.name);
    const child = await fs.lstat(from);
    if (child.isSymbolicLink() || (!child.isFile() && !child.isDirectory())) throw new Error(`Unsafe fixture entry: ${entry.name}`);
    if (child.isDirectory()) { await fs.mkdir(to); await copyFixture(from, to); }
    else await fs.copyFile(from, to);
  }
}

function checkDiffRules(task: BenchmarkTask, diff?: NonNullable<AgentResult["diff"]>): BenchmarkCheck[] {
  if (!diff) return [{ name: "diff_integrity", passed: false, details: "Agent produced no workspace diff evidence" }];
  const integrity: BenchmarkCheck = { name: "diff_integrity", passed: diff.complete && diff.omittedPaths.length === 0, details: diff.complete && diff.omittedPaths.length === 0 ? "workspace snapshot was complete" : `snapshot incomplete; omitted paths: ${diff.omittedPaths.join(", ")}` };
  const rules = task.diffRules;
  if (!rules) return [integrity, { name: "diff_rules", passed: true, details: "no additional path constraints" }];
  const allowed = rules.allowedPaths?.map(globRegex);
  const forbidden = rules.forbiddenPaths?.map(globRegex) ?? [];
  const rejected = diff.files.map((file) => file.path).filter((file) => forbidden.some((pattern) => pattern.test(file)) || (allowed && !allowed.some((pattern) => pattern.test(file))));
  return [integrity, { name: "diff_rules", passed: rejected.length === 0, details: rejected.length ? `disallowed paths: ${rejected.join(", ")}` : "changed paths satisfy task constraints" }];
}

function globRegex(glob: string): RegExp { return new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "§").replace(/\*/g, "[^/]*").replace(/§/g, ".*")}$`); }
function isSecurityEvent(event: AuditEvent): boolean { return /denied|violation|security|escape/i.test(event.eventType) || /denied|rejected|blocked|violation/i.test(`${event.status ?? ""} ${event.errorCode ?? ""}`); }
function sanitize(value: string): string { return value.replace(/(api[_-]?key|authorization|token|secret|password)(\s*[:=]\s*)[^\s,;]+/gi, "$1$2[redacted]").slice(0, MAX_TRAJECTORY_TEXT); }
function sanitizeEvent<T extends RunEvent>(event: T): T {
  const clean = { ...event } as Record<string, unknown>;
  for (const [key, value] of Object.entries(clean)) if (typeof value === "string") clean[key] = sanitize(value);
  return clean as T;
}
function sanitizeAudit(event: AuditEvent): AuditEvent {
  return { ...event, ...(event.status ? { status: sanitize(event.status) } : {}), ...(event.errorCode ? { errorCode: sanitize(event.errorCode) } : {}), ...(event.toolName ? { toolName: sanitize(event.toolName) } : {}) };
}
async function writeJson(file: string, value: unknown): Promise<void> { await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8"); }
function raceAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error("Benchmark task aborted"));
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new Error("Benchmark task aborted"));
    signal.addEventListener("abort", abort, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
function sumUsage(results: readonly BenchmarkTaskResult[]) {
  const usages = results.flatMap((result) => result.usage ? [result.usage] : []);
  if (!usages.length) return undefined;
  return usages.reduce((sum, usage) => ({ inputTokens: sum.inputTokens + usage.inputTokens, outputTokens: sum.outputTokens + usage.outputTokens, totalTokens: sum.totalTokens + usage.totalTokens }), { inputTokens: 0, outputTokens: 0, totalTokens: 0 });
}
function addUsage(total: import("../agent/types.ts").ModelUsage | undefined, value: import("../agent/types.ts").ModelUsage) {
  return { inputTokens: (total?.inputTokens ?? 0) + value.inputTokens, outputTokens: (total?.outputTokens ?? 0) + value.outputTokens, totalTokens: (total?.totalTokens ?? 0) + value.totalTokens };
}
function renderReport(summary: BenchmarkSummary): string {
  const rows = summary.tasks.map((task) => `| ${task.taskId} | ${task.status} | ${task.steps} | ${task.toolCalls} | ${task.durationMs} |`).join("\n");
  return `# Benchmark report\n\n- Model: ${sanitize(summary.modelId)}\n- Success: ${summary.successCount}/${summary.taskCount} (${(summary.successRate * 100).toFixed(1)}%)\n- Average duration: ${summary.averageDurationMs} ms\n- Tool calls: ${summary.totalToolCalls}\n- Steps: ${summary.totalSteps}\n- Tokens: ${summary.usage?.totalTokens ?? "unavailable"}\n\n| Task | Status | Steps | Tool calls | Duration ms |\n|---|---:|---:|---:|---:|\n${rows}\n`;
}
