import { z } from "zod";
import { ToolOutputStore } from "../agent/tool-output-store.ts";
import { defineTool } from "./tool-schema.ts";
const schema = z.object({ artifactId: z.string().min(1), offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(100_000).default(8_000) }).strict();
/** 只允许模型分页读取 Agent 自己生成的临时工具输出，不暴露任意文件路径。 */
export function createToolOutputReadTool(store: ToolOutputStore) {
  return defineTool({ name: "read_tool_output", description: "Read a bounded page from a saved tool output artifact.", capabilities: ["read"], inputSchema: schema, modelInputSchema: { type: "object", properties: { artifactId: { type: "string" }, offset: { type: "integer", minimum: 0 }, limit: { type: "integer", minimum: 1, maximum: 100000 } }, required: ["artifactId"], additionalProperties: false }, async execute(input, context) { return store.read(context.sessionId, context.runId, input.artifactId, input.offset, input.limit); } });
}
