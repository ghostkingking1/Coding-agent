# 模型配置与网络请求链路

## 1. 目标

在保持 `ModelClient` 供应商无关契约的同时，安全地读取运行配置、请求 OpenAI-compatible 服务，并把外部响应转换为 Agent 可消费的标准消息。

## 2. 整体流程

```text
环境变量
  -> readModelRuntimeConfig
  -> OpenAICompatibleModel / OpenAIResponsesModel
  -> ApprovedModelClient
  -> Model Approval
  -> FetchHttpTransport
  -> provider response
  -> ModelResponse
  -> Agent
```

## 3. 核心模块

| 模块 | 状态 | 责任 | 入口 |
| --- | --- | --- | --- |
| Runtime config | **已实现** | 校验 provider、URL、模型和限制 | `src/model/runtime-config.ts:readModelRuntimeConfig()` |
| ApprovedModelClient | **已实现** | 每次外发请求前审批 | `src/model/approval.ts:ApprovedModelClient.generate()` |
| OpenAI adapter | **已实现** | 转换消息、工具和响应 | `src/model/openai-compatible.ts:OpenAICompatibleModel.generate()` |
| HTTP transport | **已实现** | timeout、cancel、HTTP/JSON/大小错误 | `src/model/transport.ts:FetchHttpTransport` |
| OpenAI Responses adapter | **已实现** | Responses 输入、函数调用延续和 SSE | `src/model/openai-responses.ts` |
| 其他 provider adapter | **未实现** | Anthropic 等 | 当前无实现 |

## 4. 数据流

Agent 传入模型视图、工具定义、取消信号和 ContextResult。ApprovedModelClient 只向审批方暴露 provider、model、endpoint origin、消息数量、角色和工具名摘要；通过后才调用 adapter。

Adapter 把内部 `Message` 映射为 provider message/input，把模型工具定义映射为函数工具；响应中的文本、tool calls、finish reason 和 usage 再归一化为 `ModelResponse`。Responses 协议额外支持 `previous_response_id`，但 Session 尚未自动持久化服务端 response id。

## 5. 关键决策

- 没有任何模型环境变量：使用不联网的 EchoModel。
- 配置只填一部分或 provider 不支持：启动配置失败。
- 模型请求可能上传代码或工具输出：每次请求都要求 Approval。
- Approval 拒绝：不发起 HTTP 请求。
- 响应超过大小、超时、取消、HTTP 非 2xx 或 JSON 结构非法：请求失败。

## 6. 异常流程

```text
配置错误 -> 不创建真实 client
网络审批拒绝 -> ModelApprovalDeniedError -> Agent run_failed
timeout/abort -> transport 终止请求 -> Agent run_failed
HTTP/JSON/响应过大 -> ModelTransportError 或 response error -> Agent run_failed
```

Agent 对网络、超时、限流和服务端错误进行有限次数、受预算约束的退避重试，并尊重 `Retry-After`；认证、取消、协议和资源限制错误不重试。

## 7. 持久化 / 审计

模型请求摘要通过 `onApprovalRequired` 回调提供；模型尝试、重试、流式完成和失败摘要可写入 SQLite `audit_events`。不持久化完整 prompt、API key、认证头或原始响应；成功的 assistant 消息可随 Session 消息持久化。

## 8. 安全边界

- API key 只用于 Authorization，不进入审批摘要和模型消息。
- endpoint origin 显式展示并绑定审批。
- 未配置真实模型时保持离线 Echo 模式。
- timeout、取消和最大响应字节数由 transport 强制执行。
- 网络 capability 当前只用于模型 transport，通用网络工具尚未开放。

## 9. 设计原因

把审批包装在 ModelClient 外层，保证每轮请求无论来自初始对话还是工具结果都不会绕过网络授权；transport 统一处理底层错误，adapter 只负责协议转换，便于未来增加 provider。

## 10. 当前边界

**已实现**OpenAI-compatible Chat Completions/Responses、SSE、配置校验、逐次审批和有限重试；**部分实现**服务端 response id 的跨 Session 持久化；**未实现**Anthropic 等其他 provider 和通用网络工具。

## 11. 相关测试

- `test/model/runtime-config.test.ts`
- `test/model/approval.test.ts`
- `test/model/openai-compatible.test.ts`
- `test/model/transport.test.ts`
