import type { ToolInputSchema } from "./types.ts";

/** 工具输入不符合 schema 时抛出的错误。 */
export class ToolInputValidationError extends Error {
  /** 创建带有 schema 校验错误类型标识的异常。 */
  constructor(message: string) {
    super(message);
    this.name = "ToolInputValidationError";
  }
}

/** 在工具审批和执行前校验模型传入的结构化输入。 */
export function validateToolInput(schema: ToolInputSchema, input: unknown): void {
  validate(schema, input, "input");
}

function validate(schema: ToolInputSchema, value: unknown, path: string): void {
  switch (schema.type) {
    case "boolean":
      validateBoolean(value, path);
      return;
    case "integer":
      validateInteger(schema, value, path);
      return;
    case "string":
      validateString(schema, value, path);
      return;
    case "array":
      validateArray(schema, value, path);
      return;
    case "object":
      validateObject(schema, value, path);
      return;
    case "record":
      validateRecord(schema, value, path);
      return;
  }
}

function validateBoolean(value: unknown, path: string): void {
  if (typeof value !== "boolean") throw new ToolInputValidationError(`${path} must be a boolean`);
}

function validateInteger(schema: Extract<ToolInputSchema, { type: "integer" }>, value: unknown, path: string): void {
  if (!Number.isInteger(value)) throw new ToolInputValidationError(`${path} must be an integer`);
  const integerValue = value as number;
  if (schema.minimum !== undefined && integerValue < schema.minimum) {
    throw new ToolInputValidationError(`${path} must be greater than or equal to ${schema.minimum}`);
  }
  if (schema.maximum !== undefined && integerValue > schema.maximum) {
    throw new ToolInputValidationError(`${path} must be less than or equal to ${schema.maximum}`);
  }
}

function validateString(schema: Extract<ToolInputSchema, { type: "string" }>, value: unknown, path: string): void {
  if (typeof value !== "string") throw new ToolInputValidationError(`${path} must be a string`);
  if (schema.minLength !== undefined && value.length < schema.minLength) {
    throw new ToolInputValidationError(`${path} must be at least ${schema.minLength} characters`);
  }
  if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(value)) {
    throw new ToolInputValidationError(`${path} must match pattern ${schema.pattern}`);
  }
}

function validateArray(schema: Extract<ToolInputSchema, { type: "array" }>, value: unknown, path: string): void {
  if (!Array.isArray(value)) throw new ToolInputValidationError(`${path} must be an array`);
  if (schema.minItems !== undefined && value.length < schema.minItems) {
    throw new ToolInputValidationError(`${path} must contain at least ${schema.minItems} items`);
  }
  if (schema.maxItems !== undefined && value.length > schema.maxItems) {
    throw new ToolInputValidationError(`${path} must contain at most ${schema.maxItems} items`);
  }
  value.forEach((item, index) => validate(schema.items, item, `${path}[${index}]`));
}

function validateObject(schema: Extract<ToolInputSchema, { type: "object" }>, value: unknown, path: string): void {
  if (!isPlainRecord(value)) throw new ToolInputValidationError(`${path} must be an object`);
  const required = schema.required ?? [];
  for (const key of required) {
    if (!Object.hasOwn(value, key) || value[key] === undefined) {
      throw new ToolInputValidationError(`${path}.${key} is required`);
    }
  }
  if (schema.additionalProperties === false) {
    const knownKeys = new Set(Object.keys(schema.properties));
    for (const key of Object.keys(value)) {
      if (!knownKeys.has(key)) throw new ToolInputValidationError(`${path}.${key} is not allowed`);
    }
  }
  for (const [key, propertySchema] of Object.entries(schema.properties)) {
    if (Object.hasOwn(value, key)) validate(propertySchema, value[key], `${path}.${key}`);
  }
}

function validateRecord(schema: Extract<ToolInputSchema, { type: "record" }>, value: unknown, path: string): void {
  if (!isPlainRecord(value)) throw new ToolInputValidationError(`${path} must be an object`);
  const keyPattern = schema.keyPattern ? new RegExp(schema.keyPattern) : undefined;
  for (const [key, item] of Object.entries(value)) {
    if (keyPattern && !keyPattern.test(key)) {
      throw new ToolInputValidationError(`${path}.${key} must match pattern ${schema.keyPattern}`);
    }
    validate(schema.values, item, `${path}.${key}`);
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
