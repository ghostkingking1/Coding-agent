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
  type RunDiff,
} from "./index.ts";
import { cleanupStaleBaselineDirectories, RunChangeTracker } from "./agent/run-diff.ts";
import { Session } from "./agent/session.ts";
import type { Readable, Writable } from "node:stream";

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
  await cleanupStaleBaselineDirectories();
  const input = process.argv.slice(2).join(" ").trim();
  if (!input) {
    if (!isInteractiveTerminal(stdin, stdout)) {
      console.error("Interactive mode requires a TTY. Usage: npm start -- <request>");
      process.exitCode = 1;
      return;
    }
    await runConfiguredInteractiveSession();
    return;
  }

  const config = readModelRuntimeConfig(process.env);
  const workspace = new WorkspacePolicy({ root: process.cwd() });
  if (!config) {
    const result = await new Agent(new EchoModel(), new ToolRegistry(), {
      systemPrompt: createCodingSystemPrompt(process.cwd()),
      onEvent: (event) => console.error(formatRunEvent(event)),
      changeTracker: new RunChangeTracker({ root: workspace.root }),
    }).run(input);
    console.log(result.finalText);
    printRunDiff(result.diff);
    return;
  }

  const prompt = createTerminalPrompt();
  try {
    const model = createConfiguredModelClient(config, {
      approval: new DefaultModelApprovalPolicy((request) => prompt.confirmModel(request)),
    });
    const registry = new ToolRegistry(new SecurityPolicy({
      approval: new DefaultApprovalPolicy((request) => prompt.confirmTool(request)),
    }));
    registerCliTools(registry, workspace);

    const result = await new Agent(model, registry, {
      systemPrompt: createCodingSystemPrompt(workspace.root),
      onEvent: (event) => console.error(formatRunEvent(event)),
      changeTracker: new RunChangeTracker({ root: workspace.root }),
    }).run(input);
    console.log(result.finalText);
    printRunDiff(result.diff);
  } finally {
    prompt.close();
  }
}

/** 无参数时启动持续对话；每行输入独立运行一次 Agent，并保留 Session 上下文。 */
export async function runInteractiveSession(options: { readonly session: Session; readonly root: string; readonly input?: Readable; readonly output?: Writable; readonly errorOutput?: Writable }): Promise<void> {
  const input = options.input ?? stdin;
  const output = options.output ?? stdout;
  const errorOutput = options.errorOutput ?? process.stderr;
  const sessionTracker = new RunChangeTracker({ root: options.root, sessionId: options.session.sessionId });
  await sessionTracker.start();
  const readline = createInterface({ input, output, terminal: Boolean((input as NodeJS.ReadStream).isTTY && (output as NodeJS.WriteStream).isTTY) });
  try {
    if (readline.terminal) output.write("coding-agent> ");
    for await (const raw of readline) {
      const line = raw.trim();
      if (!line) { if (readline.terminal) output.write("coding-agent> "); continue; }
      if (line === "exit" || line === "quit") break;
      try {
        const result = await options.session.run(line, { changeTracker: new RunChangeTracker({ root: options.root, sessionId: options.session.sessionId }) });
        output.write(`${result.finalText}\n`);
        printRunDiff(result.diff, output, errorOutput);
      } catch (error) { errorOutput.write(`[agent] run failed: ${error instanceof Error ? error.message : String(error)}\n`); }
      if (readline.terminal) output.write("coding-agent> ");
    }
  } finally {
    readline.close();
    options.session.close();
    const diff = await sessionTracker.finish();
    if (diff.text) output.write(`\nSession changes:\n${diff.text}\n`);
    if (!diff.complete) errorOutput.write(`[agent] warning: session snapshot incomplete; omitted paths: ${diff.omittedPaths.join(", ") || "unknown"}\n`);
  }
}

/** 只有输入输出同时连接终端时才允许无参数进入 REPL，避免管道进程永久等待。 */
export function isInteractiveTerminal(input: { readonly isTTY?: boolean }, output: { readonly isTTY?: boolean }): boolean {
  return input.isTTY === true && output.isTTY === true;
}

async function runConfiguredInteractiveSession(): Promise<void> {
  const config = readModelRuntimeConfig(process.env);
  const workspace = new WorkspacePolicy({ root: process.cwd() });
  if (!config) {
    await runInteractiveSession({ session: new Session(new Agent(new EchoModel(), new ToolRegistry(), { systemPrompt: createCodingSystemPrompt(workspace.root), onEvent: (event) => console.error(formatRunEvent(event)) })), root: workspace.root });
    return;
  }
  const prompt = createTerminalPrompt();
  try {
    const model = createConfiguredModelClient(config, { approval: new DefaultModelApprovalPolicy((request) => prompt.confirmModel(request)) });
    const registry = new ToolRegistry(new SecurityPolicy({ approval: new DefaultApprovalPolicy((request) => prompt.confirmTool(request)) }));
    registerCliTools(registry, workspace);
    await runInteractiveSession({ session: new Session(new Agent(model, registry, { systemPrompt: createCodingSystemPrompt(workspace.root), onEvent: (event) => console.error(formatRunEvent(event)) })), root: workspace.root });
  } finally { prompt.close(); }
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

function printRunDiff(diff: RunDiff | undefined, output: Writable = stdout, errorOutput: Writable = process.stderr): void {
  if (!diff) return;
  output.write(`\nChanges:\n${diff.text || "(none)"}\n`);
  if (!diff.complete) errorOutput.write(`[agent] warning: change snapshot incomplete; omitted paths: ${diff.omittedPaths.join(", ") || "unknown"}\n`);
  if (diff.untrackedPaths.length > 0) errorOutput.write(`[agent] warning: changes could not be diffed: ${diff.untrackedPaths.join(", ")}\n`);
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
