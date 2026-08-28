# Coding Agent

这是一个原生 TypeScript coding agent，不依赖 LangChain、LangGraph 等 Agent 框架。当前已具备受限的读取、修改、命令、测试和模型调用链路，目标是逐步对齐 Claude Code 与 Codex CLI 的能力边界和安全实践。

## 快速开始

环境要求：Node.js 22+。

```bash
npm start -- "请检查这个项目"
npm test
```

CLI 未配置模型时使用内置 `EchoModel` 演示运行链路。模型调用统一经过 `ModelClient.generate(request)`：provider adapter 负责协议转换，工具分别声明给模型的 JSON Schema 和本地 Zod 校验，后者仍是执行前不可绕过的安全检查。

`FetchHttpTransport` 为 provider adapter 提供统一的 HTTP 超时、取消、响应大小限制、错误分类和 JSON 解析；`ApprovedModelClient` 在每次可能上传对话或工具结果的请求前完成网络审批。

`OpenAICompatibleModel` 是第一个非流式 provider adapter，使用 Chat Completions 风格的文本和函数工具调用协议。它需要显式 `baseUrl`，可选接收 `apiKey` 或自定义 `HttpTransport`。

## 真实模型运行

CLI 默认继续使用不联网的 `EchoModel`。`npm start` 会自动读取本机 `.env`；仓库提供 [`.env.example`](.env.example) 作为模板，实际 `.env` 已被 Git 忽略，不能提交 API key。填写完整配置后，CLI 才会创建受审批保护的 OpenAI-compatible 模型和工作区工具：

```dotenv
CODING_AGENT_MODEL_PROVIDER=openai-compatible
CODING_AGENT_MODEL_BASE_URL=http://127.0.0.1:11434/v1
CODING_AGENT_MODEL=your-tool-capable-local-model
```

```powershell
# 仅首次根据模板创建本机配置文件。
Copy-Item .env.example .env
npm start -- "检查测试失败并修复"
```

`CODING_AGENT_MODEL_API_KEY` 可省略，适用于不需要 token 的本地服务。可选 `CODING_AGENT_MODEL_TIMEOUT_MS` 和 `CODING_AGENT_MODEL_MAX_RESPONSE_BYTES` 必须是正整数。交互式 CLI 会在每次模型请求前显示目标 origin、消息角色、可用工具摘要并确认；模型请求、写入和命令执行均被拒绝，除非用户在 TTY 中输入确认。

## 模块边界

- `src/agent/types.ts`：模型、消息、工具和运行结果的稳定契约。
- `src/agent/agent.ts`：`user -> model -> tool calls -> tool results -> model` 循环，带最大步数、取消信号和工具错误回传。
- `src/tools/tool-registry.ts`：工具注册、查找和执行。
- `src/tools/security.ts`：工作区边界、工具 capability 和审批策略。
- `src/tools/workspace-tools.ts` / `src/tools/patch-tools.ts` / `src/tools/command-tools.ts` / `src/tools/test-tools.ts`：受限工作区读取、patch、命令和测试工具。
- `src/model/`：模型审批、HTTP transport、provider adapter 与运行时配置。
- `src/cli.ts`：本地演示和经交互确认的真实模型入口。

## 与成熟 Coding Agent 的差距

当前版本已能在审批边界内执行基础 coding 闭环，但和 Claude Code、Codex 等成熟产品仍有明显差距：

| 能力 | 当前实现 | 成熟 Agent 常见能力 | 后续方向 |
| --- | --- | --- | --- |
| 模型接入 | 统一契约、受限 HTTP transport、OpenAI-compatible adapter、显式 `.env` 配置和逐次网络审批 | 多供应商、流式输出、重试、限流、成本统计 | 先用真实本地模型验收，再增加 streaming 与需要的 adapter |
| 工具 | `read_file`、`list_files`、`search_text`、`apply_patch`、`run_command`、`run_tests`；Zod 校验和 capability 审批 | 更丰富的编辑器、并行调用、外部工具与沙箱隔离 | 保持工具最小化，先补审计和平台 sandbox |
| 上下文 | 运行内消息数组 | 压缩、摘要、持久会话、跨轮记忆 | 增加 token 预算和 transcript store |
| 安全 | workspace realpath 边界、隐藏目录限制、资源上限、写入/执行审批、模型网络审批 | OS sandbox、网络策略、持久审计、细粒度策略继承 | 优先记录审批与工具执行，再接平台隔离 |
| 可靠性 | 最大步数、取消传播、命令超时与子进程终止、模型超时和响应上限 | 断点恢复、幂等、重试、限流、可观测性 | 增加 run state、有限重试和 checkpoint |
| Coding 工作流 | 已实现读取 -> patch -> 测试 -> 结果回传循环，真实模型服务尚待手工验收 | 自动验证策略、复杂编辑、并行子任务 | 先以真实本地模型验证闭环，再按失败点补能力 |
| 交互体验 | CLI 逐次确认模型网络、写入和命令执行 | 流式状态、计划、差异预览、交互式终端 UI | 以 `RunEvent` 为基础增加流式显示 |

`run_command` 通过 `spawn` 的 argv 形式执行，不经过 shell 拼接；cwd 必须位于工作区内，执行前需要 `execute` capability 审批，并受超时、stdout/stderr 大小和环境变量白名单限制。超时或取消时会终止子进程树。`run_tests` 在同一安全边界上封装 npm 测试脚本，返回结构化的通过/失败、exit code、stdout、stderr 和耗时，供 Agent 形成读取、修改、测试、修复、再测试闭环。
