# Benchmark Harness

## 为什么需要 Benchmark Harness

`run_tests` 是 Agent 可调用的一个工具，不是 Agent 能力的客观评测。Benchmark Harness 在 CodingAgent Runtime 之外固定任务、准备隔离工作区并执行外部验收，从而衡量任务质量、成本和安全行为。Agent 的最终答复和内部任务状态只作为诊断信息保存。

> **Agent 完成 ≠ Task 成功**  
> **External verifier decides.**

只有固定 verifier、Diff 完整性/约束和安全规则全部通过，Task 才计为成功。Agent 即使回答“完成”仍可能失败；反过来，Agent 内部验证工具不可用或自身状态为 blocked，只要外部验收全部通过且无安全违规，Task 仍可成功，同时保留 Agent 的失败状态供分析。

## 架构

```text
固定任务集（fixture digest + prompt + limits + diff rules）
             ↓
创建唯一工作区（fixture 源保持只读）
             ↓
CodingAgent Runtime（Tool Registry + WorkspacePolicy + 审批 + Rust Sandbox）
             ↓
保存 model usage、事件轨迹、审计、Diff 和错误
             ↓
Rust Sandbox 内的外部 verifier（网络关闭；测试规则在工作区之外维护）
             ↓
外部聚合判定 → JSON / Markdown 报告；失败工作区留存
```

`veil` 会自动从当前项目或安装位置查找已构建的 Sandbox Helper，也可用 `CODING_AGENT_SANDBOX_HELPER` 指定路径。没有可用 helper 时，普通模式仍提供受限文件读取和 patch；命令/测试工具不会假装成功或退化成无隔离宿主命令。`/mode execute full` 是用户显式选择宿主能力的入口，不是默认行为。

当前 Windows 环境下 helper 会正常注册 `run_command`/`run_tests`，普通 node 子命令可在沙箱中运行；但 AppContainer 对 `npm.CMD` shim 和 Node 从工作区解析 ESM 测试文件存在路径限制（`D:\` 根目录 `EPERM`）。因此内部 `run_tests` 可能失败并让 Agent 进入 blocked。Harness 仍独立运行 verifier 并如实同时保存两种结果；不要把 CLI 工具“已注册”误说成所有平台命令都已验证可运行。需要运行不兼容的宿主构建/测试命令时，必须由操作者明确选择 full 模式，不能静默绕过 sandbox。

Benchmark 对模型网络单独要求显式授权；Agent 的工作区命令预授权仅覆盖 `read`、`write`、`execute`，永不覆盖 `network`。Agent 与 verifier 命令都要求 sandbox 声明 `network.off`、OS 隔离、资源限制和进程树回收；任一能力或 preflight 不满足时 fail closed，不发送任务。

## 任务格式

任务定义位于 `benchmark/dataset/<task-id>/task.json`，fixture 与 verifier 分开保存：

```json
{
  "id": "fix-login-bug",
  "title": "Reject locked users and invalid passwords",
  "prompt": "Fix authenticate() so locked users are rejected...",
  "fixture": "fix-login-bug/fixture",
  "verification": "fix-login-bug/verification",
  "baseCommit": "fixture-tree-v1:fix-login-bug",
  "fixtureDigest": "sha256:<64 hex characters>",
  "environment": { "node": ">=22", "platform": "any" },
  "limits": { "maxDurationMs": 300000, "maxSteps": 14 },
  "diffRules": {
    "allowedPaths": ["auth.mjs", "auth.test.mjs"],
    "forbiddenPaths": ["package.json", "verification/**"]
  }
}
```

`fixtureDigest` 对 fixture 中排序后的相对路径和文件字节计算 SHA-256；运行前不匹配就拒绝评测。离线 fixture 以 `fixture-tree-v1:<id>` 标识，不伪称 Git commit。Verifier 导出 `verify({ workspaceRoot, task })`，返回至少一个 `{ name, passed, details? }` 检查项。Verifier 源在独立目录，只有 Agent 结束后才被 evaluator 读取，并通过同一个离线 Rust Sandbox 执行；Agent 不能修改验收逻辑。

当前固定集有 5 个任务：登录 Bug、slug 功能、购物车金额舍入、补充 clamp 边界测试、配置默认值行为。当前 Windows/AppContainer 下 Node 对工作区 ESM 模块路径解析会探测 `D:\` 根并被拒绝；verifier 因此在沙箱内直接读取源文本，通过受限 VM 检查纯函数行为。`add-math-tests` 的 verifier 检查新增测试文件、边界覆盖标记和实现行为，不冒称已运行 Node Test Runner。

## 运行方式

```powershell
npm run sandbox:build
# 在 .env 配置真实模型；不要提交 .env
npm run benchmark -- --allow-model-network

# 只跑一项，或显式指定数据集/结果目录/任务 ID
npm run benchmark -- --allow-model-network benchmark/dataset evaluation-output fix-login-bug

# CodingAgent 日常使用：已构建的项目 helper 会被自动发现
npm start -- "检查当前项目并修复问题"
# TTY 模式进入 veil 后，默认 execute + ask；需要宿主机能力时明确选择：
/mode execute full
```

`--allow-model-network` 明确授权把任务请求及工作区上下文发送给 `.env` 中配置的模型；无该参数不会发请求。每次评测写入独立的 `evaluation-output/runs/<run-id>/`：summary、Markdown、task result、trajectory、patch 和日志。失败工作区保留，成功工作区默认清理。`evaluation-output/` 已加入 `.gitignore`。

## 指标

- 质量：外部验收通过数、外部测试通过数、Diff 完整性、允许/禁止路径规则、最终 Task 成功率。
- 效率：模型 usage（输入/输出/总 Token；provider 不返回时标 unavailable）、总耗时、Agent step、模型工具调用数。
- 稳定与诊断：模型标识、Agent stop reason/内部验证状态、每步模型与工具事件、每个工具输入/结果、错误、最终 Diff 和受限审计事件。
- 安全：越界/拒绝事件会计入违规；任何已识别安全违规都会阻止 Task 成功。普通 sandbox 命令失败/超时会记录，但不会误算成安全违规。

总成功判定：外部 verifier 至少返回一项且所有检查通过，Diff 快照完整且无遗漏、Diff 路径规则通过、安全事件为零，且任务没有整体超时。Agent 的 `stopReason`、自然语言最终答复和 Runtime 内部验证状态不参与“通过”投票，只写进报告供失败分析。

## 示例结果

以下是一次真实模型请求的原始评测结果，不是 Mock 或手写模拟分数。来源：`evaluation-output/runs/2026-09-23T11-05-09-031Z-23e6c3f2/summary.json`，任务 `fix-login-bug`，模型 `openai-compatible/glm-5.3`：

| 结果 | 实测值 |
|---|---:|
| Task | passed |
| 外部 verifier | 3/3 passed |
| Diff 完整 / 路径规则 | passed / passed |
| 安全违规 | 0 |
| Agent stop reason / 内部验证 | blocked / failed |
| 步骤 / 工具调用 | 12 / 22 |
| 输入 / 输出 / 总 Token | 53,950 / 4,272 / 58,222 |
| 耗时 | 273.6 s |
| 修改文件 | `auth.mjs` |

这个结果刻意保留了 Agent 与评测器意见不一致的事实：Agent 内部的 `npm test` 在当前 Windows AppContainer 环境因 Node/npm 路径访问限制失败并进入 blocked；独立 verifier 随后直接加载（VM 执行）工作区实现，确认正确凭证接受、错误密码拒绝、锁定账户拒绝，Diff 与安全检查也通过。因此 Task 由 External verifier 判为成功，而不是由 Agent 自己宣布完成。其他真实失败运行也会保留在 evaluation-output 中，用来追踪模型超时、工具问题和资源限制；不要把本机一次样例外推成模型普遍成功率。
