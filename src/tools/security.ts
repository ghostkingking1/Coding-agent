import fs from "node:fs";
import path from "node:path";
import type { ApprovalRequest, Tool, ToolContext, ToolExecutionPolicy } from "../agent/types.ts";

/** 工作区路径和资源限制的配置。 */
export interface WorkspacePolicyOptions {
  /** 工作区根目录。 */
  readonly root: string;
  /** 是否允许访问隐藏路径。 */
  readonly allowHidden?: boolean;
  /** 单个文件允许读取或写入的最大字节数。 */
  readonly maxFileBytes?: number;
  /** 目录遍历或搜索最多返回的条目数。 */
  readonly maxEntries?: number;
}

/** 工作区安全边界校验失败时抛出的错误。 */
export class WorkspaceSecurityError extends Error {
  /** 创建带有安全错误类型标识的异常。 */
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceSecurityError";
  }
}

/** 将路径解析、隐藏文件和资源限制统一收口的工作区策略。 */
export class WorkspacePolicy {
  readonly root: string;
  readonly allowHidden: boolean;
  readonly maxFileBytes: number;
  readonly maxEntries: number;

  /** 创建工作区策略并规范化根目录。 */
  constructor(options: WorkspacePolicyOptions) {
    if (!options.root.trim()) throw new Error("Workspace root must not be empty");
    /** 固定规范化根目录，后续路径比较必须使用同一种路径表示。 */
    this.root = fs.realpathSync.native(path.resolve(options.root));
    this.allowHidden = options.allowHidden ?? false;
    this.maxFileBytes = options.maxFileBytes ?? 1024 * 1024;
    this.maxEntries = options.maxEntries ?? 5000;
    if (!Number.isInteger(this.maxFileBytes) || this.maxFileBytes < 1) {
      throw new Error("maxFileBytes must be a positive integer");
    }
    if (!Number.isInteger(this.maxEntries) || this.maxEntries < 1) {
      throw new Error("maxEntries must be a positive integer");
    }
  }

  /** 解析工作区内已存在的路径，并拒绝越界、隐藏或无法解析的路径。 */
  resolveExisting(input: unknown): string {
    if (typeof input !== "string" || !input.trim()) {
      throw new WorkspaceSecurityError("Path must be a non-empty string");
    }
    if (input.includes("\0")) throw new WorkspaceSecurityError("Path contains a null byte");
    let candidate: string;
    try {
      /** 先解析符号链接再做边界判断，防止链接把访问带出工作区。 */
      candidate = fs.realpathSync.native(path.resolve(this.root, input));
    } catch {
      throw new WorkspaceSecurityError("Path does not exist or cannot be resolved");
    }
    this.assertWithin(candidate);
    this.assertVisible(candidate);
    return candidate;
  }

  /** 解析受大小限制的普通文件。 */
  resolveFile(input: unknown): { path: string; size: number } {
    const resolved = this.resolveExisting(input);
    const stat = fs.statSync(resolved);
    if (!stat.isFile()) throw new WorkspaceSecurityError("Expected a regular file");
    if (stat.size > this.maxFileBytes) {
      throw new WorkspaceSecurityError(`File exceeds the ${this.maxFileBytes}-byte limit`);
    }
    return { path: resolved, size: stat.size };
  }

  /** 解析受工作区边界限制的目录。 */
  resolveDirectory(input: unknown = "."): string {
    const resolved = this.resolveExisting(input);
    if (!fs.statSync(resolved).isDirectory()) throw new WorkspaceSecurityError("Expected a directory");
    return resolved;
  }

  /** 返回规范化路径相对于工作区根目录的表示。 */
  relative(resolved: string): string {
    return path.relative(this.root, resolved) || ".";
  }

  /** 判断规范化路径是否仍位于工作区内。 */
  private assertWithin(candidate: string): void {
    const relative = path.relative(this.root, candidate);
    if (relative && (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))) {
      throw new WorkspaceSecurityError("Path is outside the workspace");
    }
  }

  /** 按策略拒绝隐藏路径，避免默认暴露凭据或工具元数据。 */
  private assertVisible(candidate: string): void {
    if (this.allowHidden) return;
    /** 默认排除隐藏路径，因为其中通常包含凭据或工具元数据。 */
    const relative = path.relative(this.root, candidate);
    if (relative.split(path.sep).some((part) => part.startsWith(".") && part !== ".")) {
      throw new WorkspaceSecurityError("Hidden workspace paths are not allowed");
    }
  }
}

/** 在工具执行前决定是否允许其请求的审批策略。 */
export interface ApprovalPolicy {
  /** 请求用户或上层策略批准一次工具操作。 */
  requestApproval(request: ApprovalRequest): Promise<boolean> | boolean;
}

/** 默认只自动允许只读工具，其余能力默认拒绝。 */
export class DefaultApprovalPolicy implements ApprovalPolicy {
  private readonly confirm?: (request: ApprovalRequest) => Promise<boolean> | boolean;

  /** 创建一个可选的交互式确认回调。 */
  constructor(confirm?: (request: ApprovalRequest) => Promise<boolean> | boolean) {
    this.confirm = confirm;
  }

  /** 根据工具能力决定是否自动通过或交给确认回调。 */
  requestApproval(request: ApprovalRequest): Promise<boolean> | boolean {
    if (request.capabilities.every((capability) => capability === "read")) return true;
    return this.confirm?.(request) ?? false;
  }
}

/** 工具审批被拒绝时抛出的错误。 */
export class ApprovalDeniedError extends Error {
  /** 创建包含工具名称的拒绝错误。 */
  constructor(toolName: string) {
    super(`Approval denied for tool: ${toolName}`);
    this.name = "ApprovalDeniedError";
  }
}

/** 安全策略的审批和 manifest 配置。 */
export interface SecurityPolicyOptions {
  /** 实际执行审批决定的策略。 */
  readonly approval?: ApprovalPolicy;
  /** 是否拒绝未声明 manifest 的工具。 */
  readonly requireManifest?: boolean;
  /** 发起审批请求时调用的观察器。 */
  readonly onApprovalRequired?: (request: ApprovalRequest) => void | Promise<void>;
}

/** 在工具注册表执行工具前执行能力和审批检查。 */
export class SecurityPolicy implements ToolExecutionPolicy {
  private readonly approval: ApprovalPolicy;
  private readonly requireManifest: boolean;
  private readonly options: SecurityPolicyOptions;

  /** 创建安全策略，默认要求工具声明 manifest 且拒绝未批准的副作用。 */
  constructor(options: SecurityPolicyOptions = {}) {
    this.options = options;
    this.approval = options.approval ?? new DefaultApprovalPolicy();
    this.requireManifest = options.requireManifest ?? true;
  }

  /** 在副作用发生前验证 manifest、生成预览并完成审批。 */
  async authorize(tool: Tool, input: unknown, _context: ToolContext): Promise<void> {
    const manifest = tool.manifest;
    if (!manifest) {
      if (this.requireManifest) throw new WorkspaceSecurityError(`Tool has no manifest: ${tool.name}`);
      return;
    }
    if (manifest.capabilities.every((capability) => capability === "read")) return;
    /** 在请求审批前生成预览，让审批方看到即将发生的精确变更。 */
    const preview = tool.preview ? await tool.preview(input, _context) : undefined;
    const request: ApprovalRequest = {
      toolName: tool.name,
      capabilities: manifest.capabilities,
      input,
      preview,
    };
    /** 必须先完成授权，注册表才会调用工具并触发副作用。 */
    await this.options.onApprovalRequired?.(request);
    if (!(await this.approval.requestApproval(request))) throw new ApprovalDeniedError(tool.name);
  }
}
