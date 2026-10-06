import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";
import { runBenchmark } from "./runner.ts";
import { NodeModuleBenchmarkVerifier } from "./node-verifier.ts";
import { createSandboxedBenchmarkRuntime } from "./runtime.ts";
import { createConfiguredModelClient, readModelRuntimeConfig } from "../model/runtime-config.ts";
import { RustHelperSandboxBackend } from "../tools/sandbox.ts";

export async function main(args = process.argv.slice(2)): Promise<void> {
  const allowModelNetwork = args.includes("--allow-model-network");
  const values = args.filter((arg) => arg !== "--allow-model-network");
  if (!allowModelNetwork) throw new Error("Benchmark sends task prompts and workspace context to the configured model. Re-run with --allow-model-network to explicitly authorize this.");
  const config = readModelRuntimeConfig(process.env);
  if (!config) throw new Error("Configure the model in .env before running the benchmark.");
  const root = process.cwd();
  const datasetRoot = path.resolve(values[0] ?? path.join(root, "benchmark", "dataset"));
  const outputRoot = path.resolve(values[1] ?? path.join(root, "evaluation-output"));
  const taskIds = values.slice(2);
  const configuredHelper = process.env.CODING_AGENT_SANDBOX_HELPER;
  const helperNames = process.platform === "win32" ? ["coding-agent-sandbox-helper.exe", "sandbox-helper.exe"] : ["coding-agent-sandbox-helper", "sandbox-helper"];
  const candidates = configuredHelper ? [configuredHelper] : helperNames.map((name) => path.join(root, "sandbox-helper", "target", "release", name));
  const helperPath = (await Promise.all(candidates.map(async (candidate) => { try { await fs.access(candidate); return candidate; } catch { return undefined; } }))).find(Boolean);
  if (!helperPath) throw new Error(`Sandbox helper not found. Build it with npm run sandbox:build or set CODING_AGENT_SANDBOX_HELPER. Checked: ${candidates.join(", ")}`);
  let sandbox: RustHelperSandboxBackend;
  try { sandbox = new RustHelperSandboxBackend({ helperPath }); }
  catch (error) { throw new Error(`Sandbox helper is present but unavailable: ${error instanceof Error ? error.message : String(error)}. Benchmark will not fall back to unsandboxed execution.`); }
  const model = createConfiguredModelClient(config, { approval: { requestApproval: () => true } });
  const preflightRoot = await fs.mkdtemp(path.join(os.tmpdir(), "veil-benchmark-preflight-"));
  try {
    const env = Object.fromEntries(["APPDATA", "ComSpec", "LOCALAPPDATA", "Path", "PATH", "PATHEXT", "SystemRoot", "TEMP", "TMP", "USERPROFILE"].flatMap((key) => process.env[key] === undefined ? [] : [[key, process.env[key]!] ]));
    const probe = sandbox.spawn({ executionId: `benchmark-preflight-${Date.now()}`, workspaceRoot: preflightRoot, cwd: preflightRoot, executable: process.execPath, args: ["-e", "process.stdout.write('benchmark-sandbox-ok')"], env, timeoutMs: 10_000, maxStdoutBytes: 4096, maxStderrBytes: 4096, network: { mode: "off" }, cpuTimeMs: 10_000, memoryBytes: 256 * 1024 * 1024, maxProcesses: 4, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    probe.stdout?.setEncoding("utf8"); probe.stderr?.setEncoding("utf8");
    probe.stdout?.on("data", (chunk: string) => { stdout += chunk; }); probe.stderr?.on("data", (chunk: string) => { stderr += chunk; });
    const exitCode = await new Promise<number | null>((resolve, reject) => { probe.once("error", reject); probe.once("close", resolve); });
    if (exitCode !== 0 || stdout !== "benchmark-sandbox-ok") throw new Error(`Sandbox preflight failed (status=${exitCode ?? "unknown"}, stderr=${stderr.slice(0, 1000)}). No model task was sent.`);
  } finally { await fs.rm(preflightRoot, { recursive: true, force: true }); }
  const summary = await runBenchmark({
    datasetRoot, outputRoot,
    runtime: createSandboxedBenchmarkRuntime(model, sandbox),
    verifier: new NodeModuleBenchmarkVerifier(sandbox),
    ...(taskIds.length ? { taskIds } : {}),
  });
  process.stdout.write(`Benchmark ${summary.successCount}/${summary.taskCount} passed.\n`);
  process.stdout.write(`Report: ${path.join(summary.outputDirectory, "report.md")}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
}
