import crypto from "node:crypto";
import { spawn } from "node:child_process";
import path from "node:path";
import type { RunDiff } from "../agent/run-diff.ts";

export type GitFileState = "staged" | "unstaged" | "untracked" | "conflicted";
export interface GitFileStatus { readonly path: string; readonly states: readonly GitFileState[]; }
export interface GitStatusSummary {
  readonly isRepository: boolean;
  readonly repositoryRoot?: string;
  readonly branch?: string;
  readonly head?: string;
  readonly upstream?: string;
  readonly ahead?: number;
  readonly behind?: number;
  readonly files: readonly GitFileStatus[];
}
export interface GitChangeReport { readonly before: GitStatusSummary; readonly after: GitStatusSummary; readonly userModifiedPaths: readonly string[]; readonly agentModifiedPaths: readonly string[]; readonly overlappingPaths: readonly string[]; }
export interface GitCommitPreview { readonly status: GitStatusSummary; readonly diffCheck: readonly string[]; readonly digest: string; readonly message: string; }

/** 固定 argv 的 Git 只读查询器；不允许仓库配置注入 shell、hooks 或外部 diff。 */
export class GitRepository {
  readonly workspaceRoot: string;
  private readonly maxOutputBytes: number;
  constructor(workspaceRoot: string, options: { readonly maxOutputBytes?: number } = {}) { this.workspaceRoot = path.resolve(workspaceRoot); this.maxOutputBytes = options.maxOutputBytes ?? 256 * 1024; }

  async status(): Promise<GitStatusSummary> {
    const topLevel = await this.run(["rev-parse", "--show-toplevel"], true);
    if (!topLevel.ok) return { isRepository: false, files: [] };
    const repositoryRoot = topLevel.stdout.trim();
    const branchOutput = await this.run(["status", "--porcelain=v1", "--branch", "-z"]);
    if (!branchOutput.ok) return { isRepository: false, files: [] };
    const { branch, upstream, ahead, behind, files } = parseStatus(branchOutput.stdout);
    const headOutput = await this.run(["rev-parse", "HEAD"], true);
    return { isRepository: true, repositoryRoot, branch, upstream, ahead, behind, head: headOutput.ok ? headOutput.stdout.trim() : undefined, files };
  }

  async fileDiff(file: string, staged = false): Promise<string> {
    if (!isRelativeFile(file)) throw new Error("Git diff path must be a non-empty relative file path");
    const result = await this.run(["diff", "--no-ext-diff", "--no-textconv", "--unified=3", ...(staged ? ["--cached"] : []), "--", file]);
    if (!result.ok) throw new Error(`Git diff failed: ${result.stderr || "unknown error"}`);
    return result.stdout;
  }

  async commitPreview(message: string): Promise<GitCommitPreview> {
    if (!message.trim() || /[\r\n\0]/.test(message)) throw new Error("Commit message must be a non-empty single line");
    const [status, check] = await Promise.all([this.status(), this.run(["diff", "--check", "--no-ext-diff", "--no-textconv", "HEAD"]) ]);
    const diffCheck = check.stdout.split(/\r?\n/).filter(Boolean).concat(check.stderr.split(/\r?\n/).filter(Boolean));
    const digest = crypto.createHash("sha256").update(JSON.stringify({ status, message, diffCheck })).digest("hex");
    return { status, diffCheck, digest, message };
  }

  private async run(args: readonly string[], allowFailure = false): Promise<{ ok: boolean; stdout: string; stderr: string }> {
    return await new Promise((resolve, reject) => {
      const child = spawn("git", ["-c", "core.hooksPath=", "-C", this.workspaceRoot, ...args], { shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = Buffer.alloc(0); let stderr = Buffer.alloc(0); let exceeded = false;
      const collect = (target: "stdout" | "stderr") => (chunk: Buffer) => { if (exceeded) return; const next = Buffer.concat([target === "stdout" ? stdout : stderr, chunk]); if (next.length > this.maxOutputBytes) { exceeded = true; child.kill(); return; } if (target === "stdout") stdout = next; else stderr = next; };
      child.stdout.on("data", collect("stdout")); child.stderr.on("data", collect("stderr"));
      child.once("error", reject);
      child.once("close", (code) => { if (exceeded) return reject(new Error("Git output exceeds configured limit")); const result = { ok: code === 0, stdout: stdout.toString("utf8"), stderr: stderr.toString("utf8") }; if (!result.ok && !allowFailure) return resolve(result); resolve(result); });
    });
  }
}

/** 运行前后 Git 状态与 Agent 变更集交叉标记，避免把已存在的用户修改归属给 Agent。 */
export class GitChangeTracker {
  private before?: GitStatusSummary;
  private readonly repository: GitRepository;
  constructor(repository: GitRepository) { this.repository = repository; }
  async start(): Promise<void> { this.before = await this.repository.status(); }
  async finish(diff?: RunDiff): Promise<GitChangeReport> {
    const before = this.before ?? await this.repository.status();
    const after = await this.repository.status();
    const user = new Set(before.files.map((file) => file.path));
    const agent = new Set(diff?.files.map((file) => file.path) ?? []);
    const current = new Set(after.files.map((file) => file.path));
    const userModifiedPaths = [...user].filter((file) => current.has(file)).sort();
    const agentModifiedPaths = [...agent].filter((file) => current.has(file) || !before.files.some((entry) => entry.path === file)).sort();
    return { before, after, userModifiedPaths, agentModifiedPaths, overlappingPaths: agentModifiedPaths.filter((file) => user.has(file)) };
  }
}

function parseStatus(output: string): Pick<GitStatusSummary, "branch" | "upstream" | "ahead" | "behind" | "files"> {
  let branch: string | undefined; let upstream: string | undefined; let ahead: number | undefined; let behind: number | undefined;
  const files: GitFileStatus[] = [];
  const entries = output.split("\0");
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]; if (!entry) continue;
    if (entry.startsWith("## ")) { const value = entry.slice(3); const match = /^([^ .]+)(?:\.\.\.([^ ]+))?(?: \[ahead (\d+)(?:, behind (\d+))?\]| \[behind (\d+)\])?$/.exec(value); if (match) { branch = match[1]; upstream = match[2]; ahead = match[3] === undefined ? undefined : Number(match[3]); behind = match[4] === undefined ? (match[5] === undefined ? undefined : Number(match[5])) : Number(match[4]); } continue; }
    if (entry.length < 4) continue;
    const xy = entry.slice(0, 2); const file = entry.slice(3); const states: GitFileState[] = [];
    if (xy === "??") states.push("untracked"); else { if (xy[0] === "U" || xy[1] === "U") states.push("conflicted"); if (xy[0] !== " ") states.push("staged"); if (xy[1] !== " ") states.push("unstaged"); }
    files.push({ path: file, states });
    if ((xy[0] === "R" || xy[0] === "C") && entries[index + 1]) index += 1;
  }
  return { branch, upstream, ahead, behind, files };
}
function isRelativeFile(value: string): boolean { return Boolean(value.trim()) && !value.includes("\0") && !/[\r\n]/.test(value) && !path.isAbsolute(value) && !value.split(/[\\/]/).includes(".."); }
