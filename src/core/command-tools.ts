import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { WorkspacePolicy } from "./security.ts";
import type { Tool, ToolContext } from "./types.ts";

/** run_command 工具的输入结构。 */
export interface RunCommandInput {
  /** 要执行的命令名称或可执行文件路径。 */
  readonly command: string;
  /** 以 argv 形式传入的参数，避免把整条命令交给 shell 拼接。 */
  readonly args?: readonly string[];
  /** 工作区内的执行目录，默认是工作区根目录。 */
  readonly cwd?: string;
  /** 本次命令允许运行的毫秒数。 */
  readonly timeoutMs?: number;
  /** 额外传给子进程的环境变量，只有白名单内的 key 会生效。 */
  readonly env?: Readonly<Record<string, string>>;
}

/** run_command 工具的安全和资源限制配置。 */
export interface RunCommandToolOptions {
  /** 默认命令超时时间。 */
  readonly defaultTimeoutMs?: number;
  /** 单次命令最大超时时间。 */
  readonly maxTimeoutMs?: number;
  /** stdout 最大保留字节数。 */
  readonly maxStdoutBytes?: number;
  /** stderr 最大保留字节数。 */
  readonly maxStderrBytes?: number;
  /** 允许透传给子进程的环境变量名称。 */
  readonly allowedEnv?: readonly string[];
}

/** run_command 审批预览，不包含环境变量值。 */
export interface RunCommandPreview {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly maxStdoutBytes: number;
  readonly maxStderrBytes: number;
  readonly envKeys: readonly string[];
}

/** run_command 执行完成后的结构化结果。 */
export interface RunCommandResult extends RunCommandPreview {
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

interface NormalizedRunCommandOptions {
  readonly defaultTimeoutMs: number;
  readonly maxTimeoutMs: number;
  readonly maxStdoutBytes: number;
  readonly maxStderrBytes: number;
  readonly allowedEnv: readonly string[];
}

interface PlannedCommand {
  readonly preview: RunCommandPreview;
  readonly cwdPath: string;
  readonly env: NodeJS.ProcessEnv;
}

interface SpawnPlan {
  readonly command: string;
  readonly args: readonly string[];
  readonly windowsVerbatimArguments?: boolean;
}

interface ValidatedRunCommandInput {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly timeoutMs?: number;
  readonly env: Readonly<Record<string, string>>;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_STREAM_BYTES = 64 * 1024;
const DEFAULT_ALLOWED_ENV = [
  "PATH",
  "Path",
  "PATHEXT",
  "SystemRoot",
  "ComSpec",
  "TEMP",
  "TMP",
  "HOME",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
] as const;

/** 创建受工作区、审批、超时、输出和环境白名单限制的命令执行工具。 */
export function createRunCommandTool(policy: WorkspacePolicy, options: RunCommandToolOptions = {}): Tool {
  const limits = normalizeOptions(options);
  return {
    name: "run_command",
    description: "Run an approved command with workspace cwd, timeout, output limits, and an environment allowlist.",
    manifest: { capabilities: ["execute"] },
    preview(input) {
      return planCommand(policy, limits, input).preview;
    },
    async execute(input, context) {
      const plan = planCommand(policy, limits, input);
      return runPlannedCommand(plan, context);
    },
  };
}

function normalizeOptions(options: RunCommandToolOptions): NormalizedRunCommandOptions {
  const defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxTimeoutMs = options.maxTimeoutMs ?? DEFAULT_MAX_TIMEOUT_MS;
  const maxStdoutBytes = options.maxStdoutBytes ?? DEFAULT_MAX_STREAM_BYTES;
  const maxStderrBytes = options.maxStderrBytes ?? DEFAULT_MAX_STREAM_BYTES;
  assertPositiveInteger(defaultTimeoutMs, "defaultTimeoutMs");
  assertPositiveInteger(maxTimeoutMs, "maxTimeoutMs");
  assertPositiveInteger(maxStdoutBytes, "maxStdoutBytes");
  assertPositiveInteger(maxStderrBytes, "maxStderrBytes");
  if (defaultTimeoutMs > maxTimeoutMs) throw new Error("defaultTimeoutMs must not exceed maxTimeoutMs");
  return {
    defaultTimeoutMs,
    maxTimeoutMs,
    maxStdoutBytes,
    maxStderrBytes,
    allowedEnv: options.allowedEnv ?? DEFAULT_ALLOWED_ENV,
  };
}

function planCommand(policy: WorkspacePolicy, options: NormalizedRunCommandOptions, input: unknown): PlannedCommand {
  const value = assertRunCommandInput(input);
  const cwdPath = policy.resolveDirectory(value.cwd ?? ".");
  const timeoutMs = value.timeoutMs ?? options.defaultTimeoutMs;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > options.maxTimeoutMs) {
    throw new Error(`timeoutMs must be an integer from 1 to ${options.maxTimeoutMs}`);
  }
  const env = buildEnvironment(options.allowedEnv, value.env ?? {});
  const envKeys = Object.keys(env).sort((a, b) => a.localeCompare(b));
  return {
    cwdPath,
    env,
    preview: {
      command: value.command,
      args: value.args,
      cwd: policy.relative(cwdPath),
      timeoutMs,
      maxStdoutBytes: options.maxStdoutBytes,
      maxStderrBytes: options.maxStderrBytes,
      envKeys,
    },
  };
}

function assertRunCommandInput(input: unknown): ValidatedRunCommandInput {
  if (!isRecord(input)) throw new Error("run_command input must be an object");
  const command = assertText(input.command, "command");
  const args = input.args === undefined ? [] : assertArgs(input.args);
  const cwd = input.cwd === undefined ? "." : assertText(input.cwd, "cwd");
  const timeoutMs = input.timeoutMs === undefined ? undefined : Number(input.timeoutMs);
  const env = input.env === undefined ? {} : assertEnv(input.env);
  return { command, args, cwd, timeoutMs, env };
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
    if (!isSafeEnvKey(key)) throw new Error(`Invalid env key: ${key}`);
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

function buildEnvironment(allowedEnv: readonly string[], requestedEnv: Readonly<Record<string, string>>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const allowedKey of allowedEnv) {
    const processKey = findEnvKey(process.env, allowedKey);
    if (processKey && process.env[processKey] !== undefined) env[processKey] = process.env[processKey];
  }
  for (const [key, value] of Object.entries(requestedEnv)) {
    if (isAllowedEnvKey(allowedEnv, key)) env[key] = value;
  }
  return env;
}

function findEnvKey(env: NodeJS.ProcessEnv, key: string): string | undefined {
  if (env[key] !== undefined) return key;
  if (process.platform !== "win32") return undefined;
  return Object.keys(env).find((candidate) => candidate.toLowerCase() === key.toLowerCase());
}

function isAllowedEnvKey(allowedEnv: readonly string[], key: string): boolean {
  return process.platform === "win32"
    ? allowedEnv.some((allowedKey) => allowedKey.toLowerCase() === key.toLowerCase())
    : allowedEnv.includes(key);
}

function isSafeEnvKey(key: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(key);
}

async function runPlannedCommand(plan: PlannedCommand, context: ToolContext): Promise<RunCommandResult> {
  context.signal?.throwIfAborted();
  const startedAt = Date.now();
  const stdout = createLimitedBuffer(plan.preview.maxStdoutBytes);
  const stderr = createLimitedBuffer(plan.preview.maxStderrBytes);
  let timedOut = false;
  let aborted = false;
  let settled = false;
  let stopRequested = false;
  let forceKillTimer: ReturnType<typeof setTimeout> | undefined;
  const spawnPlan = planSpawn(plan);

  return new Promise<RunCommandResult>((resolve) => {
    const child = spawn(spawnPlan.command, spawnPlan.args, {
      cwd: plan.cwdPath,
      env: plan.env,
      detached: process.platform !== "win32",
      shell: false,
      windowsVerbatimArguments: spawnPlan.windowsVerbatimArguments,
      windowsHide: true,
    });

    const finish = (result: Pick<RunCommandResult, "exitCode" | "signal" | "error">) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      context.signal?.removeEventListener("abort", abort);
      resolve({
        ...plan.preview,
        ...result,
        stdout: stdout.text(),
        stderr: stderr.text(),
        stdoutTruncated: stdout.truncated(),
        stderrTruncated: stderr.truncated(),
        timedOut,
        aborted,
        durationMs: Date.now() - startedAt,
      });
    };

    const stop = () => {
      if (stopRequested) return;
      stopRequested = true;
      terminateProcessTree(child);
      if (process.platform !== "win32") {
        forceKillTimer = setTimeout(() => forceTerminateProcessTree(child), 250);
      }
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      stop();
    }, plan.preview.timeoutMs);
    const abort = () => {
      aborted = true;
      stop();
    };

    context.signal?.addEventListener("abort", abort, { once: true });
    child.stdout?.on("data", (chunk: Buffer) => stdout.append(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderr.append(chunk));
    child.on("error", (error) => finish({ exitCode: null, signal: null, error: error.message }));
    child.on("close", (exitCode, signal) => finish({ exitCode, signal, error: undefined }));
  });
}

function planSpawn(plan: PlannedCommand): SpawnPlan {
  if (process.platform !== "win32") return { command: plan.preview.command, args: plan.preview.args };
  const resolved = resolveWindowsCommand(plan.preview.command, plan.cwdPath, plan.env);
  if (!resolved || !/\.(?:bat|cmd)$/i.test(resolved)) {
    return { command: resolved ?? plan.preview.command, args: plan.preview.args };
  }
  /** Windows 批处理文件必须经由 cmd.exe；所有片段都显式引用，避免把整条命令交给模型拼接。 */
  return {
    command: findEnvKey(process.env, "ComSpec") ? process.env[findEnvKey(process.env, "ComSpec") as string] as string : "cmd.exe",
    args: ["/d", "/s", "/c", quoteWindowsCommand([resolved, ...plan.preview.args])],
    windowsVerbatimArguments: true,
  };
}

function resolveWindowsCommand(command: string, cwd: string, env: NodeJS.ProcessEnv): string | undefined {
  if (command.includes(path.sep) || command.includes("/")) {
    const candidate = path.isAbsolute(command) ? command : path.resolve(cwd, command);
    return fs.existsSync(candidate) ? candidate : undefined;
  }
  const pathKey = findEnvKey(env, "PATH") ?? findEnvKey(env, "Path");
  const pathValue = pathKey ? env[pathKey] : undefined;
  if (!pathValue) return undefined;
  const extensions = path.extname(command)
    ? [""]
    : (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
  for (const directory of pathValue.split(path.delimiter)) {
    for (const extension of extensions) {
      const candidate = path.join(directory, `${command}${extension}`);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

function quoteWindowsCommand(parts: readonly string[]): string {
  /** cmd.exe /s /c 需要外层引号保住带空格路径和后续参数的边界。 */
  return `"${parts.map(quoteWindowsArg).join(" ")}"`;
}

function quoteWindowsArg(value: string): string {
  /** cmd.exe 不把反斜杠当作转义符；只处理引号，避免破坏 Windows 路径。 */
  return `"${value.replace(/"/g, "\"\"")}"`;
}

function terminateProcessTree(child: ChildProcess): void {
  if (!child.pid) return;
  if (process.platform === "win32") {
    const killer = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
      stdio: "ignore",
      windowsHide: true,
    });
    killer.on("error", () => undefined);
    return;
  }
  try {
    /** POSIX 下按进程组终止，避免父进程退出后留下孙进程继续运行。 */
    process.kill(-child.pid, "SIGTERM");
  } catch {
    try {
      child.kill("SIGTERM");
    } catch {
      // 进程可能已经自然退出。
    }
  }
}

function forceTerminateProcessTree(child: ChildProcess): void {
  if (!child.pid) return;
  if (process.platform === "win32") return;
  try {
    /** 对忽略 SIGTERM 的进程组补发强制信号，确保超时不会留下后台进程。 */
    process.kill(-child.pid, "SIGKILL");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      // 进程可能已经自然退出。
    }
  }
}

function createLimitedBuffer(limit: number): { append(chunk: Buffer): void; text(): string; truncated(): boolean } {
  const chunks: Buffer[] = [];
  let bytes = 0;
  let wasTruncated = false;
  return {
    append(chunk) {
      if (bytes >= limit) {
        wasTruncated = true;
        return;
      }
      const remaining = limit - bytes;
      if (chunk.byteLength > remaining) {
        chunks.push(chunk.subarray(0, remaining));
        bytes = limit;
        wasTruncated = true;
        return;
      }
      chunks.push(chunk);
      bytes += chunk.byteLength;
    },
    text() {
      return Buffer.concat(chunks).toString("utf8");
    },
    truncated() {
      return wasTruncated;
    },
  };
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 1) throw new Error(`${label} must be a positive integer`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
