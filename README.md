# Coding Agent

阶段一实现了一个原生 TypeScript 最小 Agent 执行循环，不依赖 LangChain、LangGraph 等 Agent 框架。

## 快速开始

环境要求：Node.js 22+。

```bash
npm start -- "请检查这个项目"
npm test
```

CLI 使用内置 `EchoModel` 演示运行链路。接入真实模型时，实现 `ModelClient.generate(request)`，把统一消息和工具定义转换为供应商请求，再把响应转换为 assistant 消息及其中的 `toolCalls`。工具分别声明给模型的 JSON Schema 和本地 Zod 校验，前者帮助模型生成参数，后者仍是执行前不可绕过的安全检查。

`FetchHttpTransport` 为 provider adapter 提供统一的 HTTP 超时、取消、响应大小限制、错误分类和 JSON 解析；adapter 负责各供应商协议转换。实际网络调用仍应由后续 provider 的配置和审批边界控制。

`OpenAICompatibleModel` 是第一个非流式 provider adapter，使用 Chat Completions 风格的文本和函数工具调用协议。它需要显式 `baseUrl`，可选接收 `apiKey` 或自定义 `HttpTransport`，不会自动读取环境变量或切换 CLI 的内置演示模型。

## 模块边界

- `src/core/types.ts`：模型、消息、工具和运行结果的稳定契约。
- `src/core/tool-registry.ts`：工具注册、查找和执行。
- `src/core/agent.ts`：`user -> model -> tool calls -> tool results -> model` 循环，带最大步数、取消信号和工具错误回传。
- `src/core/workspace-tools.ts` / `src/core/patch-tools.ts` / `src/core/command-tools.ts`：受限工作区读工具、可预览可审批的 patch 工具和命令执行工具。
- `src/cli.ts`：无外部服务的可运行演示入口。

## 与成熟 Coding Agent 的差距

当前版本只覆盖最小执行骨架，和 Claude Code、Codex 等成熟产品仍有明显差距：

| 能力 | 当前实现 | 成熟 Agent 常见能力 | 后续方向 |
| --- | --- | --- | --- |
| 模型接入 | 供应商无关的异步 `ModelClient` 接口 | 多供应商、流式输出、重试、限流、成本统计 | 增加 provider adapter 与 streaming event API |
| 工具 | 内存注册表，工具串行执行 | 文件编辑、搜索、终端、网络、并行调用、权限确认 | 建立沙箱工具层、schema 校验和审批策略 |
| 上下文 | 运行内消息数组 | 压缩、摘要、持久会话、跨轮记忆 | 增加 token 预算和 transcript store |
| 安全 | 仅传播 `AbortSignal` | 工作区边界、命令风险分级、用户确认、审计 | 设计 capability/approval policy |
| 可靠性 | 最大步数，工具错误回传 | 断点恢复、幂等、超时、结构化错误、观测 | 增加 run state、超时和 telemetry |
| Coding 工作流 | 已有受限工作区读工具和 patch 工具，仍缺少命令与测试 | 代码搜索、补丁应用、测试运行、结果验证 | 按工具模块逐步接入，并为每个工具配合回归测试 |
| 交互体验 | CLI 一次性输出 | 流式状态、计划、差异预览、交互式确认 | 设计事件协议和终端 UI |

阶段二的首个切片已经加入受限工作区只读能力：`read_file`、`list_files` 和 `search_text`。这些工具通过 `WorkspacePolicy` 校验真实路径、工作区边界、隐藏路径、文件大小和结果数量；工具也必须声明 capability，并用 Zod 定义 input schema，`defineTool` 和 `ToolRegistry` 会在审批和执行前统一解析并拒绝非法输入，写入、执行和网络能力由 `SecurityPolicy` 在副作用发生前审批，默认拒绝。

当前已提供受限的 `run_command`：命令通过 `spawn` 的 argv 形式执行，不经过 shell 拼接；cwd 必须位于工作区内，执行前需要 `execute` capability 审批，并受超时、stdout/stderr 大小和环境变量白名单限制。超时或取消时会终止子进程树。`run_tests` 在同一安全边界上封装 npm 测试脚本，返回结构化的通过/失败、exit code、stdout、stderr 和耗时，供 Agent 形成读取、修改、测试、修复、再测试闭环。
