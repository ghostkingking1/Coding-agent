# 功能总结

截至 2026-08-29，项目已经形成一个可测试的基础 coding agent 闭环：

```text
用户请求 -> Agent 调用模型 -> 模型请求工具 -> 工具校验与审批
       -> 工具执行 -> 结果回传模型 -> 最终回答
```

## Agent 执行

- 支持最大步数限制，避免模型循环无限运行。
- 保存当前运行中的 system、user、assistant 和 tool 消息。
- 支持模型连续返回工具调用，并将工具结果回传到下一轮模型请求。
- 支持 `AbortSignal` 取消模型和工具执行。
- 支持模型开始、工具请求、工具完成、工具失败和运行结束事件。

## 工作区工具

- `read_file`：读取工作区内受大小限制的 UTF-8 文件。
- `list_files`：按深度和数量上限列出工作区文件。
- `search_text`：在工作区文本文件中搜索字面量字符串。
- `apply_patch`：对已有文本进行精确替换，先生成受限 diff 预览，再审批和写入。
- `run_command`：在工作区内以 argv 形式执行命令，具备 cwd、超时、环境变量、stdout/stderr 和子进程树限制。
- `run_tests`：封装受限的 npm 测试命令，返回结构化状态、退出码、输出和耗时。

## 工具安全

- 所有工具通过 manifest 声明 `read`、`write`、`execute` 或 `network` capability。
- 工具输入在执行前统一通过 Zod 校验，非法参数不会进入预览、审批或副作用阶段。
- `WorkspacePolicy` 使用 realpath 校验工作区边界，拒绝越界路径、符号链接逃逸、隐藏路径和超限资源。
- 只读工具默认允许；写入和命令执行默认拒绝，交互式 CLI 可在副作用前逐次确认。
- 未声明模型 JSON Schema 的工具不会暴露给模型。
- 命令和模型响应都有超时、输出大小或响应大小限制。

## 模型接入

- `ModelClient` 提供供应商无关的模型契约。
- `OpenAICompatibleModel` 支持 Chat Completions 风格的文本和函数工具调用转换。
- `FetchHttpTransport` 统一处理超时、取消、响应大小、HTTP 错误、网络错误和 JSON 解析。
- `ApprovedModelClient` 确保每次可能上传对话或工具结果的模型请求先经过审批。
- 通过 `.env` 显式配置 provider、base URL、模型和可选 API key。
- 未配置模型时保持不联网的 Echo 演示模式。
- CLI 只向模型注册读取、搜索、patch 和 `run_tests`；模型开始、工具请求、完成或失败会输出单行终端摘要。
- 已用真实 OpenAI-compatible 模型在隔离仓库完成一次“读取 -> 修改 -> 测试失败 -> 修复 -> 测试通过”的验收，详见[兼容性记录](compatibility-notes.md)。

## 测试与组织

- 生产代码位于 `src/agent`、`src/tools` 和 `src/model`。
- 测试代码独立位于 `test/agent`、`test/tools` 和 `test/model`。
- 当前测试覆盖 Agent 循环、schema 校验、workspace 安全、patch 审批、命令和测试限制、模型协议转换、HTTP transport 和模型网络审批。
- 通过 `npm test` 运行测试，使用 `npx tsc --noEmit` 进行类型检查。

## 当前边界

当前实现适合在明确审批和受控工作区中进行实验性验证。流式输出、持久审计、上下文预算、checkpoint 恢复、OS 级 sandbox，以及 Anthropic 和 OpenAI Responses adapter 仍属于后续工作，详见[官方能力差距报告](official-coding-agent-gap-analysis.md)。
