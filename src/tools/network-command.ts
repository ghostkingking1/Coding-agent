import crypto from "node:crypto";
import type { Tool } from "../agent/types.ts";
import { createRunCommandTool, type RunCommandToolOptions } from "./command-tools.ts";
import {
  ControlledNetworkProxy,
  type NetworkProxyEvent,
  type NetworkProxyLimits,
  type NetworkTargetPolicy,
} from "./network-proxy.ts";
import type { ExecutionNetworkPolicy } from "./sandbox.ts";
import type { WorkspacePolicy } from "./security.ts";

export interface ManagedNetworkCommandOptions extends Omit<RunCommandToolOptions, "allowedNetwork">, NetworkProxyLimits {
  readonly network: NetworkTargetPolicy;
  readonly proxyId?: string;
  readonly onNetworkEvent?: (event: NetworkProxyEvent) => void;
}

export interface ManagedNetworkCommandTool {
  readonly tool: Tool;
  readonly networkPolicy: Extract<ExecutionNetworkPolicy, { readonly mode: "allowlist" }>;
  close(): Promise<void>;
}

/**
 * 先固定代理身份与监听端点，再创建工具，确保 preview、Approval digest 和实际执行
 * 始终引用同一网络策略；调用方必须在 Agent 生命周期结束时调用 close。
 */
export async function createManagedNetworkCommandTool(
  workspace: WorkspacePolicy,
  options: ManagedNetworkCommandOptions,
): Promise<ManagedNetworkCommandTool> {
  const proxy = new ControlledNetworkProxy({
    policy: options.network,
    connectTimeoutMs: options.connectTimeoutMs,
    idleTimeoutMs: options.idleTimeoutMs,
    maxRequestBytes: options.maxRequestBytes,
    maxResponseBytes: options.maxResponseBytes,
    maxTunnelBytes: options.maxTunnelBytes,
    onEvent: options.onNetworkEvent,
  });
  try {
    await proxy.start();
    const networkPolicy = proxy.executionPolicy(options.proxyId ?? crypto.randomUUID());
    const tool = createRunCommandTool(workspace, {
      defaultTimeoutMs: options.defaultTimeoutMs,
      maxTimeoutMs: options.maxTimeoutMs,
      maxStdoutBytes: options.maxStdoutBytes,
      maxStderrBytes: options.maxStderrBytes,
      allowedEnv: options.allowedEnv,
      sandbox: options.sandbox,
      requireOsIsolation: options.requireOsIsolation,
      cpuTimeMs: options.cpuTimeMs,
      memoryBytes: options.memoryBytes,
      maxProcesses: options.maxProcesses,
      allowedNetwork: networkPolicy,
    });
    return {
      tool,
      networkPolicy,
      close: () => proxy.close(),
    };
  } catch (error) {
    await proxy.close().catch(() => undefined);
    throw error;
  }
}
