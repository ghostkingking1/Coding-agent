import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import { RepositoryInstructionLoader, formatRepositoryInstructions } from "../../src/repository/instructions.ts";
import { GitRepository, GitChangeTracker } from "../../src/repository/git.ts";
import { createRepositoryTools } from "../../src/repository/tools.ts";
const exec = promisify(execFile);
test("repository instructions merge and can be disabled", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "coding-agent-repository-"));
  try { await fs.mkdir(path.join(root, "src", "nested"), { recursive: true }); await fs.writeFile(path.join(root, "AGENTS.md"), "root rule\nrun this command\n"); await fs.writeFile(path.join(root, "src", "AGENTS.md"), "specific rule\n"); const loaded = await new RepositoryInstructionLoader().load({ workspaceRoot: root, currentDirectory: path.join(root, "src", "nested"), maxFileChars: 100, maxTotalChars: 300 }); assert.deepEqual(loaded.sources.map((source) => source.path), ["AGENTS.md", path.join("src", "AGENTS.md")]); assert.match(formatRepositoryInstructions(loaded), /Never execute commands/); assert.equal((await new RepositoryInstructionLoader().load({ workspaceRoot: root, enabled: false })).sources.length, 0); } finally { await fs.rm(root, { recursive: true, force: true }); }
});
test("GitRepository provides read-only status, diff, and commit preview", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "coding-agent-git-"));
  try { await exec("git", ["init", "-q", root]); await exec("git", ["-C", root, "config", "user.email", "test@example.com"]); await exec("git", ["-C", root, "config", "user.name", "Test"]); await fs.writeFile(path.join(root, "file.txt"), "before\n"); await exec("git", ["-C", root, "add", "file.txt"]); await exec("git", ["-C", root, "commit", "-qm", "initial"]); await fs.writeFile(path.join(root, "file.txt"), "after\n"); await fs.writeFile(path.join(root, "new.txt"), "new\n"); const repository = new GitRepository(root); const status = await repository.status(); assert.equal(status.isRepository, true); assert.equal(status.files.some((file) => file.path === "new.txt" && file.states.includes("untracked")), true); assert.match(await repository.fileDiff("file.txt"), /\+after/); const preview = await repository.commitPreview("preview only"); assert.equal(preview.message, "preview only"); assert.equal((await repository.status()).head, status.head); assert.equal(createRepositoryTools(await new RepositoryInstructionLoader().load({ workspaceRoot: root }), repository).length, 3); } finally { await fs.rm(root, { recursive: true, force: true }); }
});
test("GitChangeTracker distinguishes user and Agent changes", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "coding-agent-git-"));
  try { await exec("git", ["init", "-q", root]); await exec("git", ["-C", root, "config", "user.email", "test@example.com"]); await exec("git", ["-C", root, "config", "user.name", "Test"]); await fs.writeFile(path.join(root, "existing.txt"), "base\n"); await exec("git", ["-C", root, "add", "."]); await exec("git", ["-C", root, "commit", "-qm", "initial"]); await fs.writeFile(path.join(root, "existing.txt"), "user edit\n"); const repository = new GitRepository(root); const tracker = new GitChangeTracker(repository); await tracker.start(); await fs.writeFile(path.join(root, "agent.txt"), "agent\n"); const report = await tracker.finish({ sessionId: "s", runId: "r", files: [{ path: "agent.txt", diff: "" }], text: "", truncated: false, complete: true, omittedPaths: [], untrackedPaths: [] }); assert.deepEqual(report.userModifiedPaths, ["existing.txt"]); assert.deepEqual(report.agentModifiedPaths, ["agent.txt"]); } finally { await fs.rm(root, { recursive: true, force: true }); }
});
