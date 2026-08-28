import { z, ZodError } from "zod";
import type { JsonSchema, Tool, ToolCapability, ToolContext, ToolInputSchema } from "../agent/types.ts";

/** 工具输入不符合 schema 时抛出的错误。 */
export class ToolInputValidationError extends Error {
  /** 创建带有 schema 校验错误类型标识的异常。 */
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ToolInputValidationError";
  }
}

/** 创建工具时把 Zod schema、manifest 和强类型回调绑定在一起。 */
export interface ToolDefinition<TSchema extends ToolInputSchema> {
  readonly name: string;
  readonly description: string;
  readonly capabilities: readonly ToolCapability[];
  readonly inputSchema: TSchema;
  /** 发送给模型的 JSON Schema；本地执行仍必须经过 inputSchema 校验。 */
  readonly modelInputSchema?: JsonSchema;
  readonly preview?: (input: z.output<TSchema>, context: ToolContext) => Promise<unknown> | unknown;
  readonly execute: (input: z.output<TSchema>, context: ToolContext) => Promise<unknown> | unknown;
}

/** 声明一个带 Zod 输入类型的工具，避免每个工具重复拼 manifest 和 unknown 断言。 */
export function defineTool<TSchema extends ToolInputSchema>(definition: ToolDefinition<TSchema>): Tool<z.output<TSchema>> {
  return {
    name: definition.name,
    description: definition.description,
    manifest: {
      capabilities: definition.capabilities,
      inputSchema: definition.inputSchema,
      modelInputSchema: definition.modelInputSchema,
    },
    preview: definition.preview,
    execute: definition.execute,
  };
}

/** 在工具审批和执行前校验模型传入的结构化输入，并返回解析后的强类型值。 */
export function validateToolInput<TSchema extends ToolInputSchema>(schema: TSchema, input: unknown): z.output<TSchema> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    throw new ToolInputValidationError(formatZodError(parsed.error), { cause: parsed.error });
  }
  return parsed.data;
}

function formatZodError(error: ZodError): string {
  return error.issues
    .flatMap((issue) => {
      if (issue.code === "unrecognized_keys") {
        return issue.keys.map((key) => `${formatPath([...issue.path, key])} is not allowed`);
      }
      return `${formatPath(issue.path)} ${issue.message}`;
    })
    .join("; ");
}

function formatPath(path: readonly PropertyKey[]): string {
  if (path.length === 0) return "input";
  return path.reduce<string>((acc, part) => {
    if (typeof part === "number") return `${acc}[${part}]`;
    return `${acc}.${String(part)}`;
  }, "input");
}
