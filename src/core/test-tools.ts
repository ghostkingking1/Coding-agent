import { createRunCommandTool, type RunCommandPreview, type RunCommandResult, type RunCommandToolOptions } from "./command-tools.ts";
import type { WorkspacePolicy } from "./security.ts";
import type { Tool, ToolContext, ToolInputSchema } from "./types.ts";

/** run_tests 工具的输入结构。 */
export interface RunTestsInput {
  /** 要运行的 npm script，默认是 test。 */
  readonly script?: string;
  /** 透传给 npm script 的参数。 */
  readonly args?: readonly string[];
  /** 工作区内的执行目录，默认是工作区根目录。 */
  readonly cwd?: string;
  /** 本次测试允许运行的毫秒数。 */
  readonly timeoutMs?: number;
  /** 额外传给测试进程的环境变量，只有命令工具白名单内的 key 会生效。 */
  readonly env?: Readonly<Record<string, string>>;
}

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

interface NormalizedRunTestsInput {
  readonly script: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly timeoutMs?: number;
  readonly env?: Readonly<Record<string, string>>;
}

const DEFAULT_TEST_SCRIPT = "test";
const SAFE_ENV_KEY_PATTERN = "^[A-Za-z_][A-Za-z0-9_]*$";
const runTestsInputSchema: ToolInputSchema = {
  type: "object",
  properties: {
    script: { type: "string", minLength: 1 },
    args: { type: "array", items: { type: "string" } },
    cwd: { type: "string", minLength: 1 },
    timeoutMs: { type: "integer", minimum: 1 },
    env: {
      type: "record",
      keyPattern: SAFE_ENV_KEY_PATTERN,
      values: { type: "string" },
    },
  },
  additionalProperties: false,
};

/** 创建结构化测试工具，底层复用受限命令工具的审批、cwd、超时和输出上限。 */
export function createRunTestsTool(policy: WorkspacePolicy, options: RunTestsToolOptions = {}): Tool {
  const commandTool = createRunCommandTool(policy, options);
  const defaultScript = options.defaultScript ?? DEFAULT_TEST_SCRIPT;
  assertText(defaultScript, "defaultScript");

  return {
    name: "run_tests",
    description: "Run an approved npm test script and return structured pass/fail output for repair loops.",
    manifest: { capabilities: ["execute"], inputSchema: runTestsInputSchema },
    async preview(input, context) {
      const normalized = normalizeRunTestsInput(input, defaultScript);
      return buildRunTestsPreview(await previewCommand(commandTool, normalized, context), normalized);
    },
    async execute(input, context) {
      const normalized = normalizeRunTestsInput(input, defaultScript);
      const result = await commandTool.execute(toRunCommandInput(normalized), context) as RunCommandResult;
      return buildRunTestsResult(result, normalized);
    },
  };
}

async function previewCommand(commandTool: Tool, input: NormalizedRunTestsInput, context: ToolContext): Promise<RunCommandPreview> {
  if (!commandTool.preview) throw new Error("run_command preview is required");
  return await commandTool.preview(toRunCommandInput(input), context) as RunCommandPreview;
}

function normalizeRunTestsInput(input: unknown, defaultScript: string): NormalizedRunTestsInput {
  const value = input === undefined ? {} : input;
  if (!isRecord(value)) throw new Error("run_tests input must be an object");
  const script = value.script === undefined ? defaultScript : assertText(value.script, "script");
  const args = value.args === undefined ? [] : assertArgs(value.args);
  const cwd = value.cwd === undefined ? undefined : assertText(value.cwd, "cwd");
  const timeoutMs = value.timeoutMs === undefined ? undefined : Number(value.timeoutMs);
  const env = value.env === undefined ? undefined : assertEnv(value.env);
  return { script, args, cwd, timeoutMs, env };
}

function toRunCommandInput(input: NormalizedRunTestsInput): object {
  return {
    command: "npm",
    args: ["run", input.script, "--", ...input.args],
    cwd: input.cwd,
    timeoutMs: input.timeoutMs,
    env: input.env,
  };
}

function buildRunTestsPreview(commandPreview: RunCommandPreview, input: NormalizedRunTestsInput): RunTestsPreview {
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

function buildRunTestsResult(commandResult: RunCommandResult, input: NormalizedRunTestsInput): RunTestsResult {
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

function assertArgs(value: unknown): readonly string[] {
  if (!Array.isArray(value)) throw new Error("args must be an array");
  return value.map((item, index) => {
    if (typeof item !== "string") throw new Error(`args[${index}] must be a string`);
    if (item.includes("\0")) throw new Error(`args[${index}] must not contain a null byte`);
    return item;
  });
}

function assertEnv(value: unknown): Readonly<Record<string, string>> {
  if (!isRecord(value)) throw new Error("env must be an object");
  const env: Record<string, string> = {};
  for (const [key, envValue] of Object.entries(value)) {
    if (typeof envValue !== "string") throw new Error(`env.${key} must be a string`);
    if (envValue.includes("\0")) throw new Error(`env.${key} must not contain a null byte`);
    env[key] = envValue;
  }
  return env;
}

function assertText(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  if (value.includes("\0")) throw new Error(`${label} must not contain a null byte`);
  if (value.includes("\r") || value.includes("\n")) throw new Error(`${label} must not contain line breaks`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
