import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRunCommandTool, type RunCommandPreview, type RunCommandResult } from "./command-tools.ts";
import { ApprovalDeniedError, SecurityPolicy, WorkspacePolicy, WorkspaceSecurityError } from "./security.ts";
import { ToolRegistry } from "./tool-registry.ts";
import type { Tool, ToolContext } from "../agent/types.ts";

async function withWorkspace(run: (root: string) => Promise<void>): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "coding-agent-"));
  try {
    await run(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function executeTool(tool: Tool, input: unknown, context: ToolContext = { messages: [] }): Promise<unknown> {
  return new ToolRegistry().register(tool).execute(tool.name, input, context);
}

test("run_command executes an approved command inside the workspace cwd", async () => {
  await withWorkspace(async (root) => {
    await fs.mkdir(path.join(root, "src"));
    const tool = createRunCommandTool(new WorkspacePolicy({ root }));

    const result = await executeTool(tool, {
      command: process.execPath,
      args: ["-e", "console.log(process.cwd())"],
      cwd: "src",
    }, { messages: [] }) as RunCommandResult;

    assert.equal(result.exitCode, 0);
    assert.equal(result.cwd, "src");
    assert.equal(path.normalize(result.stdout.trim()), path.join(root, "src"));
    assert.equal(result.stderr, "");
    assert.equal(result.timedOut, false);
  });
});

test("run_command rejects cwd escape attempts", async () => {
  await withWorkspace(async (root) => {
    const tool = createRunCommandTool(new WorkspacePolicy({ root }));

    await assert.rejects(
      () => executeTool(tool, {
        command: process.execPath,
        args: ["-e", "console.log('nope')"],
        cwd: "..",
      }, { messages: [] }),
      WorkspaceSecurityError,
    );
  });
});

test("run_command requests approval before spawning", async () => {
  await withWorkspace(async (root) => {
    const marker = path.join(root, "marker.txt");
    const requests: RunCommandPreview[] = [];
    const registry = new ToolRegistry(new SecurityPolicy({
      approval: {
        requestApproval(request) {
          requests.push(request.preview as RunCommandPreview);
          return false;
        },
      },
    }));
    registry.register(createRunCommandTool(new WorkspacePolicy({ root })));

    await assert.rejects(
      () => registry.execute("run_command", {
        command: process.execPath,
        args: ["-e", `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran")`],
      }, { messages: [] }),
      ApprovalDeniedError,
    );

    assert.equal(requests.length, 1);
    assert.equal(requests[0]?.command, process.execPath);
    await assert.rejects(() => fs.stat(marker));
  });
});

test("run_command truncates stdout and stderr independently", async () => {
  await withWorkspace(async (root) => {
    const tool = createRunCommandTool(new WorkspacePolicy({ root }), {
      maxStdoutBytes: 5,
      maxStderrBytes: 7,
    });

    const result = await executeTool(tool, {
      command: process.execPath,
      args: ["-e", "process.stdout.write('abcdefghij'); process.stderr.write('klmnopqrst')"],
    }, { messages: [] }) as RunCommandResult;

    assert.equal(result.stdout, "abcde");
    assert.equal(result.stderr, "klmnopq");
    assert.equal(result.stdoutTruncated, true);
    assert.equal(result.stderrTruncated, true);
  });
});

test("run_command only exposes allowlisted environment variables", async () => {
  await withWorkspace(async (root) => {
    const tool = createRunCommandTool(new WorkspacePolicy({ root }), {
      allowedEnv: ["FOO"],
    });

    const result = await executeTool(tool, {
      command: process.execPath,
      args: ["-e", "console.log(`${process.env.FOO}:${process.env.BAR}`)"],
      env: {
        FOO: "allowed",
        BAR: "blocked",
      },
    }, { messages: [] }) as RunCommandResult;

    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout.trim(), "allowed:undefined");
    assert.deepEqual(result.envKeys, ["FOO"]);
  });
});

test("run_command invokes Windows cmd shims without corrupting paths", { skip: process.platform !== "win32" }, async () => {
  await withWorkspace(async (root) => {
    const shim = path.join(root, "echo-arg.cmd");
    await fs.writeFile(shim, "@echo off\r\necho %~1\r\n", "utf8");
    const tool = createRunCommandTool(new WorkspacePolicy({ root }));

    const result = await executeTool(tool, {
      command: ".\\echo-arg.cmd",
      args: ["hello"],
    }, { messages: [] }) as RunCommandResult;

    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout.trim(), "hello");
  });
});

test("run_command times out and terminates descendant processes", async () => {
  await withWorkspace(async (root) => {
    const marker = path.join(root, "child-survived.txt");
    const childCode = `setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(marker)}, "alive"), 700)`;
    const parentCode = [
      "const { spawn } = require('node:child_process')",
      `spawn(process.execPath, ["-e", ${JSON.stringify(childCode)}], { stdio: "ignore" })`,
      "setTimeout(() => {}, 5000)",
    ].join(";");
    const tool = createRunCommandTool(new WorkspacePolicy({ root }), {
      defaultTimeoutMs: 100,
      maxTimeoutMs: 1000,
    });

    const result = await executeTool(tool, {
      command: process.execPath,
      args: ["-e", parentCode],
    }, { messages: [] }) as RunCommandResult;

    assert.equal(result.timedOut, true);
    assert.notEqual(result.exitCode, 0);
    await new Promise((resolve) => setTimeout(resolve, 1200));
    await assert.rejects(() => fs.stat(marker));
  });
});

test("run_command aborts and terminates the running process tree", async () => {
  await withWorkspace(async (root) => {
    const controller = new AbortController();
    const tool = createRunCommandTool(new WorkspacePolicy({ root }));
    const execution = executeTool(tool, {
      command: process.execPath,
      args: ["-e", "setTimeout(() => {}, 5000)"],
    }, { messages: [], signal: controller.signal }) as Promise<RunCommandResult>;

    setTimeout(() => controller.abort(), 50);
    const result = await execution;

    assert.equal(result.aborted, true);
    assert.equal(result.timedOut, false);
    assert.notEqual(result.exitCode, 0);
  });
});
