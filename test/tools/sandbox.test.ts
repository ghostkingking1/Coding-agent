import assert from "node:assert/strict";
import test from "node:test";
import { executionRequestDigest, ProcessSandboxBackend, RustHelperSandboxBackend, SandboxUnavailableError, UnavailableSandboxBackend } from "../../src/tools/sandbox.ts";
import { createRunCommandTool } from "../../src/tools/command-tools.ts";
import { WorkspacePolicy } from "../../src/tools/security.ts";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import fsSync from "node:fs";

test("execution request digest is stable across environment insertion order", () => {
  const base = { workspaceRoot: "C:/workspace", executable: "node", args: ["-e", "1"], cwd: "C:/workspace", timeoutMs: 1000, maxStdoutBytes: 10, maxStderrBytes: 10, network: "off" as const };
  assert.equal(executionRequestDigest({ ...base, env: { B: "2", A: "1" } }), executionRequestDigest({ ...base, env: { A: "1", B: "2" } }));
});

test("unavailable sandbox fails closed before spawning", () => {
  const backend = new UnavailableSandboxBackend();
  assert.throws(() => backend.assertAvailable(["process.spawn"]), SandboxUnavailableError);
});

test("process backend does not claim OS isolation", () => {
  const backend = new ProcessSandboxBackend();
  assert.equal(backend.capabilities.capabilities.includes("os.isolation"), false);
  assert.throws(() => backend.assertAvailable(["os.isolation"]), SandboxUnavailableError);
});

test("run_command fails closed before approval when OS isolation is required", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "coding-agent-sandbox-"));
  try {
    const tool = createRunCommandTool(new WorkspacePolicy({ root }), { requireOsIsolation: true });
    assert.throws(
      () => tool.preview?.({ command: process.execPath, args: ["-e", "console.log('no')"], cwd: ".", env: {} }, { messages: [] }),
      SandboxUnavailableError,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("Rust helper handshake exposes only capabilities it can prove", { skip: process.platform !== "win32" }, () => {
  const helper = path.resolve("sandbox-helper", "target", "release", "coding-agent-sandbox-helper.exe");
  if (!fsSync.existsSync(helper)) return;
  const backend = new RustHelperSandboxBackend({ helperPath: helper });
  assert.equal(backend.capabilities.backend, "rust-helper");
  assert.equal(backend.capabilities.capabilities.includes("os.isolation"), true);
});

test("Windows Rust helper executes an approved workspace command with OS isolation", { skip: process.platform !== "win32" }, async () => {
  const helper = path.resolve("sandbox-helper", "target", "release", "coding-agent-sandbox-helper.exe");
  if (!fsSync.existsSync(helper)) return;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "coding-agent-windows-sandbox-"));
  try {
    const sandbox = new RustHelperSandboxBackend({ helperPath: helper });
    sandbox.assertAvailable(["process.spawn", "workspace.fs", "network.off", "os.isolation"]);
    const tool = createRunCommandTool(new WorkspacePolicy({ root }), { sandbox, requireOsIsolation: true });
    const marker = path.join(root, "sandbox-ok.txt");
    const result = await tool.execute({
      command: process.execPath,
      args: ["-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'sandbox-ok')`],
      cwd: ".",
      env: {},
    }, { messages: [] }) as { readonly exitCode: number | null; readonly stdout: string; readonly stderr: string };
    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(await fs.readFile(marker, "utf8"), "sandbox-ok");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
