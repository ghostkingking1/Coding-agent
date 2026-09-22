import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PlanIntegrityError, PlanStore, PlanTaskStateMachine, WorkModeController, planScopeViolation, type PlanDocument, type PlanScope } from "../../src/agent/work-modes.ts";

const BODY = `# 任务目标

实现工作模式。

# 执行计划

1. 修改目标文件。
2. 运行测试。

# 完成标准

测试通过。

# 边界情况

拒绝越界路径。

# 不应修改的内容

不修改用户文件。

# 测试与验证

运行 npm test。`;

const SCOPE: PlanScope = {
  capabilities: ["write", "execute"],
  tools: ["apply_patch", "run_tests"],
  paths: ["src/"],
  commands: [{ command: "npm", args: ["run", "test", "--"], cwd: "." }],
};

async function withStore(run: (store: PlanStore, root: string) => Promise<void>): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "coding-agent-plan-"));
  const store = new PlanStore(root);
  try { await run(store, root); }
  finally { store.close(); await fs.rm(root, { recursive: true, force: true }); }
}

test("plan store writes readable Markdown, monotonic versions, and status-only updates", async () => {
  await withStore(async (store, root) => {
    store.setCurrentTask("task-one");
    const first = await store.writeScoped(BODY, SCOPE, "session-one");
    assert.equal(first.version, 1);
    assert.equal(first.status, "awaiting-approval");
    assert.match(await fs.readFile(path.join(root, ".veil", "plans", "task-one.md"), "utf8"), /# 执行计划/);

    const executing = await store.updateStatus("task-one", "executing");
    assert.equal(executing.version, 1);
    assert.equal(executing.hash, first.hash);
    await store.updateStatus("task-one", "validating");
    const completed = await store.updateStatus("task-one", "completed");
    assert.equal(completed.version, 1);

    const second = await store.writeScoped(`${BODY}\n`, SCOPE, "session-one", "task-one");
    assert.equal(second.version, 2);
  });
});

test("plan store reports corrupt or index-mismatched plans instead of skipping them", async () => {
  await withStore(async (store) => {
    store.setCurrentTask("task-corrupt");
    await store.writeScoped(BODY, SCOPE, "session-one");
    const file = store.filePath("task-corrupt");
    const text = await fs.readFile(file, "utf8");
    await fs.writeFile(file, text.replace("status: awaiting-approval", "status: planned"), "utf8");
    await assert.rejects(() => store.listUnfinished(), PlanIntegrityError);
  });
});

test("plan state machine accepts lifecycle transitions and rejects invalid completion", () => {
  assert.equal(new PlanTaskStateMachine("planned").transition("executing").transition("validating").transition("completed").current, "completed");
  assert.throws(() => new PlanTaskStateMachine("planned").transition("completed"), /Invalid plan state transition/);
  assert.throws(() => new PlanTaskStateMachine("cancelled").transition("planned"), /Invalid plan state transition/);
});

test("plan scope binds paths and exact command arguments", () => {
  const plan: PlanDocument = { taskId: "task", sessionId: "session", version: 1, status: "executing", hash: "hash", body: BODY, updatedAt: new Date().toISOString(), scope: SCOPE };
  const patch = { name: "apply_patch", manifest: { capabilities: ["read", "write"] as const } };
  assert.equal(planScopeViolation(plan, patch, { changes: [{ path: "src/app.ts" }] }, "C:/workspace"), undefined);
  assert.match(planScopeViolation(plan, patch, { changes: [{ path: "README.md" }] }, "C:/workspace") ?? "", /outside plan scope/);
  const command = { name: "run_command", manifest: { capabilities: ["execute"] as const } };
  assert.match(planScopeViolation(plan, command, { command: "npm", args: ["test", "--watch"], cwd: "." }, "C:/workspace") ?? "", /outside plan scope/);
});

test("work mode keeps full access until explicit normal reset and tracks an active plan", () => {
  const mode = new WorkModeController();
  mode.setFullExecute();
  mode.setExecute();
  assert.equal(mode.accessMode, "full");
  mode.setNormalExecute();
  assert.equal(mode.accessMode, "ask");
});
