import { z } from "zod";
import { defineTool } from "../tools/tool-schema.ts";
import type { Tool } from "../agent/types.ts";
import { GitRepository } from "./git.ts";
import type { RepositoryInstructions } from "./instructions.ts";

const emptyInput = z.preprocess((value) => value ?? {}, z.object({}).strict());
const fileDiffInput = z.object({ path: z.string().min(1).max(4096), staged: z.boolean().default(false) }).strict();

/** 将仓库指令审计和 Git 状态作为只读工具公开；模型不能用它们修改加载策略或 Git 状态。 */
export function createRepositoryTools(instructions: RepositoryInstructions, repository: GitRepository): readonly Tool[] {
  return [
    defineTool({
      name: "get_repository_instructions",
      description: "Show the repository instruction files loaded for this run, including their source, applicable directory, digest, and bounded content.",
      capabilities: ["read"],
      parallelizable: true,
      inputSchema: emptyInput,
      modelInputSchema: { type: "object", additionalProperties: false },
      execute: () => instructions,
    }),
    defineTool({
      name: "get_git_status",
      description: "Read the current Git branch, HEAD, upstream, and concise staged, unstaged, untracked, and conflicted file status.",
      capabilities: ["read"],
      parallelizable: true,
      inputSchema: emptyInput,
      modelInputSchema: { type: "object", additionalProperties: false },
      execute: () => repository.status(),
    }),
    defineTool({
      name: "get_git_file_diff",
      description: "Read a bounded Git diff for one relative workspace file. Set staged to true to inspect the index diff.",
      capabilities: ["read"],
      parallelizable: true,
      conflictKey: (input) => `git-diff:${input.staged}:${input.path}`,
      inputSchema: fileDiffInput,
      modelInputSchema: { type: "object", properties: { path: { type: "string", minLength: 1 }, staged: { type: "boolean", default: false } }, required: ["path"], additionalProperties: false },
      execute: (input) => repository.fileDiff(input.path, input.staged),
    }),
  ];
}
