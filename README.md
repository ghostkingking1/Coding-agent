# Coding Agent

阶段一实现了一个原生 TypeScript 最小 Agent 执行循环，不依赖 LangChain、LangGraph 等 Agent 框架。

## 快速开始

环境要求：Node.js 22+。

```bash
npm start -- "请检查这个项目"
npm test
```

CLI 使用内置 `EchoModel` 演示运行链路。接入真实模型时，实现 `Model.generate(messages)`，把模型返回的文本和 `toolCalls` 交给 `Agent` 即可。

## 模块边界

- `src/core/types.ts`：模型、消息、工具和运行结果的稳定契约。
- `src/core/tool-registry.ts`：工具注册、查找和执行。
- `src/core/agent.ts`：`user -> model -> tool calls -> tool results -> model` 循环，带最大步数、取消信号和工具错误回传。
- `src/cli.ts`：无外部服务的可运行演示入口。

## 与成熟 Coding Agent 的差距

当前版本只覆盖最小执行骨架，和 Claude Code、Codex 等成熟产品仍有明显差距：

| 能力 | 当前实现 | 成熟 Agent 常见能力 | 后续方向 |
| --- | --- | --- | --- |
| 模型接入 | 单一异步 `Model` 接口 | 多供应商、流式输出、重试、限流、成本统计 | 增加 provider adapter 与 streaming event API |
| 工具 | 内存注册表，工具串行执行 | 文件编辑、搜索、终端、网络、并行调用、权限确认 | 建立沙箱工具层、schema 校验和审批策略 |
| 上下文 | 运行内消息数组 | 压缩、摘要、持久会话、跨轮记忆 | 增加 token 预算和 transcript store |
| 安全 | 仅传播 `AbortSignal` | 工作区边界、命令风险分级、用户确认、审计 | 设计 capability/approval policy |
| 可靠性 | 最大步数，工具错误回传 | 断点恢复、幂等、超时、结构化错误、观测 | 增加 run state、超时和 telemetry |
| Coding 工作流 | 无真实文件/命令工具 | 代码搜索、补丁应用、测试运行、结果验证 | 按工具模块逐步接入，并为每个工具配合回归测试 |
| 交互体验 | CLI 一次性输出 | 流式状态、计划、差异预览、交互式确认 | 设计事件协议和终端 UI |

阶段二建议优先实现受限工作区内的 `read_file`、`list_files` 和 `run_command`（默认审批），再补充流式事件与上下文预算。
