# Run Diff 与工具输出链路

## 1. 目标

记录一次 Agent run 对工作区造成的实际变化，并在工具输出过大时把完整可用内容移出模型上下文，保留可恢复引用。

## 2. 整体流程

```text
run 开始 -> RunChangeTracker 建立 baseline
工具/命令修改工作区
工具产生大输出 -> ToolOutputStore 保存 artifact
run 结束 -> 再次快照 -> hash 比较 -> 生成 unified diff
模型需要详情 -> read_tool_output 分页读取
```

## 3. 核心模块

| 模块 | 状态 | 责任 | 入口 |
| --- | --- | --- | --- |
| RunChangeTracker | **已实现** | 快照、hash、diff 和 baseline 生命周期 | `src/agent/run-diff.ts:RunChangeTracker` |
| ToolOutputStore | **已实现** | 大输出临时落盘和分页读取 | `src/agent/tool-output-store.ts` |
| read_tool_output | **已实现** | 受限读取 artifact | `src/tools/tool-output-tool.ts:createToolOutputReadTool()` |
| 持久化 diff 审计 | **部分实现** | RunResult 可保存 diff，但无独立 diff 表 | `runs.result_json` |

## 4. 数据流

baseline 只在内存保存路径、类型、大小、mtime、SHA-256 和 baselinePath；文本原文保存到带 session/run 身份的临时目录。结束时只读取新增、删除或 hash 变化的文件生成 diff。

ToolOutputStore 将工具输出写入 session/run 专属目录，模型消息只携带预览和 artifactId。`read_tool_output` 使用 offset/limit 分页，不接受任意路径。

## 5. 关键决策

- 文件路径位于隐藏目录、`.git` 或 `node_modules`：默认忽略。
- 单文件、文件数或总快照超限：标记 `complete=false` 或 `untrackedPaths`。
- hash 未变化：不重新读取和生成 diff。
- 文本文件：生成 unified diff；二进制文件：只报告 binary differ。
- diff 超过上限：截断并标记 `truncated=true`。
- 工具输出超过 artifact 上限：只保存前缀并标记 `complete=false`。

## 6. 异常流程

```text
快照读取失败 -> omittedPaths -> complete=false
文件在前后快照间变化 -> 省略不稳定文件并标记不完整
baseline 临时目录清理失败 -> 不影响主 run
进程崩溃遗留 baseline -> 启动时清理过期项目目录
artifact 不存在/参数非法 -> read_tool_output 失败
```

## 7. 持久化 / 审计

`RunDiff` 可随 `AgentResult` 写入 `runs.result_json`；Session 多轮使用 reusable baseline，每轮 finish 后 promote 当前基线。临时 baseline 和 tool artifact 不属于 SQLite 核心表，生命周期结束后清理。

## 8. 安全边界

- 临时目录按安全的 sessionId/runId/artifactId 组织，拒绝任意 artifact 路径。
- 快照和 diff 有文件数量、单文件、总字节和文本输出上限。
- 不把运行前已有 Git 修改混入 run diff；比较基于运行前后快照。
- `complete=false`、`omittedPaths` 和 `untrackedPaths` 必须向调用方显式提示，不能误报为完整审计。

## 9. 设计原因

快照方案不依赖 Git，因此可捕获命令和测试脚本产生的变化，并隔离运行前状态；磁盘 baseline 降低内存占用；artifact 分页让模型按需获取大输出，避免上下文被 stdout 耗尽。

## 10. 当前边界

**已实现**运行级 diff、baseline 复用和工具输出 artifact；**部分实现**结果持久化和失败后的清理；`RunDiff` 当前随 `runs.result_json` 保存，事件审计写入 SQLite `audit_events`。后续可采用“JSONL 追加事件事实源 + SQLite 索引/lease/查询控制面 + 文件系统 artifact”的混合模型，但 JSONL 尚未作为当前运行时存储启用。

## 11. 相关测试

- `test/agent/run-diff.test.ts`
- `test/agent/tool-output-store.test.ts`
- `test/cli.test.ts`
