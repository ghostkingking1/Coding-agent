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
  | "hardening.restricted_token"
  | "hardening.explicit_environment"
  | "hardening.job_object"
  | "hardening.acl_recovery_journal"
  | "network.loopback"
  | "network.proxy"
  | "network.allowlist"
  | "filesystem.workspace_write";

/** Helper 可独立验证的网络请求；数组在进入摘要和 Helper 前必须规范化。 */
export type ExecutionNetworkPolicy =
  | { readonly mode: "off" }
  | { readonly mode: "loopback"; readonly ports: readonly number[] }
  | {
      readonly mode: "allowlist";
      readonly hosts: readonly string[];
      readonly ports: readonly number[];
      readonly proxyId: string;
      readonly proxyHost: string;
      readonly proxyPort: number;
    };
/** 兼容旧调用方的 off 字符串；新代码必须传结构化对象。 */
export type ExecutionNetworkPolicyInput = ExecutionNetworkPolicy | "off";

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
  readonly network: ExecutionNetworkPolicyInput;
  readonly cpuTimeMs: number;
  readonly memoryBytes: number;
  readonly maxProcesses: number;
  /** Windows 命令行是否由调用方完成引用；该执行语义必须纳入审批摘要。 */
  readonly windowsVerbatimArguments?: boolean;
  /** 由工具策略推导，模型不能直接提升该标记。 */
  readonly filesystemWriteHint?: boolean;
}

export interface SandboxSpawnRequest extends ExecutionRequest {
  readonly stdio?: SpawnOptions["stdio"];
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
 * 仅提供进程树管理，不宣称网络、文件系统或资源隔离能力。
 * 生产调用方必须注入具备真实隔离能力的后端。
 */
export class ProcessSandboxBackend implements SandboxBackend {
  readonly capabilities: SandboxCapabilities = {
    backend: "process",
    version: "0",
    capabilities: ["process.spawn", "process-tree"],
  };

  assertAvailable(required: readonly SandboxCapability[]): void {
    const missing = required.filter((capability) => !this.capabilities.capabilities.includes(capability));
    if (missing.length > 0) throw new SandboxUnavailableError(`Sandbox capabilities unavailable: ${missing.join(", ")}`);
  }

  spawn(request: SandboxSpawnRequest): ChildProcess {
    // Host backend 只负责启动和回收进程；网络/文件系统策略必须由更强后端实现。
    this.assertAvailable(["process.spawn"]);
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
      const capabilities = [...parsed.capabilities] as SandboxCapability[];
       // 旧版 helper 已经执行工作区边界和超时，只是尚未上报新版细粒度别名；在本地能力快照中补齐兼容别名。
       if (capabilities.includes("workspace.fs") && !capabilities.includes("filesystem.workspace_write")) capabilities.push("filesystem.workspace_write");
       if (capabilities.includes("process.spawn") && !capabilities.includes("resource.limits")) capabilities.push("resource.limits");
       this.capabilities = { backend: parsed.backend, version: parsed.version, capabilities };
    } catch (error) {
      throw new SandboxUnavailableError(`Rust sandbox helper handshake failed: ${error instanceof Error ? error.message : "unknown error"}`);
    }
  }

  assertAvailable(required: readonly SandboxCapability[]): void {
    const missing = required.filter((capability) => !this.capabilities.capabilities.includes(capability));
    if (missing.length > 0) throw new SandboxUnavailableError(`Sandbox capabilities unavailable: ${missing.join(", ")}`);
  }

  spawn(request: SandboxSpawnRequest): ChildProcess {
    this.assertAvailable(["process.spawn", networkCapability(request.network)]);
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

export function normalizeNetworkPolicy(policy: ExecutionNetworkPolicyInput): ExecutionNetworkPolicy {
  return policy === "off" ? { mode: "off" } : policy;
}

export function networkCapability(policy: ExecutionNetworkPolicyInput): SandboxCapability {
  policy = normalizeNetworkPolicy(policy);
  if (policy.mode === "off") return "network.off";
  if (policy.mode === "loopback") return "network.loopback";
  return "network.allowlist";
}

/** 审批摘要与 Helper 必须看到完全相同的排序结果，避免集合顺序造成策略歧义。 */
export function canonicalNetworkPolicy(input: ExecutionNetworkPolicyInput): ExecutionNetworkPolicy {
  const policy = normalizeNetworkPolicy(input);
  if (policy.mode === "off") return policy;
  const ports = [...new Set(policy.ports)].sort((a, b) => a - b);
  if (policy.mode === "loopback") return { mode: "loopback", ports };
  return {
    mode: "allowlist",
    hosts: [...new Set(policy.hosts.map((host) => host.toLowerCase().replace(/\.$/, "")))].sort(),
    ports,
    proxyId: policy.proxyId,
    proxyHost: policy.proxyHost.toLowerCase(),
    proxyPort: policy.proxyPort,
  };
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
    network: canonicalNetworkPolicy(request.network),
    cpuTimeMs: request.cpuTimeMs,
    memoryBytes: request.memoryBytes,
    maxProcesses: request.maxProcesses,
    filesystemWriteHint: request.filesystemWriteHint ?? false,
  });
  return crypto.createHash("sha256").update(canonical).digest("hex");
}
