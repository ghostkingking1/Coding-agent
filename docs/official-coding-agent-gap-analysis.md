# Coding Agent 官方能力差距报告

**基线**：v0.1 阶段一（2026-08-23）
**对象**：当前项目、Anthropic Claude Code、OpenAI Codex CLI
**证据原则**：只采用厂商官方产品文档、开发者文档和官方开源仓库；不采用评测文章、媒体报道或第三方营销材料。

## 结论

当前项目是可测试的最小循环：`user -> model -> tool calls -> tool results -> model`。已有模型接口、内存工具注册表、工具错误回传、最大步数和 `AbortSignal`，但还不是可安全使用的 coding agent：没有工作区工具、命令执行、审批、沙箱、持久会话、上下文预算、测试验证闭环或审计。

对齐顺序应是：

1. 受限工作区工具层。
2. 安全决策层和审批事件。
3. 读取、修改、测试、修复的任务闭环。
4. 流式输出、恢复、扩展协议和多会话。

## 官方来源

| ID | 来源 | 证据用途 |
| --- | --- | --- |
| A1 | [Claude Code overview](https://docs.anthropic.com/en/docs/claude-code/overview) | 产品定位和终端工作流 |
| A2 | [How Claude Code works](https://docs.anthropic.com/en/docs/claude-code/how-claude-code-works) | agent 循环、工具、上下文 |
| A3 | [Claude Code security](https://docs.anthropic.com/en/docs/claude-code/security) | 权限、隔离和风险 |
| A4 | [Claude Code MCP](https://docs.anthropic.com/en/docs/claude-code/mcp) | 工具扩展边界 |
| A5 | [Claude Code settings](https://docs.anthropic.com/en/docs/claude-code/settings) | 配置和权限入口 |
| A6 | [Anthropic 官方仓库](https://github.com/anthropics/claude-code) | 产品归属和公开仓库交叉核验 |
| O1 | [Codex documentation](https://developers.openai.com/codex) | 产品工作流入口 |
| O2 | [Codex security](https://developers.openai.com/codex/security) | sandbox 和审批入口 |
| O3 | [Codex execution policy](https://developers.openai.com/codex/exec-policy) | 命令策略入口 |
| O4 | [Codex configuration](https://developers.openai.com/codex/config-basic) | 配置和策略入口 |
| O5 | [Codex skills](https://developers.openai.com/codex/skills) | 模块化能力入口 |
| O6 | [Codex AGENTS.md](https://developers.openai.com/codex/guides/agents-md) | 仓库级指令入口 |
| O7 | [Codex 官方仓库](https://github.com/openai/codex) | CLI 定位及官方文档索引 |
| O8 | [Codex sandbox 索引](https://github.com/openai/codex/blob/main/docs/sandbox.md) | 官方 sandbox 文档入口 |
| O9 | [Codex exec policy 索引](https://github.com/openai/codex/blob/main/docs/execpolicy.md) | 官方执行策略文档入口 |

**证据等级**：A = 官方正文或官方仓库文件直接陈述；B = 官方入口可确认存在但本次环境未取得正文，只作为待复核方向；C = 本项目源码、测试和运行结果。本次环境对部分 Anthropic/OpenAI 页面出现重定向、403 或连接重置，未把未取得的默认值和内部实现写成事实。

## 当前实现基线（C 级）

| 能力 | 当前行为 | 位置 |
| --- | --- | --- |
| 模型 | `ModelClient.generate(request)` 返回包含可选 tool calls 的 assistant 消息 | `src/agent/types.ts` |
| 循环 | 每步生成；有调用则串行执行并回传；无调用即结束 | `src/agent/agent.ts` |
| 工具 | 进程内 `ToolRegistry`，按名称注册/查找/执行 | `src/tools/tool-registry.ts` |
| 错误 | 异常变成 `{ error }` tool 消息 | `src/agent/agent.ts` |
| 保护 | 默认最多 8 步；每步开始检查 `AbortSignal` | `src/agent/agent.ts` |
| 缺失 | 无文件、搜索、patch、终端、测试、持久化、审批、沙箱和审计 | 全局 |

已有测试覆盖直接完成、工具往返、未知工具恢复和最大步数；没有真实文件系统或命令执行测试。

## 核心执行差距

| 维度 | 官方证据 | 当前实现 | 差距 | 优先级 |
| --- | --- | --- | --- | --- |
| 多步执行 | A1/A2/O1 | 支持多步 tool calls | 无真实 provider、流式事件、重试、超时、状态机 | P0 |
| 工具编排 | A2/A4/O5 | 串行调用、无 schema | 无输入校验、并发规则、能力声明、超时 | P0 |
| 完成判定 | A2/O1 | 无 tool call 即停止 | 无测试/构建验证，可能未完成即结束 | P0 |
| Coding 工具 | A1/A2/O1 | 没有文件或终端工具 | 不能读取、修改、搜索、运行测试 | P0 |
| 反馈交互 | A1/O1 | 只有最终文本 | 无计划、增量输出、工具状态和审批请求 | P1 |
| 恢复 | A2/O1 | 只有内存消息 | 无 run id、checkpoint、断点恢复和幂等 | P1 |

## 安全差距

| 安全域 | Claude Code 官方入口 | Codex 官方入口 | 当前实现 | 对齐要求 |
| --- | --- | --- | --- | --- |
| 工作区边界 | A3/A5 | O2/O4/O8 | 无路径限制 | `realpath` 校验；越界和不安全符号链接拒绝 |
| 命令审批 | A3/A5 | O2/O3/O9 | 无命令工具、无审批 | 只读自动允许；写入和命令执行可配置确认 |
| 沙箱 | A3 | O2/O8 | 无沙箱 | 进程最小权限；按平台接 OS sandbox；cwd 限制不等于 sandbox |
| 网络 | A3 | O2/O3 | 无网络工具且无禁用策略 | 默认关闭；工具声明 `none/restricted/full` |
| 提示词注入 | A3/A4 | O2/O6 | 未区分用户、仓库文本、工具输出 | 标注来源；外部内容按不可信数据处理；高风险动作重新确认 |
| Secrets | A3 | O2/O4 | 无白名单和脱敏 | 环境白名单；日志脱敏；默认不放进上下文 |
| 审计 | A3/A5 | O2/O3/O4 | 无事件协议 | 记录 run、tool call、审批决定、命令摘要和 exit code |
| 中断/恢复 | A3 | O2 | 只在步开始检查 AbortSignal | 工具级取消、子进程树终止、超时和恢复前状态校验 |

当前版本不应接入真实终端后用于不受控仓库。`AbortSignal` 只提供取消，不提供权限、隔离或审批；工具错误回传也不等于安全审计。

## 路线图

### P0：安全可用的本地闭环

1. 定义 `ToolManifest`：输入 schema、只读/写入/执行类别、网络能力、路径和超时。
2. 实现 `WorkspacePolicy`：realpath、工作区外拒绝、符号链接、隐藏目录、大小限制。
3. 实现 `ApprovalPolicy`：执行前生成 `approval_required` 事件；只读默认允许，写入/命令可配置确认。
4. 实现 `read_file`、`list_files`、`search_text`，暂不允许网络和子进程。
5. 定义 `RunEvent`：`model_started`、`tool_requested`、`approval_required`、`tool_completed`、`run_finished`、`run_failed`。
6. 为越界、危险命令、取消、超时、输出上限补测试。

### P1：编码任务闭环

1. patch 工具：执行前 diff，执行后变更摘要。
2. 受限 `run_command`：显式 cwd、超时、环境白名单和 stdout/stderr 上限。
3. `run_tests`：结构化 exit code、stdout、stderr、duration；失败结果回传模型继续修复。
4. provider adapter、退避、流式输出和 token/cost 记录。

### P2：产品级能力

1. 持久 transcript、checkpoint、断点恢复和幂等工具调用。
2. 项目级指令文件，沿用 O6 的 AGENTS.md 方向和配置继承。
3. 外部工具协议和 skills，统一继承 capability/approval policy。
4. 多会话、并发任务、后台任务和管理员策略。

## 验收标准

- 工作区外任意路径读取、写入、删除均被拒绝。
- 未经审批的写入和命令执行不会发生；审批事件可重放。
- 命令超时能终止整个子进程树，不留下后台进程。
- 工具输出、日志敏感字段和模型上下文都有上限或脱敏测试。
- 真实任务能够完成“读取 -> 修改 -> 测试 -> 失败修复 -> 再测试”。
- 中断后从最后确认状态恢复，重复执行不会重复写入。
- 每个官方能力声明都回链到 A1-A6 或 O1-O9；未核实内容必须标注。

## 研究限制

本报告不比较模型分数、速度、价格或第三方评测。官方页面正文存在访问限制时，只引用官方页面入口或官方仓库索引；实现前应在可访问环境复核安全策略默认值、平台差异和版本变化。
