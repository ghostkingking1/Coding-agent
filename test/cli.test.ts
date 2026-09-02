import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CLI_MODEL_TOOL_NAMES, createCodingSystemPrompt, formatRunEvent, isInteractiveTerminal, registerCliTools, runInteractiveSession } from "../src/cli.ts";
import { Agent } from "../src/agent/agent.ts";
import { Session } from "../src/agent/session.ts";
import { Readable, Writable } from "node:stream";
import type { ModelClient, ModelResponse } from "../src/agent/types.ts";
import { ToolRegistry } from "../src/tools/tool-registry.ts";
import { WorkspacePolicy } from "../src/tools/security.ts";

test("CLI exposes run_tests but not run_command to the model", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "coding-agent-cli-"));
  try {
    const registry = new ToolRegistry();
    registerCliTools(registry, new WorkspacePolicy({ root }));

    assert.deepEqual(registry.list().map((tool) => tool.name), CLI_MODEL_TOOL_NAMES);
    assert.equal(registry.get("run_command"), undefined);
    assert.deepEqual(registry.listModelDefinitions().map((tool) => tool.name), CLI_MODEL_TOOL_NAMES);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("CLI system prompt states the workspace, tools, and test verification rule", () => {
  const prompt = createCodingSystemPrompt("D:/scratch");

  assert.match(prompt, /Workspace root: D:\/scratch/);
  assert.match(prompt, /read_file, list_files, search_text, apply_patch, run_tests/);
  assert.match(prompt, /must use run_tests to verify/);
  assert.match(prompt, /If tests fail, inspect the failure, repair the code, and run run_tests again/);
  assert.doesNotMatch(prompt, /run_command/);
});

test("CLI formats model and tool lifecycle events as terminal summaries", () => {
  assert.equal(formatRunEvent({ type: "model_started", step: 2 }), "[agent] step 2: model request started");
  assert.equal(formatRunEvent({ type: "tool_requested", step: 2, toolName: "run_tests", toolCallId: "call_1" }), "[agent] step 2: requested run_tests (call_1)");
  assert.equal(formatRunEvent({ type: "tool_completed", step: 2, toolName: "run_tests", toolCallId: "call_1" }), "[agent] step 2: completed run_tests (call_1)");
  assert.equal(formatRunEvent({ type: "tool_failed", step: 2, toolName: "run_tests", toolCallId: "call_1", error: "denied" }), "[agent] step 2: failed run_tests (call_1): denied");
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
    assert.match(outputChunks.join(""), /coding-agent> /);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("CLI rejects non-TTY interactive mode", () => {
  assert.equal(isInteractiveTerminal({ isTTY: undefined }, { isTTY: undefined }), false);
  assert.equal(isInteractiveTerminal({ isTTY: true }, { isTTY: undefined }), false);
});
