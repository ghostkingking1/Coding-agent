import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { z } from "zod";
import { ApprovalDeniedError, SecurityPolicy, WorkspacePolicy } from "./security.ts";
import { defineTool, ToolInputValidationError, validateToolInput } from "./tool-schema.ts";
import { ToolRegistry } from "./tool-registry.ts";
import { createWorkspaceTools } from "./workspace-tools.ts";

const sampleSchema = z.object({
  path: z.string().min(1),
  args: z.array(z.string()).max(2).optional(),
  depth: z.number().int().min(0).max(8).optional(),
  env: z.record(
    z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
    z.string(),
  ).optional(),
}).strict();

async function withWorkspace(run: (root: string) => Promise<void>): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "coding-agent-"));
  try {
    await run(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

test("tool schema accepts valid object input", () => {
  assert.doesNotThrow(() => validateToolInput(sampleSchema, {
    path: "src/app.ts",
    args: ["--watch"],
    depth: 2,
    env: { FOO: "bar" },
  }));
});

test("tool schema rejects malformed input with field paths", () => {
  assert.throws(() => validateToolInput(sampleSchema, "nope"), {
    name: "ToolInputValidationError",
  });
  assert.throws(() => validateToolInput(sampleSchema, {}), /input\.path/);
  assert.throws(() => validateToolInput(sampleSchema, { path: "" }), /input\.path/);
  assert.throws(() => validateToolInput(sampleSchema, { path: "x", extra: true }), /input\.extra is not allowed/);
  assert.throws(() => validateToolInput(sampleSchema, { path: "x", args: [1] }), /input\.args\[0\]/);
  assert.throws(() => validateToolInput(sampleSchema, { path: "x", depth: 9 }), /input\.depth/);
  assert.throws(() => validateToolInput(sampleSchema, { path: "x", env: { "BAD-KEY": "x" } }), /input\.env\.BAD-KEY/);
});

test("tool registry parses input before approval preview or execution", async () => {
  let previewed = false;
  let approved = false;
  let executed = false;
  let parsedPreviewInput: unknown;
  const registry = new ToolRegistry(new SecurityPolicy({
    approval: {
      requestApproval() {
        approved = true;
        return false;
      },
    },
  }));
  registry.register(defineTool({
    name: "write_file",
    description: "test write",
    capabilities: ["write"],
    inputSchema: z.object({ path: z.string().min(1), mode: z.literal("replace").default("replace") }).strict(),
    preview(input) {
      previewed = true;
      parsedPreviewInput = input;
      return {};
    },
    execute() {
      executed = true;
      return {};
    },
  }));

  await assert.rejects(
    () => registry.execute("write_file", { path: "" }, { messages: [] }),
    ToolInputValidationError,
  );
  assert.equal(previewed, false);
  assert.equal(approved, false);
  assert.equal(executed, false);

  await assert.rejects(
    () => registry.execute("write_file", { path: "x" }, { messages: [] }),
    ApprovalDeniedError,
  );
  assert.equal(previewed, true);
  assert.equal(approved, true);
  assert.equal(executed, false);
  assert.deepEqual(parsedPreviewInput, { path: "x", mode: "replace" });
});

test("workspace tools expose input schemas", async () => {
  await withWorkspace(async (root) => {
    const tools = createWorkspaceTools(new WorkspacePolicy({ root }));
    const names = ["read_file", "list_files", "search_text", "apply_patch", "run_command", "run_tests"];

    for (const name of names) {
      const tool = tools.find((candidate) => candidate.name === name);
      assert.ok(tool?.manifest?.inputSchema, `${name} should declare an input schema`);
    }
  });
});

test("read workspace tool schemas reject invalid inputs before path resolution", async () => {
  await withWorkspace(async (root) => {
    const registry = new ToolRegistry(new SecurityPolicy());
    for (const tool of createWorkspaceTools(new WorkspacePolicy({ root }))) registry.register(tool);

    await assert.rejects(
      () => registry.execute("read_file", { path: 1 }, { messages: [] }),
      ToolInputValidationError,
    );
    await assert.rejects(
      () => registry.execute("list_files", { depth: 9 }, { messages: [] }),
      ToolInputValidationError,
    );
    await assert.rejects(
      () => registry.execute("search_text", { query: "" }, { messages: [] }),
      ToolInputValidationError,
    );
  });
});

test("side-effect tool schemas reject invalid inputs before approval preview", async () => {
  await withWorkspace(async (root) => {
    let approvalRequests = 0;
    const registry = new ToolRegistry(new SecurityPolicy({
      approval: {
        requestApproval() {
          approvalRequests += 1;
          return true;
        },
      },
    }));
    for (const tool of createWorkspaceTools(new WorkspacePolicy({ root }))) registry.register(tool);

    await assert.rejects(
      () => registry.execute("apply_patch", { changes: [] }, { messages: [] }),
      ToolInputValidationError,
    );
    await assert.rejects(
      () => registry.execute("run_command", { command: "node", args: [1] }, { messages: [] }),
      ToolInputValidationError,
    );
    await assert.rejects(
      () => registry.execute("run_tests", { script: "" }, { messages: [] }),
      ToolInputValidationError,
    );
    assert.equal(approvalRequests, 0);
  });
});
