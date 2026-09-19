import type { Message, ModelCapabilities, ModelClient, ModelRequest, ModelResponse, ModelStreamEvent } from "../agent/types.ts";

export interface ModelRouteDecision {
  readonly route: "simple" | "complex";
  readonly provider: string;
  readonly model: string;
  readonly score: number;
  readonly threshold: number;
  readonly reasons: readonly string[];
  readonly signals: {
    readonly estimatedTokens: number;
    readonly budgetRatio: number;
    readonly messageCount: number;
    readonly toolCallCount: number;
    readonly toolFailureCount: number;
    readonly currentRequestCharacters: number;
    readonly highRiskTerms: readonly string[];
  };
}

export interface ModelRouterOptions {
  readonly simple: ModelClient;
  readonly complex: ModelClient;
  readonly complexThreshold?: number;
  readonly onDecision?: (decision: ModelRouteDecision) => void | Promise<void>;
}

const HIGH_RISK_TERMS = ["security", "vulnerability", "race condition", "rollback", "migration", "architecture", "concurrency", "安全", "漏洞", "竞态", "回滚", "迁移", "架构", "并发"] as const;

/** 根据已发生、可观测的请求事实选择模型，不依赖预计文件数或预计改动规模。 */
export class ModelRouter implements ModelClient {
  readonly provider = "router";
  readonly model: string;
  readonly capabilities: ModelCapabilities;
  private readonly simple: ModelClient;
  private readonly complex: ModelClient;
  private readonly threshold: number;
  private readonly onDecision?: (decision: ModelRouteDecision) => void | Promise<void>;

  constructor(options: ModelRouterOptions) {
    this.simple = options.simple;
    this.complex = options.complex;
    this.threshold = options.complexThreshold ?? 4;
    if (!Number.isInteger(this.threshold) || this.threshold < 1) throw new Error("complexThreshold must be a positive integer");
    if (!this.simple.capabilities.toolCalling || !this.complex.capabilities.toolCalling) throw new Error("All routed models must support tool calling");
    this.capabilities = {
      toolCalling: true,
      streaming: this.simple.capabilities.streaming && this.complex.capabilities.streaming
        && this.simple.generateStream !== undefined && this.complex.generateStream !== undefined,
    };
    this.model = `${this.simple.model}|${this.complex.model}`;
    this.onDecision = options.onDecision;
  }

  async generate(request: ModelRequest): Promise<ModelResponse> {
    const { client, decision } = this.select(request);
    await this.recordDecision(request, decision);
    return client.generate(request);
  }

  async *generateStream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    const { client, decision } = this.select(request);
    await this.recordDecision(request, decision);
    if (!client.generateStream) throw new Error(`Selected model does not support streaming: ${client.model}`);
    yield* client.generateStream(request);
  }

  decide(request: ModelRequest): ModelRouteDecision {
    return this.select(request).decision;
  }

  private select(request: ModelRequest): { client: ModelClient; decision: ModelRouteDecision } {
    const signals = routingSignals(request);
    const reasons: string[] = [];
    let score = 0;
    if (signals.budgetRatio >= 0.7) { score += 4; reasons.push("context_budget_70_percent"); }
    else if (signals.budgetRatio >= 0.4) { score += 2; reasons.push("context_budget_40_percent"); }
    if (signals.messageCount >= 20) { score += 2; reasons.push("long_conversation"); }
    else if (signals.messageCount >= 10) { score += 1; reasons.push("multi_turn_conversation"); }
    if (signals.toolCallCount >= 6) { score += 2; reasons.push("many_observed_tool_calls"); }
    else if (signals.toolCallCount >= 3) { score += 1; reasons.push("several_observed_tool_calls"); }
    if (signals.toolFailureCount > 0) { score += Math.min(3, signals.toolFailureCount + 1); reasons.push("observed_tool_failures"); }
    if (signals.currentRequestCharacters >= 2_000) { score += 1; reasons.push("large_current_request"); }
    if (signals.highRiskTerms.length > 0) { score += 2; reasons.push("explicit_high_risk_scope"); }
    const route = score >= this.threshold ? "complex" : "simple";
    const client = route === "complex" ? this.complex : this.simple;
    return { client, decision: { route, provider: client.provider, model: client.model, score, threshold: this.threshold, reasons, signals } };
  }

  private async recordDecision(request: ModelRequest, decision: ModelRouteDecision): Promise<void> {
    await this.onDecision?.(decision);
    await request.routingAudit?.sink.record({
      sessionId: request.routingAudit.sessionId,
      runId: request.routingAudit.runId,
      eventType: "model_route_decided",
      status: decision.route,
      metadata: {
        provider: decision.provider,
        model: decision.model,
        score: decision.score,
        threshold: decision.threshold,
        reasons: decision.reasons,
        signals: decision.signals,
      },
    });
  }
}

function routingSignals(request: ModelRequest): ModelRouteDecision["signals"] {
  const messages = request.messages;
  const estimatedTokens = request.contextResult?.estimatedTokens ?? estimateTokens(messages);
  const budget = request.contextResult?.budget ?? 32_000;
  const toolCallCount = messages.reduce((count, message) => count + (message.role === "assistant" ? message.toolCalls?.length ?? 0 : 0), 0);
  const toolFailureCount = messages.filter((message) => message.role === "tool" && isToolFailure(message.content)).length;
  const currentRequest = [...messages].reverse().find((message) => message.role === "user")?.content ?? "";
  const normalized = currentRequest.toLowerCase();
  const highRiskTerms = HIGH_RISK_TERMS.filter((term) => normalized.includes(term));
  return {
    estimatedTokens,
    budgetRatio: Math.min(1, estimatedTokens / Math.max(1, budget)),
    messageCount: messages.length,
    toolCallCount,
    toolFailureCount,
    currentRequestCharacters: currentRequest.length,
    highRiskTerms,
  };
}

function estimateTokens(messages: readonly Message[]): number {
  return Math.ceil(messages.reduce((total, message) => total + message.content.length + (message.role === "assistant" ? JSON.stringify(message.toolCalls ?? []).length : 0), 0) / 4);
}

function isToolFailure(content: string): boolean {
  try {
    const value = JSON.parse(content) as unknown;
    return Boolean(value && typeof value === "object" && !Array.isArray(value) && "error" in value);
  } catch { return false; }
}
