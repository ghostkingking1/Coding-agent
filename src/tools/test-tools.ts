import { z } from "zod";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { createRunCommandTool, DEFAULT_MAX_COMMAND_TIMEOUT_MS, type RunCommandInput, type RunCommandPreview, type RunCommandResult, type RunCommandToolOptions } from "./command-tools.ts";
import { createRunTestsModelInputSchema } from "./model-tool-schemas.ts";
import type { WorkspacePolicy } from "./security.ts";
import { argsInputSchema, envInputSchema, singleLineTextSchema } from "./tool-input-schemas.ts";
import { defineTool, validateToolInput } from "./tool-schema.ts";
import type { PreparedToolOperation, Tool, ToolContext, VerificationEvidence } from "../agent/types.ts";

/** run_tests 工具的安全和资源限制配置。 */
export interface RunTestsToolOptions extends RunCommandToolOptions {
  /** 默认执行的 npm script。 */
  readonly defaultScript?: string;
  /** 只有本地策略列出的 script 才能由模型选择，默认仅允许 defaultScript。 */
  readonly allowedScripts?: readonly string[];
  /** 默认禁止模型追加 runner 参数，避免用 --help 等参数制造无测试的退出码 0。 */
  readonly allowAdditionalArgs?: boolean;
  readonly allowedOutputPatterns?: readonly string[];
}

/** run_tests 审批预览，不包含环境变量值。 */
export interface RunTestsPreview {
  readonly runner: "npm";
  readonly script: string;
  readonly args: readonly string[];
  readonly command: string;
  readonly commandArgs: readonly string[];
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly maxStdoutBytes: number;
  readonly maxStderrBytes: number;
  readonly envKeys: readonly string[];
}

/** run_tests 执行完成后的结构化结果。 */
export interface RunTestsResult extends RunTestsPreview {
  readonly status: "passed" | "failed" | "timed_out" | "aborted" | "error" | "inconclusive";
  readonly passed: boolean;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
  readonly timedOut: boolean;
  readonly aborted: boolean;
  readonly durationMs: number;
  readonly error?: string;
  readonly evidence: VerificationEvidence;
}

const DEFAULT_TEST_SCRIPT = "test";

const createRunTestsInputSchema = (defaultScript: string, allowedScripts: readonly string[], allowAdditionalArgs: boolean) => z.object({
  script: singleLineTextSchema.refine((value) => allowedScripts.includes(value), "script is not allowed by local verification policy").optional(),
  args: argsInputSchema.refine((value) => allowAdditionalArgs || value.length === 0, "test arguments are not allowed by local verification policy").optional(),
  cwd: singleLineTextSchema.optional(),
  timeoutMs: z.number().int().min(1).optional(),
  env: envInputSchema.optional(),
}).strict().optional().transform((value) => ({
  script: value?.script ?? defaultScript,
  args: value?.args ?? [],
  cwd: value?.cwd,
  timeoutMs: value?.timeoutMs,
  env: value?.env,
}));

/** run_tests 原始输入类型，由 Zod schema 自动推导。 */
export type RunTestsInput = z.input<ReturnType<typeof createRunTestsInputSchema>>;
type ParsedRunTestsInput = z.output<ReturnType<typeof createRunTestsInputSchema>>;

/** 创建结构化测试工具，底层复用受限命令工具的审批、cwd、超时和输出上限。 */
export function createRunTestsTool(policy: WorkspacePolicy, options: RunTestsToolOptions = {}): Tool {
  const commandTool = createRunCommandTool(policy, options);
  const defaultScript = options.defaultScript ?? DEFAULT_TEST_SCRIPT;
  validateToolInput(singleLineTextSchema, defaultScript);
  const allowedScripts = [...new Set(options.allowedScripts ?? [defaultScript])];
  if (!allowedScripts.includes(defaultScript)) throw new Error("allowedScripts must include defaultScript");
  for (const script of allowedScripts) validateToolInput(singleLineTextSchema, script);
  const allowAdditionalArgs = options.allowAdditionalArgs ?? false;
  const allowedOutputPatterns = options.allowedOutputPatterns ?? ["node_modules/.cache/**", "coverage/**", "target/**", "**/__pycache__/**"];
  const runTestsInputSchema = createRunTestsInputSchema(defaultScript, allowedScripts, allowAdditionalArgs);

  return defineTool({
    name: "run_tests",
    description: "Run an approved npm test script and return structured pass/fail output for repair loops.",
    capabilities: ["execute"],
    verification: {
      kind: "test",
      isSuccessful: (result: unknown) => {
        const value = result as Partial<RunTestsResult> | null;
        return value?.evidence?.status === "passed" && value?.passed === true;
      },
      toEvidence: (result: unknown) => (result as RunTestsResult).evidence,
    },
    inputSchema: runTestsInputSchema,
    modelInputSchema: createRunTestsModelInputSchema(defaultScript, options.maxTimeoutMs ?? DEFAULT_MAX_COMMAND_TIMEOUT_MS, allowedScripts, allowAdditionalArgs),
    async preview(input, context) {
      await assertTrustedScript(policy, input);
      return buildRunTestsPreview(await previewCommand(commandTool, input, context), input);
    },
    async prepare(input, context) {
      await assertTrustedScript(policy, input);
      if (!commandTool.prepare) throw new Error("run_command prepare is required");
      const commandOperation = await commandTool.prepare(toRunCommandInput(input), context);
      return {
        operationId: `tests_${commandOperation.operationId}`,
        preview: buildRunTestsPreview(commandOperation.preview as RunCommandPreview, input),
        approvalDigest: commandOperation.approvalDigest,
        payload: { commandOperation, input },
      };
    },
    async executePrepared(operation, context) {
      if (!commandTool.executePrepared) throw new Error("run_command executePrepared is required");
      const prepared = preparedTests(operation);
      const result = await commandTool.executePrepared(prepared.commandOperation, context) as RunCommandResult;
      return buildRunTestsResult(result, prepared.input, allowedOutputPatterns);
    },
    async execute(input, context) {
      await assertTrustedScript(policy, input);
      const result = await commandTool.execute(toRunCommandInput(input), context) as RunCommandResult;
      return buildRunTestsResult(result, input, allowedOutputPatterns);
    },
  });
}

function preparedTests(operation: PreparedToolOperation): { commandOperation: PreparedToolOperation; input: ParsedRunTestsInput } {
  const value = operation.payload as { commandOperation?: PreparedToolOperation; input?: ParsedRunTestsInput } | undefined;
  if (!value?.commandOperation || !value.input || value.commandOperation.approvalDigest !== operation.approvalDigest) {
    throw new Error("Prepared test operation does not match its approval digest");
  }
  return { commandOperation: value.commandOperation, input: value.input };
}

async function previewCommand(commandTool: Tool, input: ParsedRunTestsInput, context: ToolContext): Promise<RunCommandPreview> {
  if (!commandTool.preview) throw new Error("run_command preview is required");
  return await commandTool.preview(toRunCommandInput(input), context) as RunCommandPreview;
}

function toRunCommandInput(input: ParsedRunTestsInput): RunCommandInput {
  return {
    command: "npm",
    args: ["run", input.script, "--", ...input.args],
    cwd: input.cwd ?? ".",
    timeoutMs: input.timeoutMs,
    env: input.env ?? {},
  };
}

function buildRunTestsPreview(commandPreview: RunCommandPreview, input: ParsedRunTestsInput): RunTestsPreview {
  return {
    runner: "npm",
    script: input.script,
    args: input.args,
    command: commandPreview.command,
    commandArgs: commandPreview.args,
    cwd: commandPreview.cwd,
    timeoutMs: commandPreview.timeoutMs,
    maxStdoutBytes: commandPreview.maxStdoutBytes,
    maxStderrBytes: commandPreview.maxStderrBytes,
    envKeys: commandPreview.envKeys,
  };
}

function buildRunTestsResult(commandResult: RunCommandResult, input: ParsedRunTestsInput, allowedOutputPatterns: readonly string[]): RunTestsResult {
  const status = testStatus(commandResult);
  const evidence = buildEvidence(commandResult, status, allowedOutputPatterns);
  return {
    ...buildRunTestsPreview(commandResult, input),
    status: status === "passed" && evidence.status === "inconclusive" ? "inconclusive" : status,
    passed: evidence.status === "passed",
    exitCode: commandResult.exitCode,
    signal: commandResult.signal,
    stdout: commandResult.stdout,
    stderr: commandResult.stderr,
    stdoutTruncated: commandResult.stdoutTruncated,
    stderrTruncated: commandResult.stderrTruncated,
    timedOut: commandResult.timedOut,
    aborted: commandResult.aborted,
    durationMs: commandResult.durationMs,
    error: commandResult.error,
    evidence,
  };
}

function buildEvidence(commandResult: RunCommandResult, status: RunTestsResult["status"], allowedOutputPatterns: readonly string[]): VerificationEvidence {
  const output = `${commandResult.stdout}\n${commandResult.stderr}`;
  const count = parseTestCount(output);
  const noTests = count === 0 || /\bno tests? (?:found|run|executed)\b/i.test(output);
  const evidenceStatus = status === "passed" && !noTests ? "passed" : status === "failed" ? "failed" : "inconclusive";
  return {
    evidenceId: crypto.randomUUID(),
    toolName: "run_tests",
    kind: "test",
    status: evidenceStatus,
    reason: noTests ? "test runner reported no executed tests" : status === "passed" ? "trusted test command completed with exit code 0" : status === "failed" ? "test command returned a non-zero exit code" : `test command ended with status ${status}`,
    recordedAt: new Date().toISOString(),
    commandDigest: commandResult.requestDigest,
    policyDigest: commandResult.policyDigest,
    exitCode: commandResult.exitCode,
    ...(count === undefined ? {} : { testCount: count }),
    parser: count === undefined ? "exit_code" : "generic_test_count",
    isolation: commandResult.sandbox,
    allowedOutputPatterns,
  };
}

function parseTestCount(output: string): number | undefined {
  const match = output.match(/(?:^|\s)(\d+)\s+(?:tests?|passing)(?:\s|$)/i);
  return match ? Number(match[1]) : undefined;
}

async function assertTrustedScript(policy: WorkspacePolicy, input: ParsedRunTestsInput): Promise<void> {
  const cwd = policy.resolveDirectory(input.cwd ?? ".");
  const packagePath = path.join(cwd, "package.json");
  let document: unknown;
  try {
    const text = await fs.readFile(packagePath, "utf8");
    if (Buffer.byteLength(text, "utf8") > policy.maxFileBytes) throw new Error("package.json exceeds workspace file limit");
    document = JSON.parse(text);
  } catch (error) {
    throw new Error(`Cannot resolve trusted npm test script: ${error instanceof Error ? error.message : String(error)}`);
  }
  const scripts = document && typeof document === "object" && !Array.isArray(document) ? (document as { scripts?: unknown }).scripts : undefined;
  if (!scripts || typeof scripts !== "object" || Array.isArray(scripts) || typeof (scripts as Record<string, unknown>)[input.script] !== "string") {
    throw new Error(`Trusted npm script is not declared: ${input.script}`);
  }
}

function testStatus(result: RunCommandResult): RunTestsResult["status"] {
  if (result.aborted) return "aborted";
  if (result.timedOut) return "timed_out";
  if (result.error) return "error";
  return result.exitCode === 0 ? "passed" : "failed";
}
