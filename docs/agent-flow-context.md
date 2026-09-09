# 上下文预算与压缩链路

## 1. 目标

在保留完整运行 transcript 的同时，为每轮模型请求生成不超过预算的上下文，避免超大工具输出和历史消息耗尽模型输入资源。

## 2. 整体流程

```text
完整 messages
  -> token 估算
  -> 工具输出截断
  -> 文本 snip
  -> 连续工具链折叠
  -> 保留最近轮次 + 历史摘要
  -> 最终预算检查
  -> ModelClient.generate(contextResult)
```

## 3. 核心模块

| 模块 | 状态 | 责任 | 入口 |
| --- | --- | --- | --- |
| ContextManager | **部分实现** | 生成模型视图和压缩阶段结果 | `src/agent/context-manager.ts:DefaultContextManager.compact()` |
| Agent | **已实现** | 每轮模型请求前调用 ContextManager | `src/agent/agent.ts:executeRun()` |
| ToolOutputStore | **部分实现** | 超大工具输出落盘并提供分页引用 | `src/agent/tool-output-store.ts` |

## 4. 数据流

完整消息包含 system、user、assistant 和 tool。ContextManager 复制消息后只修改模型视图：tool 内容可能被截断，历史内容可能合并成 `[历史摘要 ...]`，但原始 `messages` 不变。

`ContextResult` 包含压缩后的 `messages`、估算 token、预算、阶段列表、摘要和 degradation 标记，并随 `ModelRequest` 传给模型。

## 5. 关键决策

- 当前请求自身超过预算：立即失败。
- tool 输出超过单条上限：保留头尾并标记 `tool_output_truncated`。
- 仍超预算：折叠连续工具链。
- 仍超预算：保留最近轮次，旧消息生成确定性或自定义摘要。
- 摘要压缩后仍超限：只保留系统消息、摘要和当前请求；仍超限则失败。

## 6. 异常流程

```text
摘要函数失败 -> 使用本地确定性摘要
当前请求超预算 -> run 失败，不发送模型
压缩后仍超预算 -> run 失败
工具输出超限 -> 视图截断；完整内容可通过 artifact 分页读取
```

## 7. 持久化 / 审计

原始消息由 Session 持久化；压缩后的模型视图不覆盖原始消息。`ContextResult.stages` 和 `degradation` 可用于运行事件或未来审计，但当前没有独立上下文审计表。

## 8. 安全边界

- 所有压缩阶段都受硬 token 预算约束。
- 工具输出和摘要不能绕过最大消息资源限制。
- `read_tool_output` 只按 artifactId、offset、limit 读取 Agent 自己的临时输出，不接受任意文件路径。

## 9. 设计原因

模型视图与事实 transcript 分离，使上下文优化不损害恢复和 tool call 关联；分阶段降级优先保留当前请求和系统约束；大输出落盘避免把完整 stdout 长期保存在内存或上下文中。

## 10. 当前边界

**已实现**确定性估算、分阶段压缩和输出 artifact；**部分实现**摘要质量和 token 估算精度；**后续计划**是引入更准确的 provider tokenizer、总体 deadline 和持久化上下文审计。

## 11. 相关测试

- `test/agent/context-manager.test.ts`
- `test/agent/tool-output-store.test.ts`
