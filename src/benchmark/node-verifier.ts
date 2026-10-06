import crypto from "node:crypto";
import path from "node:path";
import type { SandboxBackend } from "../tools/sandbox.ts";
import type { BenchmarkCheck, BenchmarkTask, BenchmarkVerifier } from "./types.ts";

/** 将可信 verifier 源码作为 node --eval 输入送入隔离 Helper；不在 evaluator 进程导入 Agent 可影响的代码。 */
export class NodeModuleBenchmarkVerifier implements BenchmarkVerifier {
  private readonly sandbox: SandboxBackend;

  constructor(sandbox: SandboxBackend) { this.sandbox = sandbox; }

  async run(task: BenchmarkTask, workspaceRoot: string, verificationRoot: string, signal: AbortSignal): Promise<readonly BenchmarkCheck[]> {
    this.sandbox.assertAvailable(["network.off", "os.isolation", "resource.limits", "process-tree"]);
    signal.throwIfAborted();
    const verifierSource = await (await import("node:fs/promises")).readFile(`${verificationRoot}/verify.mjs`, "utf8");
    const moduleUrl = `data:text/javascript;base64,${Buffer.from(verifierSource).toString("base64")}`;
    const code = `const {verify}=await import(process.env.BENCH_VERIFIER_MODULE);if(typeof verify!=="function")throw new Error("Verifier must export verify()");const task=JSON.parse(process.argv[1]);const checks=await verify({workspaceRoot:process.cwd(),task});console.log("BENCH_RESULT:"+JSON.stringify(checks));`;
    const env = Object.fromEntries(["APPDATA", "ComSpec", "LOCALAPPDATA", "Path", "PATH", "PATHEXT", "SystemRoot", "TEMP", "TMP", "USERPROFILE"].flatMap((key) => process.env[key] === undefined ? [] : [[key, process.env[key]!] ]));
    env.BENCH_VERIFIER_MODULE = moduleUrl;
    const child = this.sandbox.spawn({
      executionId: crypto.randomUUID(), workspaceRoot: path.resolve(workspaceRoot), cwd: path.resolve(workspaceRoot), executable: process.execPath,
      args: ["--input-type=module", "--eval", code, JSON.stringify(task)], env, timeoutMs: Math.min(task.limits.maxDurationMs, 120_000),
      maxStdoutBytes: 256 * 1024, maxStderrBytes: 64 * 1024, network: { mode: "off" },
      cpuTimeMs: Math.min(task.limits.maxDurationMs, 120_000), memoryBytes: 512 * 1024 * 1024, maxProcesses: 16,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "", stderr = "";
    child.stdout?.setEncoding("utf8"); child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => { stdout = (stdout + chunk).slice(-256 * 1024); });
    child.stderr?.on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-64 * 1024); });
    const aborted = () => child.kill();
    signal.addEventListener("abort", aborted, { once: true });
    let exitCode: number | null;
    try { exitCode = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); }); }
    finally { signal.removeEventListener("abort", aborted); }
    if (signal.aborted) throw signal.reason ?? new Error("Verifier aborted");
    if (exitCode !== 0) throw new Error(`Verifier process failed (${exitCode}): ${stderr.slice(0, 2000)}`);
    const line = stdout.split(/\r?\n/).find((entry) => entry.startsWith("BENCH_RESULT:"));
    if (!line) throw new Error("Verifier did not return a result marker");
    const checks = JSON.parse(line.slice("BENCH_RESULT:".length)) as BenchmarkCheck[];
    if (!Array.isArray(checks) || checks.length === 0 || checks.some((check) => typeof check.name !== "string" || typeof check.passed !== "boolean")) throw new Error(`Verifier for ${task.id} returned invalid or empty checks`);
    return checks;
  }
}
