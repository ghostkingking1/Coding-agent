import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { z } from "zod";
import { Agent } from "../../src/agent/agent.ts";
import type { ModelClient, ModelRequest, ModelResponse } from "../../src/agent/types.ts";
import { defineTool } from "../../src/tools/tool-schema.ts";
import { ToolRegistry } from "../../src/tools/tool-registry.ts";
import { runBenchmark } from "../../src/benchmark/runner.ts";
import type { BenchmarkRuntime, BenchmarkTask, BenchmarkVerifier } from "../../src/benchmark/types.ts";

const capabilities = ["network.off", "os.isolation", "resource.limits", "process-tree"] as const;

async function setup() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "veil-benchmark-test-"));
  const datasetRoot = path.join(root, "dataset");
  const fixture = path.join(datasetRoot, "toy-task", "fixture");
  const verification = path.join(datasetRoot, "toy-task", "verification");
  await fs.mkdir(fixture, { recursive: true }); await fs.mkdir(verification, { recursive: true });
  await fs.writeFile(path.join(fixture, "allowed.mjs"), "export const answer = 41;\n");
  await fs.writeFile(path.join(verification, "private.txt"), "must remain outside the workspace\n");
  const fixtureDigest = `sha256:${crypto.createHash("sha256").update("allowed.mjs").update("\0").update("export const answer = 41;\n").digest("hex")}`;
  const task: BenchmarkTask = {
    id: "toy-task", title: "toy", prompt: "update answer", fixture: "toy-task/fixture", verification: "toy-task/verification", baseCommit: "fixture-tree-v1:toy", fixtureDigest,
    environment: { node: ">=22" }, limits: { maxDurationMs: 500, maxSteps: 3 }, diffRules: { allowedPaths: ["allowed.mjs"], forbiddenPaths: ["verification/**"] },
  };
  await fs.writeFile(path.join(datasetRoot, "toy-task", "task.json"), JSON.stringify(task));
  const sandbox = { capabilities: { backend: "test", version: "1", capabilities }, assertAvailable(required: readonly string[]) { for (const value of required) if (!capabilities.includes(value as typeof capabilities[number])) throw new Error(value); }, spawn() { throw new Error("not used"); } };
  return { root, datasetRoot, outputRoot: path.join(root, "output"), fixture, task, sandbox };
}

class EditingModel implements ModelClient {
  readonly provider = "mock";
  readonly model = "editing";
  readonly capabilities = { toolCalling: true, streaming: false };
  calls = 0;
  private readonly content: string;
  private readonly delay: boolean;
  constructor(content = "export const answer = 42;\n", delay = false) { this.content = content; this.delay = delay; }
  async generate(request: ModelRequest): Promise<ModelResponse> {
    this.calls++;
    if (this.delay) await new Promise<void>((resolve) => request.signal?.addEventListener("abort", () => resolve(), { once: true }));
    if (this.calls === 1) return { message: { role: "assistant", content: "", toolCalls: [{ id: "edit-1", name: "edit_file", input: { content: this.content } }] }, usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 } };
    return { message: { role: "assistant", content: "Done." }, usage: { inputTokens: 4, outputTokens: 1, totalTokens: 5 } };
  }
}

function runtimeFor(context: { mode?: "security"; delay?: boolean; content?: string } = {}) {
  const model = new EditingModel(context.content, context.delay);
  const runtime: BenchmarkRuntime = {
    modelId: "mock/editing", sandbox: undefined as never,
    createAgent(run) {
      const registry = new ToolRegistry({ authorize: async () => undefined });
      registry.register(defineTool({
        name: "edit_file", description: "write fixture file", capabilities: ["write"],
        inputSchema: z.object({ content: z.string() }), modelInputSchema: { type: "object", properties: { content: { type: "string" } }, required: ["content"] },
        execute: async ({ content }, toolContext) => {
          if (context.mode === "security") return "WorkspaceSecurityError: outside workspace rejected";
          const relativePath = context.content === "bad" ? "forbidden.mjs" : "allowed.mjs";
          const absolutePath = path.join(run.workspaceRoot, relativePath);
          toolContext.changeTracker?.recordBeforeWrite(absolutePath, relativePath, "");
          await fs.writeFile(absolutePath, content);
          return "updated";
        },
      }));
      return new Agent(model, registry, { maxSteps: run.task.limits.maxSteps, signal: run.signal, onEvent: run.onEvent });
    },
  };
  return runtime;
}

function passingVerifier(): BenchmarkVerifier { return { run: async () => [{ name: "acceptance", passed: true }] }; }

test("benchmark success is externally verified, usage is aggregated, and successful workspaces are removed", async () => {
  const value = await setup();
  try {
    const summary = await runBenchmark({ datasetRoot: value.datasetRoot, outputRoot: value.outputRoot, runtime: { ...runtimeFor(), sandbox: value.sandbox }, verifier: passingVerifier() });
    assert.equal(summary.successCount, 1);
    assert.equal(summary.usage?.totalTokens, 10);
    assert.equal(summary.tasks[0].toolCalls, 1);
    assert.ok(summary.tasks[0].trajectory.some((event) => event.type === "tool_call" && event.input.includes("42")));
    assert.ok(summary.tasks[0].trajectory.some((event) => event.type === "tool_result" && event.result === "updated"));
    assert.equal(summary.tasks[0].workspacePath, undefined);
    assert.equal(await fs.readFile(path.join(value.fixture, "allowed.mjs"), "utf8"), "export const answer = 41;\n");
    assert.equal(await fs.readFile(path.join(summary.outputDirectory, "report.md"), "utf8").then((text) => text.includes("100.0%")), true);
  } finally { await fs.rm(value.root, { recursive: true, force: true }); }
});

test("agent completion cannot override failed external checks, and the failed workspace is retained", async () => {
  const value = await setup();
  try {
    const summary = await runBenchmark({ datasetRoot: value.datasetRoot, outputRoot: value.outputRoot, runtime: { ...runtimeFor(), sandbox: value.sandbox }, verifier: { run: async () => [{ name: "acceptance", passed: false }] } });
    assert.equal(summary.tasks[0].success, false);
    assert.equal(summary.tasks[0].status, "failed");
    assert.ok(summary.tasks[0].workspacePath);
    assert.equal(await fs.readFile(path.join(summary.outputDirectory, summary.tasks[0].workspacePath!, "allowed.mjs"), "utf8"), "export const answer = 42;\n");
    assert.equal(await fs.readFile(path.join(value.fixture, "allowed.mjs"), "utf8"), "export const answer = 41;\n");
  } finally { await fs.rm(value.root, { recursive: true, force: true }); }
});

test("diff rules and denied security attempts fail an otherwise passing task", async () => {
  for (const runtime of [runtimeFor({ content: "bad" }), runtimeFor({ mode: "security" })]) {
    const value = await setup();
    try {
      const summary = await runBenchmark({ datasetRoot: value.datasetRoot, outputRoot: value.outputRoot, runtime: { ...runtime, sandbox: value.sandbox }, verifier: passingVerifier() });
      assert.equal(summary.tasks[0].success, false, JSON.stringify({ checks: summary.tasks[0].verification, security: summary.tasks[0].securityEvents }));
    } finally { await fs.rm(value.root, { recursive: true, force: true }); }
  }
});

test("task timeout aborts the agent and preserves its workspace", async () => {
  const value = await setup();
  try {
    const summary = await runBenchmark({ datasetRoot: value.datasetRoot, outputRoot: value.outputRoot, runtime: { ...runtimeFor({ delay: true }), sandbox: value.sandbox }, verifier: passingVerifier() });
    assert.equal(summary.tasks[0].status, "timed_out");
    assert.ok(summary.tasks[0].workspacePath);
  } finally { await fs.rm(value.root, { recursive: true, force: true }); }
});
