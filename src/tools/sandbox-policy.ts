import crypto from "node:crypto";
import { canonicalNetworkPolicy, networkCapability, type ExecutionNetworkPolicy, type ExecutionRequest, type SandboxCapability } from "./sandbox.ts";

/** V3 网络策略；当前命令工具默认只允许 off，其他模式必须由后端真实声明。 */
export type NetworkPolicy = ExecutionNetworkPolicy;

export type RiskClass = "R0" | "R1" | "R2" | "R3" | "R4" | "R5" | "R6";

export interface SandboxPolicy {
  readonly filesystem: "workspace-read" | "workspace-write";
  readonly network: NetworkPolicy;
  readonly process: "single" | "child-processes";
  readonly credentials: "none";
  readonly devices: "none";
}

export interface PolicyDecision {
  readonly allowed: boolean;
  readonly policy: SandboxPolicy;
  readonly riskClass: RiskClass;
  readonly requiredCapabilities: readonly SandboxCapability[];
  readonly missingCapabilities: readonly SandboxCapability[];
  readonly reason?: string;
  readonly policyDigest: string;
  readonly approvalDigest: string;
}

const SHELLS = new Set(["cmd", "cmd.exe", "powershell", "powershell.exe", "pwsh", "pwsh.exe", "sh", "bash", "zsh"]);
const SCRIPT_RUNTIMES = new Set(["node", "node.exe", "python", "python.exe", "python3", "ruby", "perl", "php"]);
const TOOLCHAIN_COMMANDS = new Set(["npm", "npm.cmd", "npx", "npx.cmd", "git", "git.exe", "cargo", "cargo.exe", "rustc", "rustc.exe"]);

/** 根据完整执行请求分类；分类结果不等价于放行，仍必须经过 Capability 策略。 */
export function classifyExecution(request: ExecutionRequest): RiskClass {
  const executable = basename(request.executable).toLowerCase();
  const args = request.args.map((arg) => arg.toLowerCase());
  const hasScriptFile = args.some((arg) => /\.(ps1|bat|cmd|sh|bash|py|js|mjs|cjs|rb|pl|php)$/.test(arg));
  if (canonicalNetworkPolicy(request.network).mode !== "off") return "R5";
  if (SHELLS.has(executable) || hasScriptFile) return "R4";
  if (SCRIPT_RUNTIMES.has(executable) || TOOLCHAIN_COMMANDS.has(executable)) return "R4";
  if (request.env.PATH || request.env.Path) return "R3";
  if (request.maxProcesses > 1) return "R3";
  return request.filesystemWriteHint ? "R2" : "R1";
}

/** V3 的最小策略生成器；后续网络 allowlist/proxy 只需替换 network policy。 */
export function defaultCommandPolicy(request: ExecutionRequest): SandboxPolicy {
  return {
    filesystem: request.filesystemWriteHint ? "workspace-write" : "workspace-read",
    network: canonicalNetworkPolicy(request.network),
    process: request.maxProcesses > 1 ? "child-processes" : "single",
    credentials: "none",
    devices: "none",
  };
}

export function decideSandboxPolicy(request: ExecutionRequest, capabilities: readonly SandboxCapability[]): PolicyDecision {
  const policy = defaultCommandPolicy(request);
  const riskClass = classifyExecution(request);
  const required: SandboxCapability[] = ["process.spawn", "workspace.fs", networkCapability(policy.network), "resource.limits"];
  if (policy.process === "child-processes") required.push("process-tree");
  if (policy.network.mode === "allowlist") required.push("network.proxy");
  if (request.filesystemWriteHint) required.push("filesystem.workspace_write");
  const missingCapabilities = required.filter((capability) => !capabilities.includes(capability));
  const reason = missingCapabilities.length > 0 ? `Missing sandbox capabilities: ${missingCapabilities.join(", ")}` : undefined;
  return {
    allowed: missingCapabilities.length === 0,
    policy,
    riskClass,
    requiredCapabilities: required,
    missingCapabilities,
    ...(reason ? { reason } : {}),
    policyDigest: sandboxPolicyDigest(policy),
    approvalDigest: policyBindingDigest(request, policy, capabilities),
  };
}

/** Approval 绑定请求、策略和实际 Capability 快照，任一项变化都必须重新授权。 */
export function policyBindingDigest(
  request: ExecutionRequest,
  policy: SandboxPolicy,
  capabilities: readonly SandboxCapability[],
): string {
  const canonical = JSON.stringify({
    request: {
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
    },
    policy,
    capabilities: [...capabilities].sort(),
  });
  return crypto.createHash("sha256").update(canonical, "utf8").digest("hex");
}

export function sandboxPolicyDigest(policy: SandboxPolicy): string {
  const canonical = JSON.stringify({
    filesystem: policy.filesystem,
    network: policy.network,
    process: policy.process,
    credentials: policy.credentials,
    devices: policy.devices,
  });
  return crypto.createHash("sha256").update(canonical, "utf8").digest("hex");
}

function basename(value: string): string {
  const normalized = value.replaceAll("\\", "/");
  return normalized.slice(normalized.lastIndexOf("/") + 1);
}
