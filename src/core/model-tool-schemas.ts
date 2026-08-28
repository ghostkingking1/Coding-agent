import type { JsonSchema } from "./types.ts";

const workspacePathSchema: JsonSchema = {
  type: "string",
  minLength: 1,
  description: "A non-empty path relative to the workspace root.",
};

const singleLineTextSchema: JsonSchema = {
  type: "string",
  minLength: 1,
  description: "A non-empty single-line string.",
};

const commandArgumentSchema: JsonSchema = {
  type: "string",
  description: "One literal command argument. It is passed without shell parsing.",
};

const environmentSchema: JsonSchema = {
  type: "object",
  propertyNames: { pattern: "^[A-Za-z_][A-Za-z0-9_]*$" },
  additionalProperties: { type: "string" },
  description: "Environment variable overrides. Values are only used when their keys are allowlisted locally.",
};

/** read_file 的模型参数 schema。 */
export const readFileModelInputSchema: JsonSchema = {
  type: "object",
  properties: { path: workspacePathSchema },
  required: ["path"],
  additionalProperties: false,
};

/** list_files 的模型参数 schema。 */
export const listFilesModelInputSchema: JsonSchema = {
  type: "object",
  properties: {
    path: { ...workspacePathSchema, default: "." },
    depth: { type: "integer", minimum: 0, maximum: 8, default: 2 },
  },
  additionalProperties: false,
};

/** search_text 的模型参数 schema。 */
export const searchTextModelInputSchema: JsonSchema = {
  type: "object",
  properties: {
    query: {
      type: "string",
      minLength: 1,
      description: "The literal text to search for.",
    },
    path: { ...workspacePathSchema, default: "." },
    maxResults: { type: "integer", minimum: 1, maximum: 1000, default: 100 },
  },
  required: ["query"],
  additionalProperties: false,
};

/** apply_patch 的模型参数 schema。 */
export const applyPatchModelInputSchema: JsonSchema = {
  type: "object",
  properties: {
    changes: {
      type: "array",
      minItems: 1,
      maxItems: 50,
      items: {
        type: "object",
        properties: {
          path: workspacePathSchema,
          find: { type: "string", minLength: 1 },
          replaceWith: { type: "string" },
        },
        required: ["path", "find", "replaceWith"],
        additionalProperties: false,
      },
    },
  },
  required: ["changes"],
  additionalProperties: false,
};

/** 创建 run_command 的模型参数 schema，超时上限必须随实际工具配置同步。 */
export function createRunCommandModelInputSchema(maxTimeoutMs: number): JsonSchema {
  return {
    type: "object",
    properties: {
      command: singleLineTextSchema,
      args: { type: "array", items: commandArgumentSchema, default: [] },
      cwd: { ...workspacePathSchema, default: "." },
      timeoutMs: { type: "integer", minimum: 1, maximum: maxTimeoutMs },
      env: { ...environmentSchema, default: {} },
    },
    required: ["command"],
    additionalProperties: false,
  };
}

/** 创建 run_tests 的模型参数 schema；默认 script 只描述模型输入，仍由本地 Zod 注入。 */
export function createRunTestsModelInputSchema(defaultScript: string, maxTimeoutMs: number): JsonSchema {
  return {
    type: "object",
    properties: {
      script: { ...singleLineTextSchema, default: defaultScript },
      args: { type: "array", items: commandArgumentSchema, default: [] },
      cwd: { ...workspacePathSchema, default: "." },
      timeoutMs: { type: "integer", minimum: 1, maximum: maxTimeoutMs },
      env: { ...environmentSchema, default: {} },
    },
    additionalProperties: false,
  };
}
