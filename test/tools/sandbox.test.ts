import assert from "node:assert/strict";
import test from "node:test";
import { executionRequestDigest, ProcessSandboxBackend, RustHelperSandboxBackend, SandboxUnavailableError, UnavailableSandboxBackend } from "../../src/tools/sandbox.ts";
import { createRunCommandTool } from "../../src/tools/command-tools.ts";
import { WorkspacePolicy } from "../../src/tools/security.ts";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import fsSync from "node:fs";
import net from "node:net";

function windowsHelperPath(): string {
  return path.resolve("sandbox-helper", "target", "release", "coding-agent-sandbox-helper.exe");
}

function hasWindowsHelper(): boolean {
  return process.platform === "win32" && fsSync.existsSync(windowsHelperPath());
}

test("execution request digest is stable across environment insertion order", () => {
  const base = { executionId: "test-execution", workspaceRoot: "C:/workspace", executable: "node", args: ["-e", "1"], cwd: "C:/workspace", timeoutMs: 1000, maxStdoutBytes: 10, maxStderrBytes: 10, network: "off" as const, cpuTimeMs: 1000, memoryBytes: 1024 * 1024, maxProcesses: 4 };
  assert.equal(executionRequestDigest({ ...base, env: { B: "2", A: "1" } }), executionRequestDigest({ ...base, env: { A: "1", B: "2" } }));
  assert.equal(executionRequestDigest({ ...base, env: {} }), executionRequestDigest({ ...base, executionId: "another-run", env: {} }));
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
  const helper = windowsHelperPath();
  if (!fsSync.existsSync(helper)) return;
  const backend = new RustHelperSandboxBackend({ helperPath: helper });
  assert.equal(backend.capabilities.backend, "rust-helper");
  assert.equal(backend.capabilities.capabilities.includes("os.isolation"), true);
});

test("Windows Rust helper executes an approved workspace command with OS isolation", { skip: process.platform !== "win32" }, async () => {
  const helper = windowsHelperPath();
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

test("Windows helper denies a sandboxed process access outside its workspace", { skip: !hasWindowsHelper() }, async () => {
  const helper = windowsHelperPath();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "coding-agent-windows-sandbox-"));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "coding-agent-windows-outside-"));
  const secret = path.join(outside, "secret.txt");
  await fs.writeFile(secret, "host-secret");
  try {
    const sandbox = new RustHelperSandboxBackend({ helperPath: helper });
    const tool = createRunCommandTool(new WorkspacePolicy({ root }), { sandbox, requireOsIsolation: true });
    const result = await tool.execute({
      command: process.execPath,
      args: ["-e", `try { require('node:fs').readFileSync(${JSON.stringify(secret)}, 'utf8'); process.exit(9); } catch { process.exit(0); }`],
      cwd: ".",
      env: {},
    }, { messages: [] }) as { readonly exitCode: number | null; readonly stderr: string };
    assert.equal(result.exitCode, 0, result.stderr);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  }
});

test("Windows helper rejects loopback network access", { skip: !hasWindowsHelper() }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "coding-agent-windows-sandbox-"));
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server has no TCP port");
    const sandbox = new RustHelperSandboxBackend({ helperPath: windowsHelperPath() });
    const tool = createRunCommandTool(new WorkspacePolicy({ root }), { sandbox, requireOsIsolation: true, defaultTimeoutMs: 5_000 });
    const program = `const net=require('node:net'); const s=net.connect(${address.port}, '127.0.0.1'); s.once('connect',()=>process.exit(9)); s.once('error',()=>process.exit(0)); setTimeout(()=>process.exit(0),1500);`;
    const result = await tool.execute({ command: process.execPath, args: ["-e", program], cwd: ".", env: {} }, { messages: [] }) as { readonly exitCode: number | null; readonly stderr: string };
    assert.equal(result.exitCode, 0, result.stderr);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("Windows helper timeout terminates a strict sandbox target before delayed workspace write", { skip: !hasWindowsHelper() }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "coding-agent-windows-sandbox-"));
  const marker = path.join(root, "orphan-marker.txt");
  try {
    const sandbox = new RustHelperSandboxBackend({ helperPath: windowsHelperPath() });
    const tool = createRunCommandTool(new WorkspacePolicy({ root }), { sandbox, requireOsIsolation: true, defaultTimeoutMs: 300 });
    const program = `setTimeout(()=>require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'late'), 1200); setInterval(()=>{},1000)`;
    const result = await tool.execute({ command: process.execPath, args: ["-e", program], cwd: ".", env: {} }, { messages: [] }) as { readonly timedOut: boolean; readonly exitCode: number | null; readonly stderr: string };
    // TS 与 Helper 都有超时；由任意一侧先触发都必须终止受限目标。
    assert.equal(result.timedOut || result.exitCode === 124, true, `unexpected exit ${result.exitCode}: ${result.stderr}`);
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    assert.equal(fsSync.existsSync(marker), false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
