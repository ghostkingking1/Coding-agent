# Recovery Point 与执行恢复改造总结

## 1. 改造目标

本次改造的目标是把 Agent 的“可继续执行状态”和“工作区状态”组织成一套可以验证、持久化和恢复的统一机制：

1. 压缩后的活动上下文必须持久化，并在恢复时直接作为模型上下文使用，不能每次再把原始 transcript 拼接回来。
2. 运行 checkpoint 与 Context Checkpoint 使用统一的 SQLite `checkpoints` 表，避免两张表重复保存消息和产生数据漂移。
3. 每次工具完成后增量更新运行 checkpoint，保留当前消息上下文、工具结果 JSON、验证状态和任务状态。
4. 只有在执行成功且验证通过、上下文检查点和 Git 工作区 tree object 均成功创建时，才形成正式 Recovery Point。
5. Recovery Point 复用 Git 的 blob/tree 对象存储，但禁止创建 commit、分支、reset，禁止改变 HEAD、当前分支和用户 index。
6. 回滚操作以 Recovery Point 为唯一入口，同时恢复 Context Checkpoint 和对应的工作区 tree；非 Git 工作区不提供工作区回退。
7. Planner、Execute、Review、Reflection 之间通过结构化 artifact 协议传递结果，而不是共享隐藏 transcript。
8. Benchmark 的最终成功状态由外部 verifier 和安全事件共同裁决，不能由 Agent 自己的停止原因或模型声明替代。

本次实现聚焦于持久化、恢复、Git tree 快照和执行闭环；平台级沙箱纵深验证、多 Agent 并发恢复、远程 MCP/OAuth 等不属于本次 Recovery Point 主链的扩展范围。

## 2. 背景问题与设计取舍

### 2.1 原始 transcript 与活动上下文分离

Session 同时需要保存完整历史和提供受预算限制的模型上下文。完整 transcript 用于审计、统计和事实归档；活动上下文则可能经过摘要、裁剪和工具输出压缩，应该是下一轮模型及恢复流程的直接输入。

此前压缩主要停留在内存模型视图，恢复时仍可能重新装载原始消息并拼接尾部。这会造成：

- 已经被摘要覆盖的原始消息再次进入上下文；
- 每次压缩都重复处理相同历史；
- `coveredThroughSequence` 被误当成压缩数组下标；
- 工具调用中途崩溃时，已完成工具结果无法可靠区分和复用。

现在的约束是：完整 transcript 只写入 `messages` 归档表；当前活动上下文写入 `checkpoints.context_json`，恢复时直接加载 `resumeMessages`，不再拼接原始 transcript 尾部。`sourceMessageCount` 和序号游标只保留用于审计和一致性诊断。

### 2.2 为什么 Recovery Point 不使用 Git commit

用户工作区中的 Git 历史属于用户。Recovery Point 只需要一个可验证、可达、可恢复的文件树，不应污染用户提交历史。因此工作区版本采用：

```text
当前工作区
    ↓ git write-tree
Git blob/tree objects
    ↓ git update-ref
refs/veil/recovery/<recoveryPointId>
```

Recovery Point 数据库记录只引用 tree object 的 ID 和 ref，不保存文件内容，也不创建 commit object。

## 3. 总体设计

### 3.1 三层状态模型

```text
Session
 ├── 完整 messages transcript（审计归档）
 ├── active context checkpoint（模型恢复基线）
 └── Recovery Point 历史
      ├── frozen Context Checkpoint
      └── Git tree object/ref
```

运行 checkpoint 表示运行中断点；Context Checkpoint 表示当前压缩后的活动上下文；Recovery Point 表示一个已经验证完成、上下文和工作区同时可恢复的完整版本。

### 3.2 Recovery Point 生命周期

Recovery Point 采用准备态到提交态的两步状态：

```text
preparing
   ├── freeze active context checkpoint
   ├── create Git tree object
   ├── verify ref -> tree
   └── commit Recovery Point

失败 → aborted
回滚异常 → recovery_pending
成功 → committed
```

`sequence`、`previousRecoveryPointId` 只由 Recovery Point 管理。Context Checkpoint 和 Workspace tree 本身不再承担跨组件的版本链职责。

### 3.3 Git 工作区限制

Recovery Point 创建要求：

- workspace 本身是 Git 仓库根目录；
- 默认要求运行开始时工作区 clean，避免把用户已有修改误纳入 Agent 恢复点；
- Agent 本轮写入完成并通过验证；
- Git tree 和 ref 创建、校验都成功。

非 Git 工作区仍可使用 Session、Context Checkpoint 和 run 恢复，但不会创建支持工作区回退的 Recovery Point。

## 4. 模块改动

### 4.1 `src/agent/recovery-point.ts`

新增 `RecoveryPointCoordinator` 及相关类型：

- `RecoveryPoint`：记录 session、run、顺序、前一恢复点、Context Checkpoint ID 和 `WorkspaceRevision`；
- `WorkspaceRevision`：固定使用 `provider: "git-object-store"`、`objectType: "tree"`；
- `createForCompletedRun()`：验证运行资格，冻结上下文，创建 Git tree，最后提交 Recovery Point；
- `list()`、`current()`、`previous()`：按 Recovery Point 历史查询，previous 不再通过文件时间猜测；
- `rollback()`：验证目标、冻结上下文和 tree 后执行联合恢复；
- `rollbackPrevious()`：根据 `previousRecoveryPointId` 回退到前一个正式恢复点。

Git 创建或校验失败时，Recovery Point 标记为 `aborted`，并写入审计事件；不会生成 committed Recovery Point。

### 4.2 `src/repository/git.ts`

新增 Git object-store 能力：

- `createRecoveryTree()` 使用临时 `GIT_INDEX_FILE`；
- 从 `HEAD` 初始化临时 index，空仓库则从空 index 开始；
- `git add -A` 将当前工作区写入临时 index；
- `git write-tree` 创建 tree object；
- `git update-ref refs/veil/recovery/<id>` 保持 tree 可达；
- `git rev-parse <ref>^{tree}` 校验引用未漂移；
- `restoreRecoveryTree()` 使用临时 index、`read-tree` 和 `checkout-index` 恢复文件；
- 不调用 `git commit`、`commit-tree`、`branch`、`reset`，不改变 HEAD、当前分支或用户 index。

恢复前会列出当前受 Git 管理或未忽略的路径，并删除目标 tree 中不存在的文件；符号链接目标会被拒绝，避免通过路径逃逸影响工作区边界。

### 4.3 `src/agent/sqlite-session-store.ts`

SQLite schema 升级到 v10，并完成旧结构迁移：

#### 统一 `checkpoints` 表

核心字段为：

| 字段 | 用途 |
|---|---|
| `session_id` | 会话归属 |
| `run_id` | run checkpoint 使用；context checkpoint 为 `NULL` |
| `checkpoint_kind` | `run` 或 `context` |
| `checkpoint_state` | `active` 或 `frozen` |
| `step` / `phase` | run 的模型/工具执行位置；context 为 `NULL` |
| `context_json` | 消息上下文或 `resumeMessages` |
| `tool_results_json` | 当前 run 已完成工具结果集合 |
| `metadata_json` | 验证摘要、任务状态、摘要版本、游标和 hash 等元数据 |
| `updated_at` | 最近写入时间 |

运行 checkpoint 按 `run_id` 唯一；每个 Session 只允许一个 active context checkpoint。Context Checkpoint 被 Recovery Point 使用前，会复制成 `frozen` 行，保证后续增量更新不会改变历史恢复点。

#### Recovery Point 表

`recovery_points` 包含：

- `id`、`session_id`、`run_id`；
- `sequence` 和 `previous_recovery_point_id`；
- `context_checkpoint_id`；
- `workspace_root`、`workspace_revision_json`；
- `status`、`created_at`、`committed_at`。

`recovery_operations` 记录回滚操作的 owner、运行状态、失败原因和 `recovery_pending` 状态，用于避免把一次未完成恢复误认为成功。

#### 迁移策略

- v8 → v9：读取旧的 `checkpoints` 和 `context_checkpoints`，迁移到统一表；run 消息进入 `context_json`，工具结果进入 `tool_results_json`，上下文元数据进入 `metadata_json`，旧表随后删除；
- v9 → v10：增加 `checkpoint_state`，建立 `recovery_points` 和 `recovery_operations`；
- 迁移保留摘要、版本号、压缩策略版本和恢复消息，不将缓存表当作恢复事实来源。

### 4.4 `src/agent/agent.ts` 与 `context-manager.ts`

- 每次模型步骤保存 `phase=model` checkpoint；
- 每个工具结果提交后立即更新同一个 run checkpoint；
- `tool_results_json` 保存累计完成结果，恢复时只重放未完成调用；
- checkpoint 保存验证摘要和 `TaskState`，避免恢复后丢失“需要验证”“repairing”或“blocked”状态；
- 工具结果写入后立即压缩并调用 `persistContext`；
- `exportCheckpoint()` 始终输出可直接恢复的活动消息视图；
- `sourcePrefixHash` 基于当前活动视图计算，避免把压缩视图下标误当成原始 transcript 下标；
- `transcriptMessages` 与 `messages` 分离，前者用于完整归档，后者是模型当前上下文；
- 模型 usage、工具输入和流式事件增加到运行结果/事件中。

### 4.5 `src/agent/session.ts` 与 `session-manager.ts`

Session 现在负责：

1. 启动 run 时检查 Git 仓库及 clean 基线；
2. 为每个 run 建立 lease、heartbeat 和可恢复 checkpoint；
3. 成功完成后保存完整 transcript 增量，再保存活动 Context Checkpoint；
4. 验证通过后调用 `RecoveryPointCoordinator` 创建恢复点；
5. 提供 `listRecoveryPoints()`、`rollbackRecoveryPoint()` 和 `rollbackPreviousRecoveryPoint()`；
6. 重启时优先读取持久化活动上下文，不再拼接原始消息尾部；
7. 中断 run 进入 `/resume`，恢复时复用已完成工具结果。

### 4.6 CLI 与公共导出

`src/cli.ts` 新增：

- `/recovery list`
- `/recovery current`
- `/recovery rollback <id>`
- `/recovery rollback previous`

CLI 默认使用当前 workspace 的 `.veil/sessions.db`，支持 `CODING_AGENT_SESSION_DB` 覆盖路径；启动时会接管过期 run。`src/index.ts` 导出 Recovery Point、Agent Router、Benchmark 和相关公共类型。

### 4.7 角色路由与结构化协议

新增 `src/agent/agent-router.ts`：

- `AgentRouter` 根据请求风险、变更文件数、变更行数、工具失败、验证状态和 sandbox 失败决定角色；
- Planner 只在复杂或显式计划场景调用；Execute 是唯一默认角色；
- 大变更、高风险或验证异常时路由 Review；
- 多次修复、大范围变更或 sandbox/验证异常时产生 Reflection 候选；
- Review 的 `needs_repair` 会真实回到 Execute，修复后再次 Review；
- 不会因为执行失败重新触发 Planner。

角色结果采用独立协议：

- `PlanArtifact`：版本化计划；
- `ExecutionArtifact`：AgentResult、工具调用数、失败数和修复次数；
- `ReviewArtifact`：`pass`、`needs_repair` 或 `blocked`，并带有结构化 findings；
- `ReflectionArtifact`：是否值得沉淀、总结和可复用策略。

Review 和 Reflection 使用 Zod 严格校验。协议解析失败会抛出 `RoleProtocolError`，不会将自然语言或缺失字段默认解释为通过。

### 4.8 Skills 安全改动

Skills 目录从“按请求模糊匹配”调整为“列出已验证 metadata、显式读取和 digest 校验”：

- `list_skills` 只返回合法 Skill 的元数据、digest、触发器、标签和 capability 声明；
- `read_skill` 在同一次读取中校验 digest，避免发现和读取之间的 TOCTOU；
- 新增 `verify()` 和 `SkillVerification`；
- Skill 内容仍是不可信指导，不能授予工具权限。

### 4.9 Benchmark 与外部验证

新增 `src/benchmark/*` 和 `npm run benchmark`：

- fixture、verification 和 Agent 工作区隔离；
- fixture 使用 SHA-256 digest，拒绝符号链接和越界路径；
- 每个任务有 Node/platform、时间、步骤和 diff 约束；
- 强制要求 sandbox capability；
- 保存 trajectory、audit、security events、diff 和外部 verifier 结果；
- 成功必须同时满足外部检查全部通过、未超时且无安全事件；
- Agent 的 `stopReason`、`taskState` 和模型自述只作为诊断信息。

## 5. 关键执行与恢复流程

### 5.1 正常执行

```text
Session.run
  → 创建/续租 run
  → 检查 Git 恢复资格
  → Agent 模型调用
  → 工具执行并逐个持久化结果
  → 压缩并持久化活动上下文
  → 保存完整 transcript 增量
  → 验证通过
  → freeze Context Checkpoint
  → git write-tree + update-ref
  → 校验 tree
  → commit Recovery Point
```

任何 Git tree 创建或校验失败都只会中止 Recovery Point，不会把已经成功完成的 Agent run 判定为失败。

### 5.2 回滚

```text
rollback(recoveryPointId)
  → 检查 Recovery Point 为 committed
  → 检查 frozen Context Checkpoint 存在
  → 建立 recovery_operation
  → 校验 ref 指向预期 tree
  → 恢复工作区 tree
  → 激活对应 Context Checkpoint
  → 标记 operation committed
```

如果工作区恢复或上下文激活失败，操作会标记为 `recovery_pending` 并抛出错误，不会伪造成功状态。Recovery Point 历史仍由数据库中的 sequence 和 previous ID 管理。

## 6. 安全边界与数据一致性

- 临时 index 位于系统临时目录，避免修改用户 index；
- Git 子进程使用固定 argv、关闭 hooks，并限制输出大小；
- Recovery ID 经过字符集和长度校验；
- workspace root 必须与 Git repository root 一致；
- 回滚前校验 tree ref、object ID、仓库根目录和对象类型；
- active/frozen 状态区分可更新上下文与不可变恢复历史；
- run lease、owner 和 heartbeat 防止多进程同时执行同一 Session；
- 工具输出有大小上限，超大结果转入 ToolOutputStore；
- 审计事件不保存 API key、认证头或无限大小的模型/工具载荷。

## 7. 潜在风险与当前限制

1. Git tree 恢复只恢复工作区文件，不移动 HEAD、不改变分支，也不会恢复用户未纳入 tree 的 Git 元数据。
2. Recovery Point 创建依赖持久化 Session、有效 Git 仓库、运行开始时的 clean 条件和验证工具通过；普通内存 Session 不支持 Recovery Point。
3. Git ref 和 SQLite 不是同一个事务。若 tree/ref 已创建而 SQLite 提交失败，可能留下未被数据库引用但可通过 ref 找到的对象；对象不会影响用户提交历史，后续仍需要清理/审计策略。
4. 回滚涉及文件系统和 SQLite 两个系统；`recovery_pending` 能记录不确定状态，但当前没有完整的进程重启自动补偿协议。
5. 运行完成后 Recovery Point 创建失败不会让 Agent run 失败，因此调用方必须查看 `AgentResult.recoveryPoint` 或审计事件确认是否真正形成恢复点。
6. 原有 `WorkspaceCheckpointManager` 的 CAS/storageRoot 能力仍保留为独立旧能力，没有接入 Recovery Point 主链，也不能与 Git tree 恢复点混用。
7. Context Checkpoint 仍保留摘要段、游标和 hash 等诊断字段；这些字段用于一致性检查和审计，不应再次被实现为“拼接原始 transcript”的恢复逻辑。
8. Review/Reflection 协议目前是结构化解析和编排基础，尚未扩展为跨进程持久化的角色历史数据库。

## 8. 测试与验证

本次实现新增或扩展了以下验证：

- `test/repository/git-recovery.test.ts`：验证 tree object 创建、ref 可达、无用户 commit、HEAD/分支/index 不变，以及 tree 恢复工作区；
- `test/agent/sqlite-session-store.test.ts`：验证统一 checkpoint 表、context/tool JSON 分离、旧 schema 迁移、压缩上下文跨重启恢复，以及 Context Checkpoint 与 Git tree 的 Recovery Point 绑定；
- `test/agent/agent.test.ts`：验证逐工具 checkpoint、工具结果复用、验证状态恢复和中断恢复；
- `test/agent/agent-router.test.ts`：验证角色路由、结构化协议和 Review → Execute 修复循环；
- `test/benchmark/benchmark.test.ts`：验证 fixture 隔离、digest、外部 verifier 和安全事件裁决；
- Skill 与 CLI 测试覆盖 digest 校验、Session 数据库、Recovery 命令和结构化输出。

当前已完成的验证结果：

- `npm test`：223/223 通过；
- `npx tsc --noEmit`：通过；
- 本次目标修改范围 `git diff --check`：通过。

全局工作区仍包含其他历史未提交文件；这些文件应继续按用户已有修改处理，不应通过 reset、checkout 或清理命令覆盖。
