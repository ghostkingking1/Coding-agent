# Coding Agent 官方能力差距报告

**基线**：P0 真实模型闭环与 Agent run diff 汇总完成（2026-08-30）
**对象**：当前项目、Anthropic Claude Code、OpenAI Codex CLI
**证据原则**：只采用厂商官方产品文档、开发者文档和官方开源仓库；不采用评测文章、媒体报道或第三方营销材料。

## 结论

当前项目已具备受限本地 coding 闭环：`user -> model -> tool calls -> tool results -> model`。它包含工作区边界校验、读取/patch/命令/测试工具、输入 schema、审批、资源限制、OpenAI-compatible adapter、模型网络审批、CLI 运行摘要和 Agent run 最终 diff 汇总。已用真实 OpenAI-compatible 模型完成一次隔离仓库的读取、修改、测试失败、修复和测试通过验收。它仍不是产品级 coding agent：没有流式交互、持久审计、上下文预算、恢复、平台 sandbox 或多供应商实现。

对齐顺序应是：

1. 流式事件、有限重试和持久化审计。
2. 上下文预算、checkpoint、恢复与幂等。
3. 平台 sandbox、扩展协议、多供应商和多会话。

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
| 工作区工具 | `read_file`、`list_files`、`search_text`、`apply_patch` | `src/tools/workspace-tools.ts`、`src/tools/patch-tools.ts` |
| 命令与测试 | 受限 `run_command`、结构化 `run_tests`；超时、输出上限、环境白名单和子进程终止 | `src/tools/command-tools.ts`、`src/tools/test-tools.ts` |
| 工具安全 | Zod 输入校验、模型 JSON Schema、capability、workspace realpath 与写入/执行审批 | `src/tools/` |
| 模型接入 | 统一契约、受限 HTTP transport、OpenAI-compatible adapter、显式配置和逐次网络审批 | `src/model/` |
| CLI | 注册读取、搜索、patch 和 `run_tests`，不暴露 `run_command`；输出模型和工具摘要 | `src/cli.ts` |
| 真实验收 | `glm-5.3` 完成读取、两次 patch、失败测试和通过测试 | `docs/compatibility-notes.md` |
| 运行 diff | 以内存元索引和磁盘 baseline 对工作区建立前后快照，在运行结束时汇总 patch、命令和测试脚本产生的新增、修改、删除和二进制文件变化 | `src/agent/run-diff.ts`、`src/agent/agent.ts` |
| 缺失 | 流式输出、持久化、上下文预算、恢复、平台 sandbox 和审计记录 | 全局 |

现有测试覆盖 Agent 循环、CLI 工具注册与运行摘要、工具输入校验、workspace 越界、patch 审批、命令与测试超时/取消、transport 限制，以及模型审批和协议转换。真实模型验收为手工测试，不作为自动化测试运行，避免要求测试环境提供 API key。

## 核心执行差距

| 维度 | 官方证据 | 当前实现 | 差距 | 优先级 |
| --- | --- | --- | --- | --- |
| 多步执行 | A1/A2/O1 | 支持串行 tool calls、最大步数和取消 | 无流式事件、重试、状态机、并行规则 | P1 |
| 工具编排 | A2/A4/O5 | capability、Zod 校验、模型 JSON Schema、审批和超时 | 无并行调度、外部工具协议、持久审计 | P1 |
| 完成判定 | A2/O1 | 可由 `run_tests` 返回结构化结果并继续回传模型 | 无任务级验证策略，模型仍可在未验证时结束 | P1 |
| Coding 工具 | A1/A2/O1 | 可读取、搜索、patch、运行受限命令和测试 | 无复杂编辑、依赖安装策略、网络工具和平台 sandbox | P1 |
| 反馈交互 | A1/O1 | CLI 逐次请求模型网络与副作用确认，并显示模型开始、工具请求、完成或失败摘要 | 无流式文本、计划视图和终端 UI | P1 |
| 恢复 | A2/O1 | 只有内存消息 | 无 run id、checkpoint、断点恢复和幂等 | P1 |

## 安全差距

| 安全域 | Claude Code 官方入口 | Codex 官方入口 | 当前实现 | 对齐要求 |
| --- | --- | --- | --- | --- |
| 工作区边界 | A3/A5 | O2/O4/O8 | `realpath`、workspace 外拒绝、隐藏路径和文件/条目上限 | 增加写入原子性和平台 sandbox；cwd 限制不等于 sandbox |
| 命令审批 | A3/A5 | O2/O3/O9 | `execute` capability、预览、逐次确认、cwd/环境/输出/超时限制 | 风险分级、可配置策略继承和平台隔离 |
| 沙箱 | A3 | O2/O8 | 无 OS 级 sandbox | 进程最小权限；按平台接 OS sandbox |
| 网络 | A3 | O2/O3 | 模型请求显式配置且逐次审批；未开放通用网络工具 | 默认关闭；工具声明 `none/restricted/full` |
| 提示词注入 | A3/A4 | O2/O6 | 未区分用户、仓库文本、工具输出 | 标注来源；外部内容按不可信数据处理；高风险动作重新确认 |
| Secrets | A3 | O2/O4 | 无白名单和脱敏 | 环境白名单；日志脱敏；默认不放进上下文 |
| 审计 | A3/A5 | O2/O3/O4 | 有运行事件和审批回调，但不持久化 | 记录 run、tool call、审批决定、命令摘要和 exit code |
| 中断/恢复 | A3 | O2 | 取消传播、命令子进程树终止和模型/命令超时 | checkpoint、恢复前状态校验和幂等调用 |

当前版本可在明确审批下用于受控本地仓库的实验性闭环，但不应把 cwd 限制误认为 OS sandbox，也不应在不受控仓库中开放更多网络或命令能力。工具错误回传和审批回调不等于持久安全审计。

## 路线图

### P0：真实闭环验收（已完成）

1. 已使用已授权 OpenAI-compatible `glm-5.3` 配置。
2. 已在隔离 scratch 仓库手工验证“读取 -> patch -> run_tests -> 失败修复 -> 再测试”。
3. 已记录 provider 兼容性结果；本次无需 adapter 修复。
4. CLI 已输出模型和工具的可读运行摘要。

### P1：可观测性与可靠性

1. 增加流式模型事件和 CLI 工具状态显示。
2. 为可重试的模型错误加入有次数和预算上限的退避策略。
3. 持久化 run、tool call、审批决定、命令摘要和 exit code，形成最小审计记录。
4. 引入 token/字符预算、上下文摘要和每次运行的总体 deadline。

### P2：恢复与扩展

1. 在持久运行记录上实现 checkpoint、恢复和幂等工具调用。
2. 按实际兼容需求增加 Anthropic 与 OpenAI Responses adapter；保持 `ModelClient` 契约稳定。
3. 接入外部工具协议和 skills，并统一继承 capability/approval policy。
4. 增加平台 sandbox、网络策略、多会话、并发任务和管理员策略。

## 验收标准

- 已验收：真实模型在隔离测试仓库完成一次“读取 -> 修改 -> 测试 -> 失败修复 -> 再测试”。
- 每次模型网络请求、写入和命令执行在副作用前均有可读审批信息。
- 工作区外任意路径读取、写入、删除均被拒绝；命令超时能终止整个子进程树。
- 对模型响应、命令 stdout/stderr 和工具结果的资源上限均有测试。
- 流式、审计、恢复和 sandbox 功能完成前，不将其描述为已对齐成熟 Agent。
- 每个官方能力声明都回链到 A1-A6 或 O1-O9；未核实内容必须标注。

## 研究限制

本报告不比较模型分数、速度、价格或第三方评测。官方页面正文存在访问限制时，只引用官方页面入口或官方仓库索引；实现前应在可访问环境复核安全策略默认值、平台差异和版本变化。
