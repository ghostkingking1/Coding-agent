import { execFileSync, spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import crypto from "node:crypto";

/** 沙箱能力由后端声明，上层不得根据 platform 分支推断隔离强度。 */
export type SandboxCapability =
  | "process.spawn"
  | "process-tree"
  | "workspace.fs"
  | "network.off"
  | "os.isolation"
  | "protocol.v1"
  | "resource.limits"
  | "hardening.no_new_privs"
  | "hardening.cgroup"
  | "hardening.read_only_root"
  | "hardening.credential_paths"
  | "hardening.appcontainer"
  | "hardening.seccomp"
  | "hardening.handle_whitelist"
  | "hardening.restricted_token";

export interface SandboxCapabilities {
  readonly backend: string;
  readonly version: string;
  readonly capabilities: readonly SandboxCapability[];
}

/** 经过规范化、可被审批绑定的完整执行请求。 */
export interface ExecutionRequest {
  readonly executionId: string;
  readonly workspaceRoot: string;
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  readonly maxStdoutBytes: number;
  readonly maxStderrBytes: number;
  readonly network: "off";
  readonly cpuTimeMs: number;
  readonly memoryBytes: number;
  readonly maxProcesses: number;
}

export interface SandboxSpawnRequest extends ExecutionRequest {
  readonly stdio?: SpawnOptions["stdio"];
  readonly windowsVerbatimArguments?: boolean;
}

export interface SandboxBackend {
  readonly capabilities: SandboxCapabilities;
  /** 能力不满足时必须抛错，不能静默退化。 */
  assertAvailable(required: readonly SandboxCapability[]): void;
  spawn(request: SandboxSpawnRequest): ChildProcess;
}

export class SandboxUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxUnavailableError";
  }
}

/**
 * 仅用于兼容已有本地测试和显式开发配置的进程后端。
 * 它不宣称具备 OS isolation；生产调用方必须注入 Rust Helper 后端。
 */
export class ProcessSandboxBackend implements SandboxBackend {
  readonly capabilities: SandboxCapabilities = {
    backend: "process",
    version: "0",
    capabilities: ["process.spawn", "process-tree", "workspace.fs", "network.off"],
  };

  assertAvailable(required: readonly SandboxCapability[]): void {
    const missing = required.filter((capability) => !this.capabilities.capabilities.includes(capability));
    if (missing.length > 0) throw new SandboxUnavailableError(`Sandbox capabilities unavailable: ${missing.join(", ")}`);
  }

  spawn(request: SandboxSpawnRequest): ChildProcess {
    this.assertAvailable(["process.spawn", "network.off"]);
    return spawn(request.executable, request.args, {
      cwd: request.cwd,
      env: request.env,
      shell: false,
      detached: process.platform !== "win32",
      windowsHide: true,
      windowsVerbatimArguments: request.windowsVerbatimArguments,
      stdio: request.stdio,
    });
  }
}

/** Rust Helper 未配置或握手失败时使用，保证系统 fail closed。 */
export class UnavailableSandboxBackend implements SandboxBackend {
  readonly capabilities: SandboxCapabilities = { backend: "unavailable", version: "0", capabilities: [] };

  assertAvailable(_required: readonly SandboxCapability[]): void {
    throw new SandboxUnavailableError("Sandbox backend is unavailable; refusing to spawn a host process");
  }

  spawn(_request: SandboxSpawnRequest): ChildProcess {
    this.assertAvailable([]);
    throw new SandboxUnavailableError("unreachable");
  }
}

export interface RustHelperSandboxOptions {
  readonly helperPath: string;
  readonly handshakeTimeoutMs?: number;
}

/**
 * Rust Helper 的透明代理后端。握手和请求校验由 helper 自己完成，TS 只负责传递规范化请求。
 */
export class RustHelperSandboxBackend implements SandboxBackend {
  readonly capabilities: SandboxCapabilities;
  private readonly helperPath: string;

  constructor(options: RustHelperSandboxOptions) {
    this.helperPath = options.helperPath;
    const timeout = options.handshakeTimeoutMs ?? 3000;
    if (!Number.isInteger(timeout) || timeout < 1) throw new Error("handshakeTimeoutMs must be a positive integer");
    try {
      const output = execFileSync(this.helperPath, ["--capabilities"], { encoding: "utf8", timeout, windowsHide: true });
      const parsed = JSON.parse(output) as Partial<SandboxCapabilities>;
      if (parsed.backend !== "rust-helper" || parsed.version !== "1" || !Array.isArray(parsed.capabilities)) {
        throw new Error("invalid helper capability response");
      }
      this.capabilities = { backend: parsed.backend, version: parsed.version, capabilities: parsed.capabilities as SandboxCapability[] };
    } catch (error) {
      throw new SandboxUnavailableError(`Rust sandbox helper handshake failed: ${error instanceof Error ? error.message : "unknown error"}`);
    }
  }

  assertAvailable(required: readonly SandboxCapability[]): void {
    const missing = required.filter((capability) => !this.capabilities.capabilities.includes(capability));
    if (missing.length > 0) throw new SandboxUnavailableError(`Sandbox capabilities unavailable: ${missing.join(", ")}`);
  }

  spawn(request: SandboxSpawnRequest): ChildProcess {
    this.assertAvailable(["process.spawn", "network.off"]);
    const encoded = Buffer.from(JSON.stringify({
      workspace_root: request.workspaceRoot,
      execution_id: request.executionId,
      executable: request.executable,
      args: request.args,
      cwd: request.cwd,
      env: request.env,
      timeout_ms: request.timeoutMs,
      max_stdout_bytes: request.maxStdoutBytes,
      max_stderr_bytes: request.maxStderrBytes,
      network: request.network,
      cpu_time_ms: request.cpuTimeMs,
      memory_bytes: request.memoryBytes,
      max_processes: request.maxProcesses,
    }), "utf8").toString("base64");
    return spawn(this.helperPath, ["--execute", encoded], {
      shell: false,
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: request.stdio,
    });
  }
}

/** 对规范化请求生成稳定摘要，Approval 必须绑定该摘要而不是命令字符串。 */
export function executionRequestDigest(request: ExecutionRequest): string {
  const canonical = JSON.stringify({
    // executionId 只用于运行追踪，不属于审批语义；相同请求的 preview/execute 必须得到同一 digest。
    workspaceRoot: request.workspaceRoot,
    executable: request.executable,
    args: [...request.args],
    cwd: request.cwd,
    env: Object.fromEntries(Object.entries(request.env).sort(([a], [b]) => a.localeCompare(b))),
    timeoutMs: request.timeoutMs,
    maxStdoutBytes: request.maxStdoutBytes,
    maxStderrBytes: request.maxStderrBytes,
    network: request.network,
    cpuTimeMs: request.cpuTimeMs,
    memoryBytes: request.memoryBytes,
    maxProcesses: request.maxProcesses,
  });
  return crypto.createHash("sha256").update(canonical).digest("hex");
}
