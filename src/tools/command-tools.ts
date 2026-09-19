import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { createRunCommandModelInputSchema } from "./model-tool-schemas.ts";
import { WorkspacePolicy } from "./security.ts";
import { argsInputSchema, envInputSchema, singleLineTextSchema } from "./tool-input-schemas.ts";
import { defineTool } from "./tool-schema.ts";
import { executionRequestDigest, ProcessSandboxBackend, SandboxUnavailableError, UnavailableSandboxBackend, canonicalNetworkPolicy, type ExecutionRequest, type SandboxBackend, type ExecutionNetworkPolicy } from "./sandbox.ts";
import { decideSandboxPolicy, type PolicyDecision, type RiskClass, type SandboxPolicy } from "./sandbox-policy.ts";
import crypto from "node:crypto";
import type { Tool, ToolContext } from "../agent/types.ts";

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
  readonly sandbox?: SandboxBackend;
  readonly requireOsIsolation?: boolean;
  readonly cpuTimeMs?: number;
  readonly memoryBytes?: number;
  readonly maxProcesses?: number;
  /** 本地策略允许的联网范围；未配置时模型只能使用 network.off。 */
  readonly allowedNetwork?: ExecutionNetworkPolicy;
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
  readonly requestDigest: string;
  readonly policyDigest: string;
  readonly approvalDigest: string;
  readonly riskClass: RiskClass;
  readonly requiredCapabilities: readonly string[];
  readonly policy: SandboxPolicy;
  readonly sandbox: { readonly backend: string; readonly version: string; readonly capabilities: readonly string[] };
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
  readonly stdoutArtifact?: { readonly artifactId: string; readonly complete: boolean };
  readonly stderrArtifact?: { readonly artifactId: string; readonly complete: boolean };
  readonly error?: string;
}

interface NormalizedRunCommandOptions {
  readonly defaultTimeoutMs: number;
  readonly maxTimeoutMs: number;
  readonly maxStdoutBytes: number;
  readonly maxStderrBytes: number;
  readonly allowedEnv: readonly string[];
  readonly sandbox: SandboxBackend;
  readonly requireOsIsolation: boolean;
  readonly cpuTimeMs: number;
  readonly memoryBytes: number;
  readonly maxProcesses: number;
  readonly allowedNetwork?: ExecutionNetworkPolicy;
}

interface PlannedCommand {
  readonly preview: RunCommandPreview;
  readonly cwdPath: string;
  readonly env: NodeJS.ProcessEnv;
  readonly request: ExecutionRequest;
  readonly sandbox: SandboxBackend;
  readonly policyDecision: PolicyDecision;
}

interface SpawnPlan {
  readonly command: string;
  readonly args: readonly string[];
  readonly windowsVerbatimArguments?: boolean;
}

const DEFAULT_TIMEOUT_MS = 10_000;
/** 命令和测试工具共享的默认最大超时，避免模型 schema 与实际执行限制漂移。 */
export const DEFAULT_MAX_COMMAND_TIMEOUT_MS = 120_000;
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
const runCommandInputSchema = z.object({
  command: singleLineTextSchema,
  args: argsInputSchema.default([]),
  cwd: singleLineTextSchema.default("."),
  timeoutMs: z.number().int().min(1).optional(),
  env: envInputSchema.default({}),
  network: z.object({
    mode: z.literal("off").or(z.literal("allowlist")),
    hosts: z.array(z.string().min(1)).max(64).optional(),
    ports: z.array(z.number().int().min(1).max(65535)).max(32).optional(),
  }).default({ mode: "off" }),
}).strict();

/** run_command 原始输入类型，由 Zod schema 自动推导。 */
export type RunCommandInput = z.input<typeof runCommandInputSchema>;
type ParsedRunCommandInput = z.output<typeof runCommandInputSchema>;

/** 创建受工作区、审批、超时、输出和环境白名单限制的命令执行工具。 */
export function createRunCommandTool(policy: WorkspacePolicy, options: RunCommandToolOptions = {}): Tool {
  const limits = normalizeOptions(options);
  return defineTool({
    name: "run_command",
    description: "Run an approved command with workspace cwd, timeout, output limits, and an environment allowlist.",
    capabilities: ["execute"],
    inputSchema: runCommandInputSchema,
    modelInputSchema: createRunCommandModelInputSchema(limits.maxTimeoutMs),
    preview(input) {
      return planCommand(policy, limits, input).preview;
    },
    async execute(input, context) {
      const plan = planCommand(policy, limits, input);
      return runPlannedCommand(plan, context);
    },
  });
}

function normalizeOptions(options: RunCommandToolOptions): NormalizedRunCommandOptions {
  const defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxTimeoutMs = options.maxTimeoutMs ?? DEFAULT_MAX_COMMAND_TIMEOUT_MS;
  const maxStdoutBytes = options.maxStdoutBytes ?? DEFAULT_MAX_STREAM_BYTES;
  const maxStderrBytes = options.maxStderrBytes ?? DEFAULT_MAX_STREAM_BYTES;
  const cpuTimeMs = options.cpuTimeMs ?? maxTimeoutMs;
  const memoryBytes = options.memoryBytes ?? 512 * 1024 * 1024;
  const maxProcesses = options.maxProcesses ?? 64;
  assertPositiveInteger(defaultTimeoutMs, "defaultTimeoutMs");
  assertPositiveInteger(maxTimeoutMs, "maxTimeoutMs");
  assertPositiveInteger(maxStdoutBytes, "maxStdoutBytes");
  assertPositiveInteger(maxStderrBytes, "maxStderrBytes");
  assertPositiveInteger(cpuTimeMs, "cpuTimeMs");
  assertPositiveInteger(memoryBytes, "memoryBytes");
  assertPositiveInteger(maxProcesses, "maxProcesses");
  if (defaultTimeoutMs > maxTimeoutMs) throw new Error("defaultTimeoutMs must not exceed maxTimeoutMs");
  return {
    defaultTimeoutMs,
    maxTimeoutMs,
    maxStdoutBytes,
    maxStderrBytes,
    allowedEnv: options.allowedEnv ?? DEFAULT_ALLOWED_ENV,
    sandbox: options.sandbox ?? new UnavailableSandboxBackend(),
    requireOsIsolation: options.requireOsIsolation ?? false,
    cpuTimeMs,
    memoryBytes,
    maxProcesses,
    allowedNetwork: options.allowedNetwork ? canonicalNetworkPolicy(options.allowedNetwork) : undefined,
  };
}

function planCommand(policy: WorkspacePolicy, options: NormalizedRunCommandOptions, input: ParsedRunCommandInput): PlannedCommand {
  const cwdPath = policy.resolveDirectory(input.cwd);
  const timeoutMs = input.timeoutMs ?? options.defaultTimeoutMs;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > options.maxTimeoutMs) {
    throw new Error(`timeoutMs must be an integer from 1 to ${options.maxTimeoutMs}`);
  }
  const env = buildEnvironment(options.allowedEnv, input.env);
  const network = normalizeRequestedNetwork(input.network, options.allowedNetwork);
  if (network.mode === "allowlist") injectProxyEnvironment(env, network);
  const envKeys = Object.keys(env).sort((a, b) => a.localeCompare(b));
  const request: ExecutionRequest = {
    executionId: crypto.randomUUID(),
    workspaceRoot: policy.root,
    executable: input.command,
    args: input.args,
    cwd: cwdPath,
    env: Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined).sort(([a], [b]) => a.localeCompare(b))),
    timeoutMs,
    maxStdoutBytes: options.maxStdoutBytes,
    maxStderrBytes: options.maxStderrBytes,
    network,
    cpuTimeMs: options.cpuTimeMs,
    memoryBytes: options.memoryBytes,
    maxProcesses: options.maxProcesses,
    filesystemWriteHint: true,
  };
  const policyDecision = decideSandboxPolicy(request, options.sandbox.capabilities.capabilities);
  const required: import("./sandbox.ts").SandboxCapability[] = options.sandbox.capabilities.backend === "process" && !options.requireOsIsolation
    ? ["process.spawn", ...(options.maxProcesses > 1 ? ["process-tree" as const] : [])]
    : [...policyDecision.requiredCapabilities];
  if (options.requireOsIsolation) required.push("os.isolation");
  const hostBackend = options.sandbox.capabilities.backend === "process" && !options.requireOsIsolation;
  if (!policyDecision.allowed && !hostBackend) {
    throw new SandboxUnavailableError(policyDecision.reason ?? "Sandbox policy rejected execution");
  }
  options.sandbox.assertAvailable(required);
  return {
    cwdPath,
    env,
    request,
    sandbox: options.sandbox,
    policyDecision,
    preview: {
      command: input.command,
      args: input.args,
      cwd: policy.relative(cwdPath),
      timeoutMs,
      maxStdoutBytes: options.maxStdoutBytes,
      maxStderrBytes: options.maxStderrBytes,
      envKeys,
      requestDigest: executionRequestDigest(request),
      policyDigest: policyDecision.policyDigest,
      approvalDigest: policyDecision.approvalDigest,
      riskClass: policyDecision.riskClass,
      requiredCapabilities: required,
      policy: policyDecision.policy,
      sandbox: options.sandbox.capabilities,
    },
  };
}

function normalizeRequestedNetwork(
  input: ParsedRunCommandInput["network"] | undefined,
  allowed: ExecutionNetworkPolicy | undefined,
): ExecutionNetworkPolicy {
  // 部分内部工具会直接复用 preview/execute；缺省值仍必须保持为 fail-closed 的断网模式。
  if (!input || input.mode === "off") return { mode: "off" };
  if (!allowed || allowed.mode !== "allowlist") {
    throw new Error("Network access is not enabled by local sandbox policy");
  }
  const requestedHosts = [...new Set((input.hosts ?? []).map(normalizeNetworkHost))].sort();
  const requestedPorts = [...new Set(input.ports ?? [])].sort((a, b) => a - b);
  if (requestedHosts.length === 0 || requestedPorts.length === 0) {
    throw new Error("Network allowlist requires at least one host and port");
  }
  const allowedHosts = new Set(allowed.hosts.map(normalizeNetworkHost));
  const allowedPorts = new Set(allowed.ports);
  if (requestedHosts.some((host) => !allowedHosts.has(host)) || requestedPorts.some((port) => !allowedPorts.has(port))) {
    throw new Error("Requested network target exceeds local sandbox policy");
  }
  return {
    mode: "allowlist",
    hosts: requestedHosts,
    ports: requestedPorts,
    proxyId: allowed.proxyId,
    proxyHost: allowed.proxyHost,
    proxyPort: allowed.proxyPort,
  };
}

function injectProxyEnvironment(env: NodeJS.ProcessEnv, policy: Extract<ExecutionNetworkPolicy, { mode: "allowlist" }>): void {
  if (policy.proxyHost !== "127.0.0.1" && policy.proxyHost !== "::1") {
    throw new Error("The controlled proxy endpoint must be loopback");
  }
  if (!Number.isInteger(policy.proxyPort) || policy.proxyPort < 1 || policy.proxyPort > 65535) {
    throw new Error("Invalid controlled proxy port");
  }
  const host = policy.proxyHost === "::1" ? "[::1]" : policy.proxyHost;
  const proxyUrl = `http://${host}:${policy.proxyPort}`;
  // 代理变量由本地策略注入，不能从模型 env 继承；ALL_PROXY 覆盖支持该标准的客户端。
  env.HTTP_PROXY = proxyUrl;
  env.HTTPS_PROXY = proxyUrl;
  env.ALL_PROXY = proxyUrl;
  env.NO_PROXY = "";
}

function normalizeNetworkHost(value: string): string {
  const host = value.trim().toLowerCase().replace(/\.$/, "");
  if (!host || host.length > 253 || host.startsWith(".") || host.includes("..") || !/^[a-z0-9.-]+$/.test(host)) {
    throw new Error(`Invalid network host: ${value}`);
  }
  return host;
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

async function runPlannedCommand(plan: PlannedCommand, context: ToolContext): Promise<RunCommandResult> {
  context.signal?.throwIfAborted();
  const startedAt = Date.now();
  const stdout = createLimitedBuffer(plan.preview.maxStdoutBytes);
  const stderr = createLimitedBuffer(plan.preview.maxStderrBytes);
  const stdoutWriter = context.toolOutputStore ? await context.toolOutputStore.createWriter(context.sessionId, context.runId, "stdout") : undefined;
  const stderrWriter = context.toolOutputStore ? await context.toolOutputStore.createWriter(context.sessionId, context.runId, "stderr") : undefined;
  let timedOut = false;
  let aborted = false;
  let settled = false;
  let stopRequested = false;
  let forceKillTimer: ReturnType<typeof setTimeout> | undefined;
  const spawnPlan = planSpawn(plan);

  return new Promise<RunCommandResult>((resolve) => {
    void context.auditSink?.record({
      sessionId: context.sessionId,
      runId: context.runId,
      eventType: "sandbox_execution_started",
      toolName: "run_command",
      status: "started",
      requestId: plan.request.executionId,
      metadata: {
        requestDigest: plan.preview.requestDigest,
        backend: plan.preview.sandbox.backend,
        backendVersion: plan.preview.sandbox.version,
        capabilities: plan.preview.sandbox.capabilities,
        policyDigest: plan.preview.policyDigest,
        approvalDigest: plan.preview.approvalDigest,
        riskClass: plan.preview.riskClass,
        requiredCapabilities: plan.preview.requiredCapabilities,
        networkPolicy: plan.preview.policy.network,
        timeoutMs: plan.request.timeoutMs,
        cpuTimeMs: plan.request.cpuTimeMs,
        memoryBytes: plan.request.memoryBytes,
        maxProcesses: plan.request.maxProcesses,
      },
    });
    const child = plan.sandbox.spawn({
      ...plan.request,
      executable: spawnPlan.command,
      args: spawnPlan.args,
      windowsVerbatimArguments: spawnPlan.windowsVerbatimArguments,
    });

    let stdoutWrites = Promise.resolve();
    let stderrWrites = Promise.resolve();
    const finish = async (result: Pick<RunCommandResult, "exitCode" | "signal" | "error">) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      context.signal?.removeEventListener("abort", abort);
      await Promise.all([stdoutWrites, stderrWrites]);
      const [out, err] = await Promise.all([stdoutWriter?.close(), stderrWriter?.close()]);
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
        ...(out ? { stdoutArtifact: { artifactId: out.artifactId, complete: out.complete } } : {}),
        ...(err ? { stderrArtifact: { artifactId: err.artifactId, complete: err.complete } } : {}),
      });
      void context.auditSink?.record({
        sessionId: context.sessionId,
        runId: context.runId,
        eventType: "sandbox_execution_finished",
        toolName: "run_command",
        status: timedOut ? "timed_out" : aborted ? "aborted" : result.error ? "error" : result.exitCode === 0 ? "completed" : "failed",
        requestId: plan.request.executionId,
        metadata: {
          requestDigest: plan.preview.requestDigest,
          policyDigest: plan.preview.policyDigest,
          approvalDigest: plan.preview.approvalDigest,
          riskClass: plan.preview.riskClass,
          exitCode: result.exitCode,
          signal: result.signal,
          durationMs: Date.now() - startedAt,
          stdoutTruncated: stdout.truncated(),
          stderrTruncated: stderr.truncated(),
        },
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
    child.stdout?.on("data", (chunk: Buffer) => { stdout.append(chunk); stdoutWrites = stdoutWrites.then(() => stdoutWriter?.append(chunk)); });
    child.stderr?.on("data", (chunk: Buffer) => { stderr.append(chunk); stderrWrites = stderrWrites.then(() => stderrWriter?.append(chunk)); });
    child.on("error", (error) => { void finish({ exitCode: null, signal: null, error: error.message }); });
    child.on("close", (exitCode, signal) => { void finish({ exitCode, signal, error: undefined }); });
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
