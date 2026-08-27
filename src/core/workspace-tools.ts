import fs from "node:fs/promises";
import path from "node:path";
import { WorkspacePolicy } from "./security.ts";
import type { Tool } from "./types.ts";
import { createPatchTool } from "./patch-tools.ts";
import { createRunCommandTool } from "./command-tools.ts";
import { createRunTestsTool } from "./test-tools.ts";

/** 创建一组受 WorkspacePolicy 约束的文件读取、搜索、patch 和命令执行工具。 */
export function createWorkspaceTools(policy: WorkspacePolicy): readonly Tool[] {
  return [
    {
      name: "read_file",
      description: "Read a UTF-8 text file inside the workspace.",
      manifest: { capabilities: ["read"] },
      async execute(input) {
        const value = input as { path?: unknown };
        const file = policy.resolveFile(value?.path);
        const content = await fs.readFile(file.path, "utf8");
        return { path: policy.relative(file.path), content };
      },
    },
    {
      name: "list_files",
      description: "List files and directories inside the workspace.",
      manifest: { capabilities: ["read"] },
      async execute(input) {
        const value = (input ?? {}) as { path?: unknown; depth?: unknown };
        const root = policy.resolveDirectory(value.path ?? ".");
        const depth = value.depth === undefined ? 2 : Number(value.depth);
        if (!Number.isInteger(depth) || depth < 0 || depth > 8) throw new Error("depth must be an integer from 0 to 8");
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
            if (child.isDirectory() && currentDepth < depth) await walk(childPath, currentDepth + 1);
          }
        }
      },
    },
    createPatchTool(policy),
    createRunCommandTool(policy),
    createRunTestsTool(policy),
    {
      name: "search_text",
      description: "Search for a literal string in UTF-8 text files inside the workspace.",
      manifest: { capabilities: ["read"] },
      async execute(input) {
        const value = input as { query?: unknown; path?: unknown; maxResults?: unknown };
        if (typeof value?.query !== "string" || !value.query) throw new Error("query must be a non-empty string");
        const maxResults = value.maxResults === undefined ? 100 : Number(value.maxResults);
        if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > 1000) throw new Error("maxResults must be an integer from 1 to 1000");
        const root = policy.resolveDirectory(value.path ?? ".");
        const results: Array<{ path: string; line: number; text: string }> = [];
        /** 返回有上限的逐行匹配结果，避免把整个文件内容塞入上下文。 */
        await search(root);
        return results;

        async function search(directory: string): Promise<void> {
          const children = (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
          for (const child of children) {
            if (results.length >= maxResults) return;
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
              if (results.length < maxResults && text.includes(value.query as string)) {
                results.push({ path: policy.relative(file.path), line: index + 1, text });
              }
            });
          }
        }
      },
    },
  ];
}
