import fs from "node:fs";
import path from "node:path";
import type { ApprovalRequest, Tool, ToolContext, ToolExecutionPolicy } from "./types.ts";

export interface WorkspacePolicyOptions {
  readonly root: string;
  readonly allowHidden?: boolean;
  readonly maxFileBytes?: number;
  readonly maxEntries?: number;
}

export class WorkspaceSecurityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceSecurityError";
  }
}

export class WorkspacePolicy {
  readonly root: string;
  readonly allowHidden: boolean;
  readonly maxFileBytes: number;
  readonly maxEntries: number;

  constructor(options: WorkspacePolicyOptions) {
    if (!options.root.trim()) throw new Error("Workspace root must not be empty");
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

  resolveExisting(input: unknown): string {
    if (typeof input !== "string" || !input.trim()) {
      throw new WorkspaceSecurityError("Path must be a non-empty string");
    }
    if (input.includes("\0")) throw new WorkspaceSecurityError("Path contains a null byte");
    let candidate: string;
    try {
      candidate = fs.realpathSync.native(path.resolve(this.root, input));
    } catch {
      throw new WorkspaceSecurityError("Path does not exist or cannot be resolved");
    }
    this.assertWithin(candidate);
    this.assertVisible(candidate);
    return candidate;
  }

  resolveFile(input: unknown): { path: string; size: number } {
    const resolved = this.resolveExisting(input);
    const stat = fs.statSync(resolved);
    if (!stat.isFile()) throw new WorkspaceSecurityError("Expected a regular file");
    if (stat.size > this.maxFileBytes) {
      throw new WorkspaceSecurityError(`File exceeds the ${this.maxFileBytes}-byte limit`);
    }
    return { path: resolved, size: stat.size };
  }

  resolveDirectory(input: unknown = "."): string {
    const resolved = this.resolveExisting(input);
    if (!fs.statSync(resolved).isDirectory()) throw new WorkspaceSecurityError("Expected a directory");
    return resolved;
  }

  relative(resolved: string): string {
    return path.relative(this.root, resolved) || ".";
  }

  private assertWithin(candidate: string): void {
    const relative = path.relative(this.root, candidate);
    if (relative && (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))) {
      throw new WorkspaceSecurityError("Path is outside the workspace");
    }
  }

  private assertVisible(candidate: string): void {
    if (this.allowHidden) return;
    const relative = path.relative(this.root, candidate);
    if (relative.split(path.sep).some((part) => part.startsWith(".") && part !== ".")) {
      throw new WorkspaceSecurityError("Hidden workspace paths are not allowed");
    }
  }
}

export interface ApprovalPolicy {
  requestApproval(request: ApprovalRequest): Promise<boolean> | boolean;
}

export class DefaultApprovalPolicy implements ApprovalPolicy {
  private readonly confirm?: (request: ApprovalRequest) => Promise<boolean> | boolean;

  constructor(confirm?: (request: ApprovalRequest) => Promise<boolean> | boolean) {
    this.confirm = confirm;
  }

  requestApproval(request: ApprovalRequest): Promise<boolean> | boolean {
    if (request.capabilities.every((capability) => capability === "read")) return true;
    return this.confirm?.(request) ?? false;
  }
}

export class ApprovalDeniedError extends Error {
  constructor(toolName: string) {
    super(`Approval denied for tool: ${toolName}`);
    this.name = "ApprovalDeniedError";
  }
}

export interface SecurityPolicyOptions {
  readonly approval?: ApprovalPolicy;
  readonly requireManifest?: boolean;
  readonly onApprovalRequired?: (request: ApprovalRequest) => void | Promise<void>;
}

export class SecurityPolicy implements ToolExecutionPolicy {
  private readonly approval: ApprovalPolicy;
  private readonly requireManifest: boolean;
  private readonly options: SecurityPolicyOptions;

  constructor(options: SecurityPolicyOptions = {}) {
    this.options = options;
    this.approval = options.approval ?? new DefaultApprovalPolicy();
    this.requireManifest = options.requireManifest ?? true;
  }

  async authorize(tool: Tool, input: unknown, _context: ToolContext): Promise<void> {
    const manifest = tool.manifest;
    if (!manifest) {
      if (this.requireManifest) throw new WorkspaceSecurityError(`Tool has no manifest: ${tool.name}`);
      return;
    }
    if (manifest.capabilities.every((capability) => capability === "read")) return;
    // Compute the preview before prompting so approval can inspect the exact diff.
    const preview = tool.preview ? await tool.preview(input, _context) : undefined;
    const request: ApprovalRequest = {
      toolName: tool.name,
      capabilities: manifest.capabilities,
      input,
      preview,
    };
    await this.options.onApprovalRequired?.(request);
    if (!(await this.approval.requestApproval(request))) throw new ApprovalDeniedError(tool.name);
  }
}
