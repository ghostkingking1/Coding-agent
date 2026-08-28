import type { ModelClient } from "../core/types.ts";
import { DefaultModelApprovalPolicy, ApprovedModelClient, type ModelApprovalPolicy, type ModelApprovalRequest } from "./approval.ts";
import { OpenAICompatibleModel } from "./openai-compatible.ts";
import type { HttpTransport } from "./transport.ts";

const PROVIDER_ENV = "CODING_AGENT_MODEL_PROVIDER";
const BASE_URL_ENV = "CODING_AGENT_MODEL_BASE_URL";
const MODEL_ENV = "CODING_AGENT_MODEL";
const API_KEY_ENV = "CODING_AGENT_MODEL_API_KEY";
const TIMEOUT_ENV = "CODING_AGENT_MODEL_TIMEOUT_MS";
const MAX_RESPONSE_BYTES_ENV = "CODING_AGENT_MODEL_MAX_RESPONSE_BYTES";

/** 当前支持的显式模型运行时配置。 */
export interface OpenAICompatibleRuntimeConfig {
  readonly provider: "openai-compatible";
  readonly baseUrl: string;
  readonly model: string;
  readonly apiKey?: string;
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
}

export type ModelRuntimeConfig = OpenAICompatibleRuntimeConfig;

/** 创建真实模型运行时的可选依赖，便于测试并保持网络审批显式。 */
export interface ModelRuntimeOptions {
  readonly transport?: HttpTransport;
  readonly approval?: ModelApprovalPolicy;
  readonly onApprovalRequired?: (request: ModelApprovalRequest) => void | Promise<void>;
}

/**
 * 从显式环境变量读取模型配置。没有任何模型变量时返回 undefined，以保留本地 Echo 演示。
 * 一旦用户开始配置模型，所有必填字段都必须存在，避免静默连到意外服务。
 */
export function readModelRuntimeConfig(environment: Readonly<Record<string, string | undefined>>): ModelRuntimeConfig | undefined {
  const values = [
    environment[PROVIDER_ENV],
    environment[BASE_URL_ENV],
    environment[MODEL_ENV],
    environment[API_KEY_ENV],
    environment[TIMEOUT_ENV],
    environment[MAX_RESPONSE_BYTES_ENV],
  ];
  if (values.every((value) => value === undefined)) return undefined;

  const provider = requireEnvironmentValue(environment, PROVIDER_ENV);
  if (provider !== "openai-compatible") {
    throw new Error(`${PROVIDER_ENV} must be openai-compatible`);
  }
  return {
    provider,
    baseUrl: requireEnvironmentValue(environment, BASE_URL_ENV),
    model: requireEnvironmentValue(environment, MODEL_ENV),
    apiKey: optionalEnvironmentValue(environment, API_KEY_ENV),
    timeoutMs: optionalPositiveInteger(environment, TIMEOUT_ENV),
    maxResponseBytes: optionalPositiveInteger(environment, MAX_RESPONSE_BYTES_ENV),
  };
}

/** 由已验证配置创建受网络审批保护的模型客户端。 */
export function createConfiguredModelClient(config: ModelRuntimeConfig, options: ModelRuntimeOptions = {}): ModelClient {
  const client = new OpenAICompatibleModel({
    baseUrl: config.baseUrl,
    model: config.model,
    apiKey: config.apiKey,
    transport: options.transport,
    timeoutMs: config.timeoutMs,
    maxResponseBytes: config.maxResponseBytes,
  });
  return new ApprovedModelClient(client, {
    endpointOrigin: new URL(config.baseUrl).origin,
    approval: options.approval ?? new DefaultModelApprovalPolicy(),
    onApprovalRequired: options.onApprovalRequired,
  });
}

function requireEnvironmentValue(environment: Readonly<Record<string, string | undefined>>, name: string): string {
  const value = environment[name];
  if (!value?.trim()) throw new Error(`${name} must be set when model configuration is enabled`);
  return value;
}

function optionalEnvironmentValue(environment: Readonly<Record<string, string | undefined>>, name: string): string | undefined {
  const value = environment[name];
  return value?.trim() ? value : undefined;
}

function optionalPositiveInteger(environment: Readonly<Record<string, string | undefined>>, name: string): number | undefined {
  const value = optionalEnvironmentValue(environment, name);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive integer`);
  return parsed;
}
