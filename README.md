# Coding Agent

一个原生 TypeScript coding agent，当前提供受限工作区操作、工具调用循环和 OpenAI-compatible 模型接入。项目不依赖 LangChain、LangGraph 等 Agent 框架。

## 快速开始

环境要求：Node.js 22+。

```bash
npm install
npm test
npm start -- "请检查这个项目"
```

开发时可使用 `npm start -- "请求"`；不带参数时会在 TTY 中进入持续对话 REPL。安装全局命令后使用 `veil "请求"`，当前终端目录会作为 workspace；输入 `veil` 可进入持续对话，输入 `exit` 或 `quit` 退出。非 TTY 环境必须显式提供请求参数。

全局安装：

```text
npm install -g .
veil --help
veil "分析当前目录并运行测试"
```

未配置真实模型时，CLI 使用不联网的 `EchoModel` 演示执行循环。

## 真实模型

`npm start` 会自动读取本机 `.env`。首次使用时复制模板：

```powershell
Copy-Item .env.example .env
```

然后填写一个支持 Chat Completions 和工具调用的云端 OpenAI-compatible 服务。下面以 OpenAI 风格 endpoint 为例，实际使用其他服务时替换三项配置：

```dotenv
CODING_AGENT_MODEL_PROVIDER=openai-compatible
CODING_AGENT_MODEL_PROTOCOL=chat-completions
CODING_AGENT_MODEL_BASE_URL=https://api.openai.com/v1
CODING_AGENT_MODEL=your-tool-capable-cloud-model
CODING_AGENT_MODEL_API_KEY=your-api-key
```

`CODING_AGENT_MODEL_PROTOCOL` 显式选择 `chat-completions` 或 `responses`，默认是 `chat-completions`；禁止根据响应内容自动猜测协议。`CODING_AGENT_MODEL_BASE_URL` 必须是服务的 API 根地址，`CODING_AGENT_MODEL` 必须是该服务实际提供的模型名，`CODING_AGENT_MODEL_API_KEY` 用于 Bearer 认证。API key 只写入本机 `.env`，不要提交到 Git。`CODING_AGENT_MODEL_TIMEOUT_MS` 和 `CODING_AGENT_MODEL_MAX_RESPONSE_BYTES` 可选，但必须是正整数。完整 `.env` 配置代表对该模型服务的会话级授权；写入和命令执行仍会在交互式终端中请求确认，非 TTY 环境默认拒绝这些副作用。

## 目录结构

```text
src/
  agent/  Agent 执行循环和公共类型契约
  tools/  工具、schema、workspace 边界和审批策略
  model/  模型审批、HTTP transport、provider adapter 和运行时配置
test/
  agent/  Agent 测试
  tools/  工具和安全测试
  model/  模型协议和 transport 测试
docs/
  feature-summary.md
  official-coding-agent-gap-analysis.md
```

## 文档

- [功能总结](docs/feature-summary.md)：当前已经实现的功能与模块职责。
- [总链路：用户请求到最终结果](docs/agent-flow-user-request.md)：Agent 主执行闭环、数据流、判断和异常分支。
- [Session 生命周期链路](docs/agent-flow-session.md)：多轮上下文、run 状态、lease 和恢复。
- [持久化与审计数据链路](docs/agent-flow-persistence.md)：SQLite 表数据、事务和恢复读取边界。
- [上下文预算链路](docs/agent-flow-context.md)：模型视图、压缩阶段、摘要和大输出引用。
- [工具安全与审批链路](docs/agent-flow-security.md)：manifest、capability、WorkspacePolicy、Approval 和 Fail Closed。
- [模型与网络请求链路](docs/agent-flow-model-network.md)：运行配置、模型审批、transport 和 provider 转换。
- [命令、测试与 Sandbox 链路](docs/agent-flow-sandbox-command.md)：结构化执行、Rust Helper、超时取消和隔离能力。
- [核心 Agent 能力路线图](docs/core-agent-roadmap.md)：Sandbox V2、Responses、MCP、仓库上下文、任务闭环、恢复和 Skills 的开发计划。
- [Run Diff 与工具输出链路](docs/agent-flow-diff-and-output.md)：工作区快照、unified diff 和 artifact 分页读取。
- [兼容性记录](docs/compatibility-notes.md)：真实模型验收中观察到的协议兼容性结果。
- [官方能力差距报告](docs/official-coding-agent-gap-analysis.md)：与 Claude Code、Codex CLI 的详细差距、证据和后续路线。
- [开发协作规范](AGENTS.md)：分支、测试、安全和提交要求。

## 功能更新日志

### 2026-09-12

- 增加 `OpenAIResponsesModel`，支持 Responses 请求格式、函数调用延续、`previous_response_id`，以及 SSE 文本和工具调用增量解析；协议必须通过显式配置选择。
- 增加本地 MCP stdio Server 管理：在工作区内发现并启动配置的 Server，读取工具清单并调用工具；MCP 调用统一经过 capability 声明、审批、sandbox 隔离和输出大小限制。
- 增加仓库上下文能力：沿 workspace 目录链加载 `AGENTS.md` 指令，生成 digest 和截断状态；新增只读 Git 状态/文件 diff 查询，并区分 Agent 本次改动与运行前已有改动。
- 强化命令 sandbox：Rust Helper 在 Windows 使用 Job Object、Restricted Token、句柄和网络限制，在 Linux 探测 namespace、`no_new_privs`、seccomp/cgroup 能力；无法证明隔离时 fail closed。
- CLI 现在会向模型注入受限仓库上下文，并继续只暴露读取、搜索、patch 和测试工具；通用 `run_command` 与未声明能力的 MCP 工具不会暴露给模型。

### 2026-09-08

- 增加 Session SQLite 持久化、run lease 和工作区匹配校验；已完成 run 可恢复上下文，过期的中断 run 可显式接管。
- 增加 run 内 checkpoint 与工具调用幂等键；恢复时复用已完成工具结果，未完成工具仍经过原审批策略后执行。
- 增加受限工具输出 artifact 存储和分页读取工具，避免把大型 stdout、stderr 或工具结果直接塞入模型上下文。
- 增加 token 上下文预算、主动压缩、历史摘要复用和摘要 checkpoint；保留最近轮次与完整 Session transcript。
- 增加多工具批次编排：只有显式声明可并行且不存在冲突键的调用才并发执行，结果仍按模型声明顺序回传。
- `ModelClient` 增加可选流式事件；OpenAI-compatible adapter 支持 Chat Completions SSE 的文本和工具调用增量，CLI 可实时显示文本与重试状态。
- 增加模型错误分类及有限重试/退避：只重试网络、超时、限流和服务端错误，支持 `Retry-After`；认证、取消、协议和资源限制错误不会重试。
- SQLite 新增 append-only `audit_events` 审计记录，保存 run 生命周期、模型尝试/重试、流式完成和工具批次摘要，不保存 API key、认证头、完整模型请求或无限工具输出。

### 2026-08-29

- 完成基础 coding agent 执行闭环，支持用户请求、模型调用、工具调用、工具结果回传和最终回答。
- 增加 `read_file`、`list_files`、`search_text`、`apply_patch`、`run_command` 和 `run_tests`，覆盖读取、搜索、修改、命令执行和测试验证。
- 增加 workspace realpath 边界、隐藏路径限制、文件和输出大小上限、命令超时、环境变量白名单以及子进程树终止。
- 工具通过 capability 和 Zod 输入 schema 统一校验；写入和命令执行在副作用前生成预览并请求审批，默认拒绝未批准操作。
- 建立供应商无关的 `ModelClient` 契约，增加受限 HTTP transport 和 `OpenAICompatibleModel`，支持文本与函数工具调用协议转换。
- 增加显式 `.env` 配置和 `ApprovedModelClient`，每次模型网络请求在发送对话或工具结果前都需要审批；未配置时保持不联网的 Echo 模式。
- 将生产代码按 `agent`、`tools`、`model` 分类，将测试代码独立放入 `test/`。
- CLI 只向模型开放读取、搜索、patch 和 `run_tests`，不开放通用 `run_command`；终端输出模型和工具调用摘要。
- 使用真实 OpenAI-compatible `glm-5.3` 在隔离仓库完成读取、两次修改、失败测试、修复和通过测试的手工验收，未发现需要修复的 adapter 兼容性问题。
- `Agent.run()` 汇总本次运行中由 `apply_patch`、命令或测试产生的文件变化；`veil` 终端只显示文件数量及新增/删除行数，完整 unified diff 仍保存在 Agent 结果中。
- 最终 diff 基于运行前后工作区快照，也能捕获命令或测试脚本产生的新增、修改和删除文件；默认忽略 `.git`、`node_modules` 和隐藏路径。
- 快照索引只保留路径、类型、大小、修改时间和 SHA-256；文本原始内容保存于带 `sessionId/runId` 的临时 baseline 目录，结束或异常时清理。
# Rust Sandbox Helper

安全命令执行的 Rust Helper 位于 `sandbox-helper/`。构建 release helper：

```text
npm run sandbox:build
```

TypeScript 通过 `RustHelperSandboxBackend` 完成 capability 握手，并把规范化的 `ExecutionRequest` 以 base64 JSON 传给 helper。helper 会重新校验 workspace、cwd、资源限制和 `network: off`，校验失败时拒绝启动目标进程。未声明 `os.isolation` 时，上层要求强隔离会 fail closed。
