import { createInterface } from "node:readline/promises";
import { resolve } from "node:path";
import { stdin, stdout } from "node:process";
import { pathToFileURL } from "node:url";
import {
  Agent,
  createConfiguredModelClient,
  createWorkspaceTools,
  DefaultApprovalPolicy,
  DefaultModelApprovalPolicy,
  readModelRuntimeConfig,
  SecurityPolicy,
  ToolRegistry,
  WorkspacePolicy,
  type ApprovalRequest,
  type ModelApprovalRequest,
  type ModelClient,
  type ModelRequest,
  type ModelResponse,
  type RunEvent,
} from "./index.ts";

/** CLI 只向模型开放可验证的测试入口，不把通用命令执行能力扩展到交互式 Agent。 */
export const CLI_MODEL_TOOL_NAMES = ["read_file", "list_files", "apply_patch", "run_tests", "search_text"] as const;

/** 让模型把修改和测试作为同一个完成条件，而不是在未验证时直接收尾。 */
export function createCodingSystemPrompt(workspaceRoot: string): string {
  return [
    "You are a coding agent working in the current workspace.",
    `Workspace root: ${workspaceRoot}`,
    "Available tools: read_file, list_files, search_text, apply_patch, run_tests.",
    "Inspect relevant files before editing. Use apply_patch only for changes inside the workspace.",
    "After modifying code, you must use run_tests to verify the change. If tests fail, inspect the failure, repair the code, and run run_tests again. Do not finish until the relevant tests pass.",
    "Report the verified result concisely.",
  ].join("\n");
}

/** 将已有 Agent 事件收敛为单行终端摘要，避免把工具结果重复打印到终端。 */
export function formatRunEvent(event: RunEvent): string {
  switch (event.type) {
    case "model_started":
      return `[agent] step ${event.step}: model request started`;
    case "tool_requested":
      return `[agent] step ${event.step}: requested ${event.toolName} (${event.toolCallId})`;
    case "tool_completed":
      return `[agent] step ${event.step}: completed ${event.toolName} (${event.toolCallId})`;
    case "tool_failed":
      return `[agent] step ${event.step}: failed ${event.toolName} (${event.toolCallId}): ${event.error}`;
    case "run_finished":
      return `[agent] finished after ${event.steps} step(s): ${event.stopReason}`;
    case "run_failed":
      return `[agent] run failed: ${event.error}`;
  }
}

/** 从工作区工具集中筛选 CLI 的最小工具面，通用 run_command 不会注册给模型。 */
export function registerCliTools(registry: ToolRegistry, workspace: WorkspacePolicy): void {
  for (const tool of createWorkspaceTools(workspace)) {
    if (tool.name !== "run_command") registry.register(tool);
  }
}

class EchoModel implements ModelClient {
  readonly provider = "echo";
  readonly model = "echo";
  readonly capabilities = { toolCalling: false, streaming: false } as const;

  async generate(request: ModelRequest): Promise<ModelResponse> {
    const prompt = request.messages.findLast((message) => message.role === "user")?.content ?? "";
    return {
      message: { role: "assistant", content: `Received: ${prompt}` },
      finishReason: "stop",
    };
  }
}

export async function main(): Promise<void> {
  const input = process.argv.slice(2).join(" ").trim();
  if (!input) {
    console.error("Usage: npm start -- <request>");
    process.exitCode = 1;
    return;
  }

  const config = readModelRuntimeConfig(process.env);
  if (!config) {
    const result = await new Agent(new EchoModel(), new ToolRegistry(), {
      systemPrompt: createCodingSystemPrompt(process.cwd()),
      onEvent: (event) => console.error(formatRunEvent(event)),
    }).run(input);
    console.log(result.finalText);
    return;
  }

  const prompt = createTerminalPrompt();
  try {
    const model = createConfiguredModelClient(config, {
      approval: new DefaultModelApprovalPolicy((request) => prompt.confirmModel(request)),
    });
    const workspace = new WorkspacePolicy({ root: process.cwd() });
    const registry = new ToolRegistry(new SecurityPolicy({
      approval: new DefaultApprovalPolicy((request) => prompt.confirmTool(request)),
    }));
    registerCliTools(registry, workspace);

    const result = await new Agent(model, registry, {
      systemPrompt: createCodingSystemPrompt(workspace.root),
      onEvent: (event) => console.error(formatRunEvent(event)),
    }).run(input);
    console.log(result.finalText);
  } finally {
    prompt.close();
  }
}

/** CLI 必须在交互式终端中获得明确输入；非交互运行默认拒绝所有副作用。 */
function createTerminalPrompt(): {
  confirmModel(request: ModelApprovalRequest): Promise<boolean>;
  confirmTool(request: ApprovalRequest): Promise<boolean>;
  close(): void;
} {
  if (!stdin.isTTY || !stdout.isTTY) {
    return {
      confirmModel: async () => false,
      confirmTool: async () => false,
      close: () => undefined,
    };
  }
  const readline = createInterface({ input: stdin, output: stdout });
  return {
    async confirmModel(request) {
      const tools = request.toolNames.length > 0 ? request.toolNames.join(", ") : "none";
      return confirm(readline, `Send ${request.messageCount} messages (${request.roles.join(", ")}) and tool context (${tools}) to ${request.provider}/${request.model} at ${request.endpointOrigin}?`);
    },
    async confirmTool(request) {
      const preview = request.preview === undefined ? "no preview" : truncate(JSON.stringify(request.preview));
      return confirm(readline, `Run ${request.toolName} with capabilities [${request.capabilities.join(", ")}]? Preview: ${preview}`);
    },
    close: () => readline.close(),
  };
}

async function confirm(readline: ReturnType<typeof createInterface>, prompt: string): Promise<boolean> {
  const answer = await readline.question(`${prompt} [y/N] `);
  return /^(y|yes)$/i.test(answer.trim());
}

function truncate(value: string, limit = 4000): string {
  return value.length > limit ? `${value.slice(0, limit)}...` : value;
}

if (isMainModule()) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && pathToFileURL(resolve(entry)).href === import.meta.url;
}
