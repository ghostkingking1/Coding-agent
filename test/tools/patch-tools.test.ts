import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ApprovalDeniedError, SecurityPolicy, WorkspacePolicy, WorkspaceSecurityError } from "../../src/tools/security.ts";
import { ToolRegistry } from "../../src/tools/tool-registry.ts";
import { createWorkspaceTools } from "../../src/tools/workspace-tools.ts";
import type { PatchPreview, PatchResult } from "../../src/tools/patch-tools.ts";
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
