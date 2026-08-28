import type { ModelToolDefinition, Tool, ToolContext, ToolExecutionPolicy } from "../agent/types.ts";
import { validateToolInput } from "./tool-schema.ts";

/** 注册工具并在执行前统一应用授权策略。 */
export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();
  private readonly policy?: ToolExecutionPolicy;

  /** 创建一个可选授权策略的工具注册表。 */
  constructor(policy?: ToolExecutionPolicy) {
    this.policy = policy;
  }

  /** 注册工具；名称为空或重复时拒绝注册。 */
  register(tool: Tool): this {
    if (!tool.name.trim()) {
      throw new Error("Tool name must not be empty");
    }
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool already registered: ${tool.name}`);
    }
    this.tools.set(tool.name, tool);
    return this;
  }

  /** 按名称查找工具。 */
  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  /** 返回当前注册的工具快照。 */
  list(): readonly Tool[] {
    return [...this.tools.values()];
  }

  /** 返回显式声明 JSON Schema 的工具，避免把本地实现细节或未知参数暴露给模型。 */
  listModelDefinitions(): readonly ModelToolDefinition[] {
    return this.list().flatMap((tool) => {
      const inputSchema = tool.manifest?.modelInputSchema;
      if (!inputSchema) return [];
      return [{
        name: tool.name,
        description: tool.description,
        inputSchema,
      }];
    });
  }

  /** 先授权，再执行指定工具，确保副作用不会绕过策略。 */
  async execute(name: string, input: unknown, context: ToolContext): Promise<unknown> {
    const tool = this.get(name);
    if (!tool) {
      throw new Error(`Unknown tool: ${name}`);
    }
    /** 输入解析必须早于审批和执行，避免非法参数触发预览、副作用或路径解析。 */
    const parsedInput = tool.manifest?.inputSchema ? validateToolInput(tool.manifest.inputSchema, input) : input;
    await this.policy?.authorize(tool, parsedInput, context);
    return tool.execute(parsedInput, context);
  }
}
