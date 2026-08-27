import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ApprovalDeniedError, SecurityPolicy, WorkspacePolicy, WorkspaceSecurityError } from "./security.ts";
import { createRunTestsTool, type RunTestsPreview, type RunTestsResult } from "./test-tools.ts";
import { ToolRegistry } from "./tool-registry.ts";
import type { Tool, ToolContext } from "./types.ts";

async function withWorkspace(run: (root: string) => Promise<void>): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "coding-agent-"));
  try {
    await run(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function writePackage(root: string, scripts: Record<string, string>): Promise<void> {
  await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ type: "module", scripts }, null, 2), "utf8");
}

async function executeTool(tool: Tool, input: unknown, context: ToolContext = { messages: [] }): Promise<unknown> {
  return new ToolRegistry().register(tool).execute(tool.name, input, context);
}

test("run_tests executes the default npm test script", async () => {
  await withWorkspace(async (root) => {
    await writePackage(root, { test: "node ./pass.js" });
    await fs.writeFile(path.join(root, "pass.js"), "console.log('tests passed')\n", "utf8");
    const tool = createRunTestsTool(new WorkspacePolicy({ root }));

    const result = await executeTool(tool, {}, { messages: [] }) as RunTestsResult;

    assert.equal(result.runner, "npm");
    assert.equal(result.script, "test");
    assert.deepEqual(result.commandArgs, ["run", "test", "--"]);
    assert.equal(result.status, "passed");
    assert.equal(result.passed, true);
    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /tests passed/);
  });
});

test("run_tests returns structured failure output", async () => {
  await withWorkspace(async (root) => {
    await writePackage(root, { test: "node ./fail.js" });
    await fs.writeFile(
      path.join(root, "fail.js"),
      "process.stdout.write('bad out'); process.stderr.write('bad err'); process.exit(7)\n",
      "utf8",
    );
    const tool = createRunTestsTool(new WorkspacePolicy({ root }));

    const result = await executeTool(tool, {}, { messages: [] }) as RunTestsResult;

    assert.equal(result.status, "failed");
    assert.equal(result.passed, false);
    assert.equal(result.exitCode, 7);
    assert.match(result.stdout, /bad out/);
    assert.match(result.stderr, /bad err/);
  });
});

test("run_tests rejects cwd escape attempts", async () => {
  await withWorkspace(async (root) => {
    const tool = createRunTestsTool(new WorkspacePolicy({ root }));

    await assert.rejects(
      () => executeTool(tool, { cwd: ".." }, { messages: [] }),
      WorkspaceSecurityError,
    );
  });
});

test("run_tests requests approval before starting npm", async () => {
  await withWorkspace(async (root) => {
    const marker = path.join(root, "marker.txt");
    await writePackage(root, {
      test: `node -e "require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')"`,
    });
    const requests: RunTestsPreview[] = [];
    const registry = new ToolRegistry(new SecurityPolicy({
      approval: {
        requestApproval(request) {
          requests.push(request.preview as RunTestsPreview);
          return false;
        },
      },
    }));
    registry.register(createRunTestsTool(new WorkspacePolicy({ root })));

    await assert.rejects(
      () => registry.execute("run_tests", {}, { messages: [] }),
      ApprovalDeniedError,
    );

    assert.equal(requests.length, 1);
    assert.equal(requests[0]?.runner, "npm");
    assert.equal(requests[0]?.script, "test");
    assert.deepEqual(requests[0]?.commandArgs, ["run", "test", "--"]);
    await assert.rejects(() => fs.stat(marker));
  });
});

test("run_tests maps timeouts to timed_out status", async () => {
  await withWorkspace(async (root) => {
    await writePackage(root, { test: "node ./sleep.js" });
    await fs.writeFile(path.join(root, "sleep.js"), "setTimeout(() => {}, 5000)\n", "utf8");
    const tool = createRunTestsTool(new WorkspacePolicy({ root }), {
      defaultTimeoutMs: 50,
      maxTimeoutMs: 1000,
    });

    const result = await executeTool(tool, {}, { messages: [] }) as RunTestsResult;

    assert.equal(result.status, "timed_out");
    assert.equal(result.passed, false);
    assert.equal(result.timedOut, true);
  });
});

test("run_tests only exposes allowlisted environment variables", async () => {
  await withWorkspace(async (root) => {
    await writePackage(root, { test: "node ./env.js" });
    await fs.writeFile(path.join(root, "env.js"), "console.log(`${process.env.FOO}:${process.env.BAR}`)\n", "utf8");
    const tool = createRunTestsTool(new WorkspacePolicy({ root }), {
      allowedEnv: ["PATH", "Path", "PATHEXT", "SystemRoot", "ComSpec", "FOO"],
    });

    const result = await executeTool(tool, {
      env: {
        FOO: "allowed",
        BAR: "blocked",
      },
    }, { messages: [] }) as RunTestsResult;

    assert.equal(result.status, "passed");
    assert.match(result.stdout, /allowed:undefined/);
    assert.ok(result.envKeys.includes("FOO"));
    assert.equal(result.envKeys.includes("BAR"), false);
  });
});
