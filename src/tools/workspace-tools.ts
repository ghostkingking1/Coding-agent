import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { listFilesModelInputSchema, readFileModelInputSchema, searchTextModelInputSchema } from "./model-tool-schemas.ts";
import { WorkspacePolicy } from "./security.ts";
import { pathInputSchema } from "./tool-input-schemas.ts";
import { defineTool } from "./tool-schema.ts";
import type { Tool } from "../agent/types.ts";
import { createPatchTool } from "./patch-tools.ts";
import { createRunCommandTool } from "./command-tools.ts";
import { createRunTestsTool } from "./test-tools.ts";

const readFileInputSchema = z.object({ path: pathInputSchema }).strict();
const listFilesInputSchema = z.preprocess((value) => value ?? {}, z.object({
  path: pathInputSchema.default("."),
  depth: z.number().int().min(0).max(8).default(2),
}).strict());
const searchTextInputSchema = z.object({
  query: pathInputSchema,
  path: pathInputSchema.default("."),
  maxResults: z.number().int().min(1).max(1000).default(100),
}).strict();

/** 创建一组受 WorkspacePolicy 约束的文件读取、搜索、patch 和命令执行工具。 */
export function createWorkspaceTools(policy: WorkspacePolicy): readonly Tool[] {
  return [
    defineTool({
      name: "read_file",
      description: "Read a UTF-8 text file inside the workspace.",
      capabilities: ["read"],
      inputSchema: readFileInputSchema,
      modelInputSchema: readFileModelInputSchema,
      async execute(input) {
        const file = policy.resolveFile(input.path);
        const content = await fs.readFile(file.path, "utf8");
        return { path: policy.relative(file.path), content };
      },
    }),
    defineTool({
      name: "list_files",
      description: "List files and directories inside the workspace.",
      capabilities: ["read"],
      inputSchema: listFilesInputSchema,
      modelInputSchema: listFilesModelInputSchema,
      async execute(input) {
        const root = policy.resolveDirectory(input.path);
        const entries: string[] = [];
        /** 限制遍历深度和条目数量，避免大型仓库耗尽模型上下文。 */
        await walk(root, 0);
        return entries;

        async function walk(directory: string, currentDepth: number): Promise<void> {
          const children = (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
          for (const child of children) {
            if (!policy.allowHidden && child.name.startsWith(".")) continue;
            if (entries.length >= policy.maxEntries) return;
            const childPath = policy.resolveExisting(path.join(directory, child.name));
            entries.push(policy.relative(childPath));
            if (child.isDirectory() && currentDepth < input.depth) await walk(childPath, currentDepth + 1);
          }
        }
      },
    }),
    createPatchTool(policy),
    createRunCommandTool(policy),
    createRunTestsTool(policy),
    defineTool({
      name: "search_text",
      description: "Search for a literal string in UTF-8 text files inside the workspace.",
      capabilities: ["read"],
      inputSchema: searchTextInputSchema,
      modelInputSchema: searchTextModelInputSchema,
      async execute(input) {
        const root = policy.resolveDirectory(input.path);
        const results: Array<{ path: string; line: number; text: string }> = [];
        /** 返回有上限的逐行匹配结果，避免把整个文件内容塞入上下文。 */
        await search(root);
        return results;

        async function search(directory: string): Promise<void> {
          const children = (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
          for (const child of children) {
            if (results.length >= input.maxResults) return;
            if (!policy.allowHidden && child.name.startsWith(".")) continue;
            const childPath = policy.resolveExisting(path.join(directory, child.name));
            if (child.isDirectory()) {
              await search(childPath);
              continue;
            }
            if (!child.isFile()) continue;
            const file = policy.resolveFile(childPath);
            const content = await fs.readFile(file.path, "utf8");
            if (content.includes("\0")) continue;
            content.split(/\r?\n/).forEach((text, index) => {
              if (results.length < input.maxResults && text.includes(input.query)) {
                results.push({ path: policy.relative(file.path), line: index + 1, text });
              }
            });
          }
        }
      },
    }),
  ];
}
