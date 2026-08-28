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

然后填写一个支持 Chat Completions 和工具调用的 OpenAI-compatible 服务：

```dotenv
CODING_AGENT_MODEL_PROVIDER=openai-compatible
CODING_AGENT_MODEL_BASE_URL=http://127.0.0.1:11434/v1
CODING_AGENT_MODEL=your-tool-capable-local-model
```

`CODING_AGENT_MODEL_API_KEY` 可选；`CODING_AGENT_MODEL_TIMEOUT_MS` 和 `CODING_AGENT_MODEL_MAX_RESPONSE_BYTES` 也可选，但必须是正整数。真实模型请求、写入和命令执行都需要交互式确认；非 TTY 环境默认拒绝这些操作。

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
