# Session 持久化与审计数据链路

## 1. 目标

把 Session、Run 和已提交消息保存为可查询的结构化记录，使进程重启后能够恢复上下文并解释运行结果。

## 2. 整体流程

```text
Session.initialize -> sessions
Session.run        -> startRun -> runs(running)
成功               -> completeRun 事务 -> runs + messages + session 更新时间
失败               -> failRun 事务 -> runs(failed/interrupted)
恢复               -> 查询 sessions/runs/messages -> Session.restore
```

## 3. 核心模块

| 模块 | 状态 | 责任 | 入口 |
| --- | --- | --- | --- |
| SessionStore | **已实现** | 定义存储契约 | `src/agent/session-store.ts` |
| SqliteSessionStore | **已实现** | SQLite schema、查询和事务 | `src/agent/sqlite-session-store.ts` |
| SessionManager | **已实现** | 恢复前校验和过期 run 处理 | `src/agent/session-manager.ts` |
| Audit event store | **已实现** | append-only 事件表和受限事件查询 | `src/agent/sqlite-session-store.ts` |

## 4. 数据流与表数据

### `sessions`

保存会话身份、`workspace_root`、`active/closed` 状态、创建/更新时间和 schema 版本。

### `runs`

保存 `id`、`session_id`、状态、用户 `input`、`final_text`、错误、开始/结束时间、`result_json`，以及 owner/lease 字段。状态包括 `running`、`completed`、`failed`、`interrupted`。

### `messages`

保存 Session 内按 `sequence` 排序的完整消息。除 `role` 和 `content` 外，tool 消息保存 `tool_call_id/tool_name`，assistant 消息保存 `tool_calls_json`。

### `audit_events`

保存事件序号、Session/Run 关联、事件类型、时间和受限 JSON 摘要。记录 run 生命周期、模型尝试/重试、流式完成、工具批次和 sandbox 执行结果；不保存 API key、认证头、完整模型请求或无限工具输出。

### `schema_migrations`

保存数据库 schema 版本，当前 schema version 为 2。

## 5. 关键决策

- 成功 run 的运行记录和新增消息必须在同一事务提交。
- `sequence` 在 Session 内唯一，恢复按序读取。
- 失败 run 不插入部分消息。
- schema 版本高于当前支持版本时拒绝打开数据库。
- 过期 lease 才能被恢复流程标记为 interrupted。

## 6. 异常流程

```text
重复 Session ID -> 主键约束失败
数据库 schema 更新 -> 执行迁移；版本过新则拒绝
completeRun 写入失败 -> 事务回滚
进程异常退出 -> running 保留；后续按 lease 判断
```

## 7. 持久化 / 审计

SQLite 使用 WAL、foreign keys 和 busy timeout。`completeRun` 在一个事务中更新 run、插入消息并更新时间；`failRun` 在一个事务中写入失败状态和 Session 更新时间。运行事件既可通过 Agent 回调实时消费，也可按序追加到 `audit_events`；`Session.resume()` 继续使用同一个审计 sink。

## 8. 安全边界

- 数据库路径由 store 构造时规范化。
- 消息和结果 JSON 只保存结构化运行数据，不自动保存 API key。
- workspace root 在恢复时必须与当前工作区匹配。
- 文件 baseline 和大工具输出属于临时文件系统，不直接塞进 SQLite 消息表。

## 9. 设计原因

用 `SessionStore` 抽象隔离 Agent 与 SQLite，便于测试替身和未来存储替换；把消息按 Session 全局顺序保存，恢复时可以直接重建上下文；事务保证运行状态和消息不会出现半提交。

## 10. 当前边界

**已实现**结构化 Session/Run/Message、checkpoint、过期 run 恢复、工具幂等结果、迁移和独立 `audit_events`；**部分实现**审计查询 API 和跨设备恢复；**未实现**服务端 response id 的自动持久化及完整任务级恢复策略。

## 11. 相关测试

- `test/agent/sqlite-session-store.test.ts`
- `test/agent/session.test.ts`
