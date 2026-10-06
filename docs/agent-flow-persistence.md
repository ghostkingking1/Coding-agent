# Session 持久化与审计数据链路

## 1. 目标

把 Session、Run、原始归档和活动上下文保存为可查询的结构化记录，使进程重启后能够直接恢复压缩后的上下文并解释运行结果。

## 2. 整体流程

```text
Session.initialize -> sessions
Session.run        -> startRun -> runs(running)
工具完成           -> ContextCheckpoint 增量更新活动上下文
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

保存 Session 内按 `sequence` 排序的原始消息归档。它用于审计和结果解释，不再作为下一轮模型上下文的拼接源。除 `role` 和 `content` 外，tool 消息保存 `tool_call_id/tool_name`，assistant 消息保存 `tool_calls_json`。

### `checkpoints`

统一保存运行恢复 checkpoint 和会话活动上下文 checkpoint。`checkpoint_kind='run'` 时，`context_json` 保存运行恢复所需的当前上下文，`tool_results_json` 保存工具输出 JSON；`checkpoint_kind='context'` 时，`context_json` 保存唯一活动上下文，`metadata_json` 保存摘要段、版本和原始归档关联信息。旧的 `context_checkpoints` 表由 schema v9 迁移后删除。

活动上下文每次工具完成后都会增量更新；`messages` 原始归档和 checkpoint 上下文不再互相拼接。

### `summary_cache`

仅用于避免重复计算摘要的性能缓存。缓存失效或写入失败不能阻断活动上下文保存，也不能承担恢复职责。

### `audit_events`

保存事件序号、Session/Run 关联、事件类型、时间和受限 JSON 摘要。记录 run 生命周期、模型尝试/重试、流式完成、工具批次和 sandbox 执行结果；不保存 API key、认证头、完整模型请求或无限工具输出。

### `schema_migrations`

保存数据库 schema 版本，当前 schema version 为 9。

## 5. 关键决策

- 成功 run 的运行记录和原始归档消息必须在同一事务提交；活动上下文由工具完成后的 checkpoint 独立持久化。
- `sequence` 在 Session 内唯一，恢复按序读取。
- `messages` 是审计归档，不是模型上下文 source of truth；恢复只读取统一 `checkpoints` 表中 `checkpoint_kind='context'` 的 `context_json`。
- schema 版本高于当前支持版本时拒绝打开数据库。
- 过期 lease 才能被恢复流程标记为 interrupted。

## 6. 异常流程

```text
重复 Session ID -> 主键约束失败
数据库 schema 更新 -> 执行迁移；版本过新则拒绝
completeRun 写入失败 -> 事务回滚
进程异常退出 -> running 保留；后续按 lease 判断；最近一次活动上下文 checkpoint 可直接用于恢复
```

## 7. 持久化 / 审计

SQLite 使用 WAL、foreign keys 和 busy timeout。`completeRun` 在一个事务中更新 run、插入消息并更新时间；`failRun` 在一个事务中写入失败状态和 Session 更新时间。运行事件既可通过 Agent 回调实时消费，也可按序追加到 `audit_events`；`Session.resume()` 继续使用同一个审计 sink。

## 8. 安全边界

- 数据库路径由 store 构造时规范化。
- 消息和结果 JSON 只保存结构化运行数据，不自动保存 API key。
- workspace root 在恢复时必须与当前工作区匹配。
- 文件 baseline 和大工具输出属于临时文件系统，不直接塞进 SQLite 消息表。

## 9. 设计原因

用 `SessionStore` 抽象隔离 Agent 与 SQLite，便于测试替身和未来存储替换；把原始消息和活动上下文分成两种语义，避免压缩后的模型视图与审计归档互相污染；事务保证运行状态和归档消息不会出现半提交。

## 10. 当前边界

**已实现**结构化 Session/Run/Message、活动上下文 checkpoint、工具完成后的增量持久化、过期 run 恢复、工具幂等结果、迁移和独立 `audit_events`；**部分实现**审计查询 API 和跨设备恢复；**未实现**服务端 response id 的自动持久化及完整任务级恢复策略。

## 11. 相关测试

- `test/agent/sqlite-session-store.test.ts`
- `test/agent/session.test.ts`
