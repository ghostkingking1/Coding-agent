import type { ModelCapabilities, ModelClient, ModelRequest, ModelResponse, Role } from "../agent/types.ts";

/** 发起模型网络请求前提供给审批方的非敏感摘要。 */
export interface ModelApprovalRequest {
  readonly provider: string;
  readonly model: string;
  readonly endpointOrigin: string;
  readonly messageCount: number;
  readonly roles: readonly Role[];
  readonly toolNames: readonly string[];
}

/** 决定是否允许一次模型网络请求的策略。 */
export interface ModelApprovalPolicy {
  requestApproval(request: ModelApprovalRequest): Promise<boolean> | boolean;
}

/** 默认拒绝模型网络请求；只有显式确认回调才能放行。 */
export class DefaultModelApprovalPolicy implements ModelApprovalPolicy {
  private readonly confirm?: (request: ModelApprovalRequest) => Promise<boolean> | boolean;

  constructor(confirm?: (request: ModelApprovalRequest) => Promise<boolean> | boolean) {
    this.confirm = confirm;
  }

  requestApproval(request: ModelApprovalRequest): Promise<boolean> | boolean {
    return this.confirm?.(request) ?? false;
  }
}

/** 模型网络请求未获批准时抛出的错误。 */
export class ModelApprovalDeniedError extends Error {
  constructor(provider: string, model: string) {
    super(`Approval denied for model request: ${provider}/${model}`);
    this.name = "ModelApprovalDeniedError";
  }
}

/** 包装真实模型，确保每次可能向外发送对话或工具结果的请求都先经过审批。 */
export class ApprovedModelClient implements ModelClient {
  readonly provider: string;
  readonly model: string;
  readonly capabilities: ModelCapabilities;
  private readonly client: ModelClient;
  private readonly endpointOrigin: string;
  private readonly approval: ModelApprovalPolicy;
  private readonly onApprovalRequired?: (request: ModelApprovalRequest) => void | Promise<void>;

  constructor(
    client: ModelClient,
    options: {
      readonly endpointOrigin: string;
      readonly approval?: ModelApprovalPolicy;
      readonly onApprovalRequired?: (request: ModelApprovalRequest) => void | Promise<void>;
    },
  ) {
    if (!options.endpointOrigin.trim()) throw new Error("endpointOrigin must not be empty");
    this.client = client;
    this.provider = client.provider;
    this.model = client.model;
    this.capabilities = client.capabilities;
    this.endpointOrigin = options.endpointOrigin;
    this.approval = options.approval ?? new DefaultModelApprovalPolicy();
    this.onApprovalRequired = options.onApprovalRequired;
  }

  async generate(request: ModelRequest): Promise<ModelResponse> {
    request.signal?.throwIfAborted();
    const approvalRequest: ModelApprovalRequest = {
      provider: this.provider,
      model: this.model,
      endpointOrigin: this.endpointOrigin,
      messageCount: request.messages.length,
      roles: request.messages.map((message) => message.role),
      toolNames: [...new Set(request.tools.map((tool) => tool.name))],
    };
    /** 模型调用可能上传代码和工具输出，因此不能因其不是 Tool 而绕过网络审批。 */
    await this.onApprovalRequired?.(approvalRequest);
    if (!(await this.approval.requestApproval(approvalRequest))) {
      throw new ModelApprovalDeniedError(this.provider, this.model);
    }
    return this.client.generate(request);
  }
}
