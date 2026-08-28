import { z } from "zod";
import { createRunCommandTool, DEFAULT_MAX_COMMAND_TIMEOUT_MS, type RunCommandInput, type RunCommandPreview, type RunCommandResult, type RunCommandToolOptions } from "./command-tools.ts";
import { createRunTestsModelInputSchema } from "./model-tool-schemas.ts";
import type { WorkspacePolicy } from "./security.ts";
import { argsInputSchema, envInputSchema, singleLineTextSchema } from "./tool-input-schemas.ts";
import { defineTool, validateToolInput } from "./tool-schema.ts";
import type { Tool, ToolContext } from "../agent/types.ts";

/** run_tests 工具的安全和资源限制配置。 */
export interface RunTestsToolOptions extends RunCommandToolOptions {
  /** 默认执行的 npm script。 */
  readonly defaultScript?: string;
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
  readonly status: "passed" | "failed" | "timed_out" | "aborted" | "error";
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
}

const DEFAULT_TEST_SCRIPT = "test";

const createRunTestsInputSchema = (defaultScript: string) => z.object({
  script: singleLineTextSchema.optional(),
  args: argsInputSchema.optional(),
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
  const runTestsInputSchema = createRunTestsInputSchema(defaultScript);

  return defineTool({
    name: "run_tests",
    description: "Run an approved npm test script and return structured pass/fail output for repair loops.",
    capabilities: ["execute"],
    inputSchema: runTestsInputSchema,
    modelInputSchema: createRunTestsModelInputSchema(defaultScript, options.maxTimeoutMs ?? DEFAULT_MAX_COMMAND_TIMEOUT_MS),
    async preview(input, context) {
      return buildRunTestsPreview(await previewCommand(commandTool, input, context), input);
    },
    async execute(input, context) {
      const result = await commandTool.execute(toRunCommandInput(input), context) as RunCommandResult;
      return buildRunTestsResult(result, input);
    },
  });
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

function buildRunTestsResult(commandResult: RunCommandResult, input: ParsedRunTestsInput): RunTestsResult {
  const status = testStatus(commandResult);
  return {
    ...buildRunTestsPreview(commandResult, input),
    status,
    passed: status === "passed",
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
  };
}

function testStatus(result: RunCommandResult): RunTestsResult["status"] {
  if (result.aborted) return "aborted";
  if (result.timedOut) return "timed_out";
  if (result.error) return "error";
  return result.exitCode === 0 ? "passed" : "failed";
}
