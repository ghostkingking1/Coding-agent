# 用户请求到最终结果链路

## 1. 目标

这条链路负责把用户的一次 coding 请求转换为可执行的 Agent run，并在需要时完成文件读取、代码修改和测试反馈，最后返回模型回答以及本次运行检测到的工作区变更。

当前实现是受限的单 Agent 闭环：模型负责决定下一步是否调用工具，Agent 负责驱动循环，工具注册表和安全策略负责控制副作用。

## 2. 整体流程

```text
用户输入
  -> CLI 或 Session
  -> Agent.run()
  -> 组装完整消息上下文
  -> ContextManager 生成模型上下文
  -> ModelClient.generate()
  -> 返回 assistant 文本或 tool calls
       |                     |
       | 无 tool call         | 有 tool call
       v                     v
  最终回答             ToolRegistry 执行工具
                              |
                              v
                       tool result 消息
                              |
                              └──── 回到下一轮模型请求

最终结果 = finalText + messages + steps + stopReason + 可选 RunDiff
```

一次 run 最多执行 `maxSteps` 轮模型请求。模型没有返回工具调用时正常结束；模型返回工具调用时，Agent 逐个执行并把结果加入消息上下文，然后继续请求模型。

## 3. 核心模块

| 模块 | 责任 | 调用关系 |
| --- | --- | --- |
| CLI | 读取用户输入、创建工作区和模型、输出事件与结果 | 调用 `Agent` 或 `Session` |
| Session | 在多次 run 之间保存对话上下文和运行历史 | 调用 `Agent`，可调用 `SessionStore` |
| Agent | 驱动模型和工具之间的有限循环 | 调用 `ContextManager`、`ModelClient`、`ToolRegistry` |
| ContextManager | 在不修改完整 transcript 的前提下压缩模型视图 | 被 Agent 调用 |
| ModelClient | 将统一请求交给具体模型，并返回标准化响应 | 被 Agent 调用 |
| ToolRegistry | 查找工具、校验输入、执行授权策略和工具 | 被 Agent 调用 |
| SecurityPolicy | 检查 capability，生成预览并请求审批 | 被 ToolRegistry 调用 |
| RunChangeTracker | 比较 run 前后的工作区快照并生成 diff | 由 Agent/Session 管理 |
| SessionStore | 持久化 Session、Run 和已提交消息 | 由 Session 调用 |

当前没有独立的 Planner 或 Reviewer。任务规划、工具选择和完成判断主要由模型输出与系统提示共同完成。

## 4. 数据流

### 4.1 入口数据

CLI 将用户输入整理为非空字符串。Session 模式下，每一行输入对应一个新的 run；程序化调用可以直接调用 `Agent.run(input)`。

创建 run 时会确定：

- `sessionId`：所属会话标识，可为空于无 Session 的单次运行。
- `runId`：本次运行标识。
- `initialMessages`：Session 已提交的历史消息。
- `systemPrompt`：可选的系统约束和工作区说明。
- `maxSteps`、`contextBudget`、取消信号和变更跟踪器。

### 4.2 Agent 内部消息

Agent 维护一份完整 transcript，消息角色包括：

| 消息 | 产生方 | 作用 |
| --- | --- | --- |
| `system` | Agent | 提供工作区、工具和行为约束 |
| `user` | CLI / Session | 保存当前用户请求 |
| `assistant` | ModelClient | 保存模型文本和原始 tool calls |
| `tool` | ToolRegistry / Agent | 保存工具成功结果或结构化错误 |

完整 transcript 是运行事实记录。每轮请求模型前，ContextManager 从它生成一个可能被截断、折叠或摘要的模型视图；模型视图不会覆盖原始消息。

### 4.3 模型响应

`ModelClient.generate()` 接收：

- 当前模型视图 `messages`
- 已声明 `modelInputSchema` 的工具定义
- 可选 `AbortSignal`
- 可选 `ContextResult`

模型返回标准化的 `ModelResponse`，其中包含 assistant 消息、可选结束原因和用量信息。Agent 将 assistant 消息先写入完整 transcript，再检查其中是否存在 tool calls。

### 4.4 工具结果

每个 tool call 至少携带 `id`、`name` 和 `input`。工具执行结果会序列化为字符串并写入 `ToolMessage`，同时保留 `toolCallId` 和 `toolName`，确保下一轮模型可以关联调用与结果。

## 5. 关键决策

### 决策一：输入是否有效

- 条件：输入去除空白后为空。
- 结果：立即失败，不启动模型、工具或快照。
- 原因：避免产生无意义的 run 和不可解释的模型请求。

### 决策二：是否压缩上下文

- 条件：完整 transcript 的估算 token 数超过配置预算。
- 结果：依次尝试工具输出截断、文本压缩、工具链折叠、保留最近轮次和历史摘要。
- 仍超预算：当前请求失败，不能带着超过硬预算的上下文发送给模型。
- 原因：保留完整运行事实，同时控制发送给模型的资源规模。

### 决策三：模型是否请求工具

- 无 tool calls：当前 run 进入 `completed`，assistant content 成为 `finalText`。
- 有 tool calls：逐个进入工具执行链，完成后继续下一轮模型请求。
- 达到 `maxSteps`：停止循环，返回 `stopReason = max_steps`，不再启动新的模型请求。

### 决策四：工具是否允许执行

- 工具不存在：生成工具错误消息，不执行任何副作用。
- 输入 schema 不通过：在审批和执行前失败，避免非法参数触发预览或副作用。
- 工具仅声明 `read`：默认允许。
- 工具包含 `write`、`execute` 或 `network`：先生成预览并请求审批；拒绝时不执行工具。

### 决策五：运行结果是否提交到 Session

- Agent 成功完成：Session 提交本次新增消息和完成结果。
- Agent 失败或被取消：Session 记录失败 run，但不提交部分消息到下一轮上下文。
- 原因：避免半截 transcript 被误认为已经完成的事实，也避免恢复时重放副作用。

## 6. 异常流程

```text
模型请求失败 / 取消 / 超时
  -> 发出 run_failed
  -> Session 记录 failed run
  -> 不提交本次部分上下文

工具输入非法 / 工具不存在 / 工具执行异常
  -> 发出 tool_failed
  -> 转换为 { error } 的 ToolMessage
  -> 模型决定是否修复或结束

Approval 拒绝
  -> 工具不执行
  -> 转换为工具错误消息
  -> 模型获得拒绝原因

达到 maxSteps
  -> 结束循环
  -> 返回 max_steps
  -> 生成当前可获得的 RunDiff
```

命令工具额外处理超时和取消：终止子进程树，并在允许的平台上补发强制终止信号。模型网络请求由 HTTP transport 处理超时、取消、HTTP 错误、JSON 解析错误和响应大小限制。当前没有通用模型重试和退避策略。

## 7. 持久化 / 审计

无 Session 的单次 Agent run 主要通过返回值和运行事件提供结果；使用 SessionStore 时，持久化边界如下：

```text
startRun
  -> runs.status = running
  -> Agent 执行
  -> completeRun 事务
       runs.status = completed
       写入本次新增 messages
       更新 sessions.updated_at
```

失败路径使用 `failRun` 保存错误和结束时间。进程退出或 lease 过期时，running run 会被标记为 `interrupted`。恢复只读取已提交的 `messages`，不会重放历史工具调用。

当前 SQLite 结构包含：

- `sessions`：会话身份、工作区根目录、生命周期状态和时间戳。
- `runs`：每次请求的输入、状态、最终文本、错误、结果 JSON 以及 owner/lease 信息。
- `messages`：Session 内按 `sequence` 排序的完整消息；assistant tool calls 和 tool 关联字段分别保存。
- `schema_migrations`：数据库 schema 版本。

运行事件包括 `model_started`、`tool_requested`、`tool_completed`、`tool_failed`、`run_finished` 和 `run_failed`。这些事件当前通过回调提供，尚未独立写入审计事件表。

## 8. 安全边界

- 工作区路径统一经过 `WorkspacePolicy`，先解析 realpath，再检查是否越界、是否为隐藏路径以及是否超过文件/条目限制。
- 工具输入先经过 Zod schema，再进入预览、审批和执行阶段。
- capability 是副作用判断依据；未声明 manifest 的工具默认拒绝。
- 写入和命令执行必须在副作用前审批；默认策略拒绝未批准操作。
- 模型网络请求也必须审批，因为对话和工具结果可能包含仓库内容。
- 命令使用受限 cwd、环境变量白名单、超时和 stdout/stderr 大小限制；CLI 不向模型暴露通用 `run_command`。
- RunDiff 默认忽略 `.git`、`node_modules` 和隐藏路径，并限制快照文件数、单文件大小、总快照大小和 diff 输出大小。

这里的安全边界是应用层策略，不等同于 OS 级 Sandbox。当前实现不会把 cwd 限制描述成进程隔离。

## 9. 设计原因

- **模型与 Agent 分离**：统一 `ModelClient` 契约，使 EchoModel、OpenAI-compatible 模型和测试替身共享同一执行循环。
- **完整 transcript 与模型视图分离**：压缩上下文不会破坏恢复、审计和工具调用关联所需的原始消息。
- **工具统一进入 ToolRegistry**：把名称查找、输入校验和授权顺序固定下来，避免某个调用路径绕过安全策略。
- **副作用先预览后审批**：用户可以在文件写入、命令执行前看到即将发生的操作，审批拒绝时没有副作用。
- **失败结果回传模型**：单个工具失败不会立即丢失整个对话，模型可以根据错误继续修复；但 Session 不提交失败 run 的部分上下文，防止失败状态污染后续运行。
- **run 前后快照生成 diff**：不仅能捕获 patch 工具写入，也能发现命令或测试脚本产生的文件变化；不依赖 Git 当前状态，因此不会混入运行前已有修改。

## 10. 当前边界

这条链路已经覆盖“请求、模型、工具、测试反馈、最终结果”的基础闭环，但以下节点尚未独立实现：

- Planner 或任务 DAG
- 独立 Reviewer / 自动代码审查阶段
- Git 专用工具和提交流程
- OS 级 Sandbox
- 模型请求重试、退避和更细粒度恢复
- 持久化运行事件审计

相关能力应在现有 `Agent`、`ToolRegistry`、`SessionStore` 和安全策略契约稳定后再扩展。

## 11. 相关实现与测试

- 执行循环：`src/agent/agent.ts`
- 上下文管理：`src/agent/context-manager.ts`
- Session 与恢复：`src/agent/session.ts`、`src/agent/session-manager.ts`
- SQLite 持久化：`src/agent/sqlite-session-store.ts`
- 工具注册与安全：`src/tools/tool-registry.ts`、`src/tools/security.ts`
- CLI 入口：`src/cli.ts`
- Agent 测试：`test/agent/agent.test.ts`、`test/agent/session.test.ts`
- 工具和安全测试：`test/tools/`
- 模型和 transport 测试：`test/model/`

