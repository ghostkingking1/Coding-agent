import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CLI_MODEL_TOOL_NAMES, createCodingSystemPrompt, formatRunDiffSummary, formatRunEvent, formatWorkMode, isInteractiveTerminal, registerCliTools, runInteractiveSession } from "../src/cli.ts";
import { Agent } from "../src/agent/agent.ts";
import { PlanStore, WorkModeController } from "../src/agent/work-modes.ts";
import { Session } from "../src/agent/session.ts";
import { Readable, Writable } from "node:stream";
import type { ModelClient, ModelRequest, ModelResponse } from "../src/agent/types.ts";
import { ToolRegistry } from "../src/tools/tool-registry.ts";
import { SecurityPolicy, WorkspacePolicy } from "../src/tools/security.ts";

test("CLI does not expose process tools without a sandbox helper", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "coding-agent-cli-"));
  try {
    const registry = new ToolRegistry();
    registerCliTools(registry, new WorkspacePolicy({ root }));

    const expected = CLI_MODEL_TOOL_NAMES.filter((name) => name !== "run_tests");
    assert.deepEqual(registry.list().map((tool) => tool.name), expected);
    assert.equal(registry.get("run_command"), undefined);
    assert.deepEqual(registry.listModelDefinitions().map((tool) => tool.name), expected);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("CLI system prompt states the workspace, tools, and test verification rule", () => {
  const prompt = createCodingSystemPrompt("D:/scratch");

  assert.match(prompt, /Workspace root: D:\/scratch/);
  assert.match(prompt, /read_file, list_files, apply_patch, run_tests, search_text/);
  assert.match(prompt, /must use run_tests to verify/);
  assert.match(prompt, /If tests fail, inspect the failure, repair the code, and run run_tests again/);
  assert.doesNotMatch(prompt, /run_command/);
});

test("CLI formats model and tool lifecycle events as terminal summaries", () => {
  assert.equal(formatRunEvent({ type: "model_started", step: 2 }), "[agent] step 2: model request started");
  assert.equal(formatRunEvent({ type: "tool_batch_started", step: 2, batchId: "run:2", toolCallCount: 2, parallelCount: 2 }), "[agent] step 2: tool batch run:2 started (2 calls, 2 parallel)");
  assert.equal(formatRunEvent({ type: "tool_requested", step: 2, toolName: "run_tests", toolCallId: "call_1" }), "[agent] step 2: requested run_tests (call_1)");
  assert.equal(formatRunEvent({ type: "tool_completed", step: 2, toolName: "run_tests", toolCallId: "call_1" }), "[agent] step 2: completed run_tests (call_1)");
  assert.equal(formatRunEvent({ type: "tool_failed", step: 2, toolName: "run_tests", toolCallId: "call_1", error: "denied" }), "[agent] step 2: failed run_tests (call_1): denied");
  assert.equal(formatRunEvent({ type: "tool_batch_finished", step: 2, batchId: "run:2", succeeded: 1, failed: 1 }), "[agent] step 2: tool batch run:2 finished (1 succeeded, 1 failed)");
});

test("interactive CLI runs one Agent per line and prints run and session diffs", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "coding-agent-repl-"));
  try {
    const model: ModelClient = { provider: "fake", model: "fake", capabilities: { toolCalling: false, streaming: false }, async generate(request): Promise<ModelResponse> {
      return { message: { role: "assistant", content: `answer:${request.messages.findLast((m) => m.role === "user")?.content}` } };
    } };
    const chunks: string[] = [];
    const output = new Writable({ write(chunk, _encoding, callback) { chunks.push(String(chunk)); callback(); } });
    await runInteractiveSession({ session: new Session(new Agent(model, undefined, { includeRunDiff: false })), root, input: Readable.from(["first\n", "second\n", "quit\n"]), output });
    const text = chunks.join("");
    assert.match(text, /answer:first/);
    assert.match(text, /answer:second/);
    assert.doesNotMatch(text, /Session changes:/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("interactive CLI omits the change section when nothing changed", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "coding-agent-repl-"));
  try {
    const model: ModelClient = { provider: "fake", model: "fake", capabilities: { toolCalling: false, streaming: false }, async generate(): Promise<ModelResponse> { return { message: { role: "assistant", content: "hello" } }; } };
    const chunks: string[] = [];
    const output = new Writable({ write(chunk, _encoding, callback) { chunks.push(String(chunk)); callback(); } });
    await runInteractiveSession({ session: new Session(new Agent(model)), root, input: Readable.from(["hello\n", "quit\n"]), output });

    assert.match(chunks.join(""), /hello/);
    assert.doesNotMatch(chunks.join(""), /Changes:/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("interactive CLI supports TTY prompt and exits on exit", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "coding-agent-repl-"));
  try {
    const model: ModelClient = { provider: "fake", model: "fake", capabilities: { toolCalling: false, streaming: false }, async generate(): Promise<ModelResponse> { return { message: { role: "assistant", content: "ok" } }; } };
    const input = Readable.from(["exit\n"]) as Readable & { isTTY?: boolean };
    const outputChunks: string[] = [];
    Object.defineProperty(input, "isTTY", { value: true });
    const output = new Writable({ write(chunk, _encoding, callback) { outputChunks.push(String(chunk)); callback(); } }) as Writable & { isTTY?: boolean };
    Object.defineProperty(output, "isTTY", { value: true });
    await runInteractiveSession({ session: new Session(new Agent(model, undefined, { includeRunDiff: false })), root, input, output });
    assert.match(outputChunks.join(""), /veil> /);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("CLI system prompt reports unavailable verification without a process tool", () => {
  const prompt = createCodingSystemPrompt("D:/scratch", undefined, [], ["read_file", "apply_patch"]);
  assert.doesNotMatch(prompt, /must use run_tests/);
  assert.match(prompt, /could not be executed or verified/);
});

test("interactive CLI handles fixed slash commands without invoking the model", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "coding-agent-repl-"));
  try {
    let calls = 0;
    const model: ModelClient = { provider: "fake", model: "fake", capabilities: { toolCalling: false, streaming: false }, async generate(): Promise<ModelResponse> { calls += 1; return { message: { role: "assistant", content: "unexpected" } }; } };
    const chunks: string[] = [];
    const output = new Writable({ write(chunk, _encoding, callback) { chunks.push(String(chunk)); callback(); } });
    await runInteractiveSession({ session: new Session(new Agent(model, undefined, { includeRunDiff: false })), root, input: Readable.from(["/help\n", "/status\n", "/clear\n", "/model\n", "/quit\n"]), output });
    const text = chunks.join("");
    assert.match(text, /\/help/);
    assert.match(text, /Status: active/);
    assert.match(text, /Conversation cleared/);
    assert.match(text, /Model: active session model/);
    assert.equal(calls, 0);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("CLI formats compact file change summaries without emitting the full diff", async () => {
  const summary = formatRunDiffSummary({
    sessionId: "session",
    runId: "run",
    files: [
      { path: "src/app.ts", diff: "--- a/src/app.ts\n+++ b/src/app.ts\n-old\n+new\n", addedLines: 1, removedLines: 1 },
      { path: "test/new.ts", diff: "+new\n", addedLines: 1, removedLines: 0 },
    ],
    text: "full diff should not be displayed",
    truncated: false,
    complete: true,
    omittedPaths: [],
    untrackedPaths: [],
  });
  assert.match(summary, /Changes: 2 file\(s\) changed, \+2 -1/);
  assert.match(summary, /M src\/app\.ts \+1 -1/);
  assert.match(summary, /A test\/new\.ts \+1 -0/);
  assert.doesNotMatch(summary, /full diff/);
});

test("CLI rejects non-TTY interactive mode", () => {
  assert.equal(isInteractiveTerminal({ isTTY: undefined }, { isTTY: undefined }), false);
  assert.equal(isInteractiveTerminal({ isTTY: true }, { isTTY: undefined }), false);
});


test("interactive CLI switches execution and full modes with an explicit normal reset", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "coding-agent-mode-"));
  try {
    const model: ModelClient = { provider: "fake", model: "fake", capabilities: { toolCalling: false, streaming: false }, async generate(): Promise<ModelResponse> { return { message: { role: "assistant", content: "unexpected" } }; } };
    const chunks: string[] = [];
    const output = new Writable({ write(chunk, _encoding, callback) { chunks.push(String(chunk)); callback(); } });
    await runInteractiveSession({ session: new Session(new Agent(model, undefined, { includeRunDiff: false })), root, input: Readable.from(["/mode plan\n", "/mode execute full\n", "/mode execute\n", "/mode execute normal\n", "/quit\n"]), output });
    const text = chunks.join("");
    assert.match(text, /Mode: plan; access: ask/);
    assert.match(text, /full access requires a TTY/);
    assert.match(text, /Mode: execute; access: ask/);
    assert.match(formatWorkMode({ executionMode: "execute", accessMode: "ask" }), /execute/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("mode execute runs the latest unfinished plan without another user request", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "coding-agent-plan-cli-"));
  const planStore = new PlanStore(root);
  try {
    planStore.setCurrentTask("task-cli");
    await planStore.writeScoped(`# 任务目标

修改代码。

# 执行计划

1. 检查代码。

# 完成标准

完成任务。

# 边界情况

不越界。

# 不应修改的内容

不修改其它文件。

# 测试与验证

检查结果。`, { capabilities: [], tools: [], paths: [], commands: [] }, "session-cli");
    const requests: ModelRequest[] = [];
    const model: ModelClient = {
      provider: "fake", model: "fake", capabilities: { toolCalling: false, streaming: false },
      async generate(request): Promise<ModelResponse> { requests.push(request); return { message: { role: "assistant", content: "done" } }; },
    };
    const chunks: string[] = [];
    const output = new Writable({ write(chunk, _encoding, callback) { chunks.push(String(chunk)); callback(); } });
    await runInteractiveSession({ session: new Session(new Agent(model, undefined, { includeRunDiff: false })), root, planStore, input: Readable.from(["/mode execute\n", "/quit\n"]), output });
    assert.equal(requests.length, 1);
    assert.match(requests[0]!.messages.at(-1)!.content, /Execute plan task-cli version 1/);
    assert.match(await fs.readFile(path.join(root, ".veil", "plans", "task-cli.md"), "utf8"), /status: completed/);
  } finally {
    planStore.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("denied tool execution preserves the selected plan in planned state", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "coding-agent-plan-denied-"));
  const planStore = new PlanStore(root);
  const workMode = new WorkModeController();
  try {
    planStore.setCurrentTask("task-denied");
    await planStore.writeScoped("# 任务目标\n\n测试拒绝。\n\n# 执行计划\n\n1. 请求写入。\n\n# 完成标准\n\n写入完成。\n\n# 边界情况\n\n审批拒绝。\n\n# 不应修改的内容\n\n其它文件。\n\n# 测试与验证\n\n检查状态。", { capabilities: [], tools: ["danger_write"], paths: [], commands: [] }, "session-cli");
    let step = 0;
    const model: ModelClient = {
      provider: "fake", model: "fake", capabilities: { toolCalling: true, streaming: false },
      async generate(): Promise<ModelResponse> {
        step += 1;
        return step === 1
          ? { message: { role: "assistant", content: "", toolCalls: [{ id: "write-1", name: "danger_write", input: {} }] }, finishReason: "tool_use" }
          : { message: { role: "assistant", content: "denied" } };
      },
    };
    const registry = new ToolRegistry(new SecurityPolicy({ workMode, workspaceRoot: root, approval: { requestApproval: () => "deny" } }));
    registry.register({ name: "danger_write", description: "write", manifest: { capabilities: ["write"] }, execute: () => "unexpected" });
    const output = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
    await runInteractiveSession({ session: new Session(new Agent(model, registry, { includeRunDiff: false })), root, planStore, workMode, input: Readable.from(["/mode execute\n", "/quit\n"]), output });
    assert.match(await fs.readFile(path.join(root, ".veil", "plans", "task-denied.md"), "utf8"), /status: planned/);
  } finally {
    planStore.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});
