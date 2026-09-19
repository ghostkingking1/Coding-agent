import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import test from "node:test";
import { ApprovalDeniedError, SecurityPolicy, WorkspacePolicy, WorkspaceSecurityError } from "../../src/tools/security.ts";
import { ToolRegistry } from "../../src/tools/tool-registry.ts";
import { createWorkspaceTools } from "../../src/tools/workspace-tools.ts";
import { createPatchTool, PreparedOperationStaleError, recoverPatchTransactions, type PatchPreview, type PatchResult } from "../../src/tools/patch-tools.ts";
import { RunChangeTracker } from "../../src/agent/run-diff.ts";

async function withWorkspace(run: (root: string) => Promise<void>): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "coding-agent-"));
  try {
    await run(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

test("apply_patch previews and applies edits", async () => {
  await withWorkspace(async (root) => {
    await fs.mkdir(path.join(root, "src"));
    await fs.writeFile(path.join(root, "src", "app.ts"), "const answer = 41;\nconsole.log(answer);\n");
    const patch = createWorkspaceTools(new WorkspacePolicy({ root })).find((tool) => tool.name === "apply_patch");
    const preview = patch?.preview;
    if (!patch || !preview) throw new Error("apply_patch was not registered");

    const input = {
      changes: [
        {
          path: "src/app.ts",
          find: "const answer = 41;",
          replaceWith: "const answer = 42;",
        },
      ],
    };

    const previewResult = (await preview(input, { messages: [] })) as PatchPreview;
    assert.match(previewResult.preview, /--- src[\\/]app\.ts/);
    assert.match(previewResult.preview, /- const answer = 41;/);
    assert.match(previewResult.preview, /\+ const answer = 42;/);

    const result = (await patch.execute(input, { messages: [] })) as PatchResult;
    assert.equal(result.applied, true);
    assert.equal(result.files[0]?.path, path.join("src", "app.ts"));
    assert.match(result.preview, /@@ -1,1 \+1,1 @@/);
    assert.equal(await fs.readFile(path.join(root, "src", "app.ts"), "utf8"), "const answer = 42;\nconsole.log(answer);\n");
  });
});

test("apply_patch rejects missing text", async () => {
  await withWorkspace(async (root) => {
    await fs.mkdir(path.join(root, "src"));
    await fs.writeFile(path.join(root, "src", "app.ts"), "const answer = 41;\n");
    const patch = createWorkspaceTools(new WorkspacePolicy({ root })).find((tool) => tool.name === "apply_patch");
    if (!patch) throw new Error("apply_patch was not registered");

    await assert.rejects(
      () => Promise.resolve(patch.execute({
        changes: [
          {
            path: "src/app.ts",
            find: "const answer = 42;",
            replaceWith: "const answer = 43;",
          },
        ],
      }, { messages: [] })),
      /Patch text not found/,
    );
  });
});

test("apply_patch rejects workspace escape attempts", async () => {
  await withWorkspace(async (root) => {
    const patch = createWorkspaceTools(new WorkspacePolicy({ root })).find((tool) => tool.name === "apply_patch");
    if (!patch) throw new Error("apply_patch was not registered");

    await assert.rejects(
      () => Promise.resolve(patch.execute({
        changes: [
          {
            path: "../outside.ts",
            find: "const answer = 41;",
            replaceWith: "const answer = 42;",
          },
        ],
      }, { messages: [] })),
      WorkspaceSecurityError,
    );
  });
});

test("approval policy sees the patch preview before denying", async () => {
  await withWorkspace(async (root) => {
    await fs.mkdir(path.join(root, "src"));
    await fs.writeFile(path.join(root, "src", "app.ts"), "const answer = 41;\n");
    const registry = new ToolRegistry(new SecurityPolicy({
      approval: {
        requestApproval: (request) => {
          const preview = request.preview as PatchPreview | undefined;
          assert.ok(preview);
          assert.match(preview.preview, /--- src[\\/]app\.ts/);
          return false;
        },
      },
    }));
    const patch = createWorkspaceTools(new WorkspacePolicy({ root })).find((tool) => tool.name === "apply_patch");
    if (!patch) throw new Error("apply_patch was not registered");
    registry.register(patch);

    await assert.rejects(() => registry.execute("apply_patch", {
      changes: [
        {
          path: "src/app.ts",
          find: "const answer = 41;",
          replaceWith: "const answer = 42;",
        },
      ],
    }, { messages: [] }), ApprovalDeniedError);
    assert.equal(await fs.readFile(path.join(root, "src", "app.ts"), "utf8"), "const answer = 41;\n");
  });
});

test("apply_patch records originals only when execution is approved", async () => {
  await withWorkspace(async (root) => {
    const file = path.join(root, "app.ts");
    await fs.writeFile(file, "const answer = 41;\n", "utf8");
    const policy = new WorkspacePolicy({ root });
    const patch = createWorkspaceTools(policy).find((tool) => tool.name === "apply_patch");
    if (!patch) throw new Error("apply_patch was not registered");
    const tracker = new RunChangeTracker();
    const input = { changes: [{ path: "app.ts", find: "41", replaceWith: "42" }] };

    await patch.preview?.(input, { messages: [], changeTracker: tracker });
    assert.deepEqual((await tracker.finish()).files, []);
    await patch.execute(input, { messages: [], changeTracker: tracker });
    const result = await tracker.finish();
    assert.match(result.text, /-const answer = 41;/);
    assert.match(result.text, /\+const answer = 42;/);
  });
});

test("apply_patch rejects a file changed while approval is pending", async () => {
  await withWorkspace(async (root) => {
    const file = path.join(root, "app.ts");
    await fs.writeFile(file, "const answer = 41;\n");
    const registry = new ToolRegistry(new SecurityPolicy({
      approval: {
        async requestApproval() {
          await fs.writeFile(file, "const answer = 99;\n");
          return true;
        },
      },
    })).register(createPatchTool(new WorkspacePolicy({ root })));

    await assert.rejects(() => registry.execute("apply_patch", {
      changes: [{ path: "app.ts", find: "41", replaceWith: "42" }],
    }, { messages: [] }), PreparedOperationStaleError);
    assert.equal(await fs.readFile(file, "utf8"), "const answer = 99;\n");
  });
});

test("multi-file patch restores earlier files when a later rename fails", async () => {
  await withWorkspace(async (root) => {
    const first = path.join(root, "first.ts");
    const second = path.join(root, "second.ts");
    await fs.writeFile(first, "first old\n");
    await fs.writeFile(second, "second old\n");
    let backupRenames = 0;
    let failed = false;
    const patch = createPatchTool(new WorkspacePolicy({ root }), {
      async rename(source, target) {
        if (target.includes(".veil-bak-") && ++backupRenames === 2 && !failed) {
          failed = true;
          throw Object.assign(new Error("injected rename failure"), { code: "EIO" });
        }
        await fs.rename(source, target);
      },
    });

    await assert.rejects(() => Promise.resolve(patch.execute({ changes: [
      { path: "first.ts", find: "old", replaceWith: "new" },
      { path: "second.ts", find: "old", replaceWith: "new" },
    ] }, { messages: [] })), /injected rename failure/);
    assert.equal(await fs.readFile(first, "utf8"), "first old\n");
    assert.equal(await fs.readFile(second, "utf8"), "second old\n");
  });
});

test("explicit patch recovery restores an interrupted transaction", async () => {
  await withWorkspace(async (root) => {
    const transactionId = crypto.randomUUID();
    const target = path.join(root, "app.ts");
    const temporary = `${target}.veil-tmp-${transactionId}`;
    const backup = `${target}.veil-bak-${transactionId}`;
    await fs.writeFile(target, "new\n");
    await fs.writeFile(backup, "old\n");
    await fs.writeFile(temporary, "new\n");
    const workspaceId = crypto.createHash("sha256").update(path.resolve(root)).digest("hex");
    const directory = path.join(os.tmpdir(), "coding-agent-patch-journal", workspaceId);
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, `${transactionId}.json`), JSON.stringify({
      version: 1,
      transactionId,
      workspaceRoot: root,
      entries: [{ target, temporary, backup, state: "applied" }],
    }));

    assert.equal(await recoverPatchTransactions(root), 1);
    assert.equal(await fs.readFile(target, "utf8"), "old\n");
    await assert.rejects(() => fs.stat(backup));
    await assert.rejects(() => fs.stat(temporary));
  });
});
