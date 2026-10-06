import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { GitRepository } from "../../src/repository/git.ts";

function git(root: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => execFile("git", ["-C", root, ...args], { encoding: "utf8" }, (error, stdout, stderr) => error ? reject(new Error(stderr || error.message)) : resolve(stdout.trim())));
}

test("Recovery tree reuses Git objects without creating a user history commit or changing the index", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "veil-git-recovery-"));
  try {
    await git(root, ["init", "-q"]);
    await git(root, ["config", "user.email", "test@example.com"]);
    await git(root, ["config", "user.name", "Recovery Test"]);
    await fs.writeFile(path.join(root, "tracked.txt"), "before\n");
    await git(root, ["add", "tracked.txt"]);
    await git(root, ["commit", "-qm", "initial"]);
    await fs.writeFile(path.join(root, "tracked.txt"), "after\n");
    await fs.writeFile(path.join(root, "new.txt"), "new\n");
    const indexBefore = await git(root, ["status", "--porcelain=v1"]);
    const headBefore = await git(root, ["rev-parse", "HEAD"]);
    const repository = new GitRepository(root);
    const recovery = await repository.createRecoveryTree("rp_test_tree");
    assert.equal(recovery.objectType, "tree");
    assert.equal(recovery.provider, "git-object-store");
    assert.equal(await git(root, ["rev-parse", "HEAD"]), headBefore);
    assert.equal(await git(root, ["status", "--porcelain=v1"]), indexBefore);
    assert.equal(await git(root, ["rev-parse", `${recovery.refName}^{tree}`]), recovery.objectId);
    assert.equal(await git(root, ["log", "-1", "--format=%s"]), "initial");

    await fs.writeFile(path.join(root, "tracked.txt"), "broken\n");
    await fs.writeFile(path.join(root, "later.txt"), "remove\n");
    await repository.restoreRecoveryTree(recovery);
    assert.equal((await fs.readFile(path.join(root, "tracked.txt"), "utf8")).replaceAll("\r\n", "\n"), "after\n");
    assert.equal((await fs.readFile(path.join(root, "new.txt"), "utf8")).replaceAll("\r\n", "\n"), "new\n");
    await assert.rejects(() => fs.stat(path.join(root, "later.txt")));
    assert.equal(await git(root, ["rev-parse", "HEAD"]), headBefore);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
