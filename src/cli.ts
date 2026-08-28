import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
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
} from "./index.ts";

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

async function main(): Promise<void> {
  const input = process.argv.slice(2).join(" ").trim();
  if (!input) {
    console.error("Usage: npm start -- <request>");
    process.exitCode = 1;
    return;
  }

  const config = readModelRuntimeConfig(process.env);
  if (!config) {
    const result = await new Agent(new EchoModel(), new ToolRegistry(), {
      systemPrompt: "You are a minimal coding agent.",
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
    for (const tool of createWorkspaceTools(workspace)) registry.register(tool);

    const result = await new Agent(model, registry, {
      systemPrompt: "You are a coding agent. Use tools only when needed and report verified results.",
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

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
