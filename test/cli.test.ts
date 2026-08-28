import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CLI_MODEL_TOOL_NAMES, createCodingSystemPrompt, formatRunEvent, registerCliTools } from "../src/cli.ts";
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
