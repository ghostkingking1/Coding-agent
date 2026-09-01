# Coding Agent

一个原生 TypeScript coding agent，当前提供受限工作区操作、工具调用循环和 OpenAI-compatible 模型接入。项目不依赖 LangChain、LangGraph 等 Agent 框架。

## 快速开始

环境要求：Node.js 22+。

```bash
npm install
npm test
npm start -- "请检查这个项目"
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
CODING_AGENT_MODEL_BASE_URL=https://api.openai.com/v1
CODING_AGENT_MODEL=your-tool-capable-cloud-model
CODING_AGENT_MODEL_API_KEY=your-api-key
```

`CODING_AGENT_MODEL_BASE_URL` 必须是服务的 API 根地址，`CODING_AGENT_MODEL` 必须是该服务实际提供的模型名，`CODING_AGENT_MODEL_API_KEY` 用于 Bearer 认证。API key 只写入本机 `.env`，不要提交到 Git。`CODING_AGENT_MODEL_TIMEOUT_MS` 和 `CODING_AGENT_MODEL_MAX_RESPONSE_BYTES` 可选，但必须是正整数。真实模型请求、写入和命令执行都需要交互式确认；非 TTY 环境默认拒绝这些操作。

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
- [兼容性记录](docs/compatibility-notes.md)：真实模型验收中观察到的协议兼容性结果。
- [官方能力差距报告](docs/official-coding-agent-gap-analysis.md)：与 Claude Code、Codex CLI 的详细差距、证据和后续路线。
- [开发协作规范](AGENTS.md)：分支、测试、安全和提交要求。

## 功能更新日志

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
- `Agent.run()` 汇总本次运行中由 `apply_patch` 成功写入的文件，结束时返回带文件名和上下文的最终 unified diff。
- 最终 diff 基于运行前后工作区快照，也能捕获命令或测试脚本产生的新增、修改和删除文件；默认忽略 `.git`、`node_modules` 和隐藏路径。
- 快照索引只保留路径、类型、大小、修改时间和 SHA-256；文本原始内容保存于带 `sessionId/runId` 的临时 baseline 目录，结束或异常时清理。
