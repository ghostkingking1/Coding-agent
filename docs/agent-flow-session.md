# Session 生命周期与恢复链路

## 1. 目标

让多次 Agent run 共享一个可控的对话上下文，并在运行失败、进程退出或恢复时区分已提交事实与未完成操作。

## 2. 整体流程

```text
SessionManager.create/load
  -> Session.initialize/restore
  -> Session.run
  -> Agent.run
  -> 成功：提交上下文与 run
  -> 失败：记录 failed，不提交部分上下文
  -> close：关闭 Session，禁止新 run
```

## 3. 核心模块

| 模块 | 状态 | 责任 | 入口 |
| --- | --- | --- | --- |
| Session | **已实现** | 串行运行、上下文和运行历史 | `src/agent/session.ts:Session.run()` |
| SessionManager | **已实现** | 创建、加载、恢复和工作区校验 | `src/agent/session-manager.ts:load()/recover()` |
| SessionStore | **已实现** | 抽象持久化操作 | `src/agent/session-store.ts:SessionStore` |
| Lease/Heartbeat | **已实现** | 防止跨进程并发占用同一 Session | `src/agent/session.ts`、`SessionStore.heartbeatRun()` |
| Checkpoint 恢复 | **部分实现** | 恢复已提交消息，不重放副作用 | `Session.restore()` |

## 4. 数据流

Session 接收用户输入后生成 `runId` 和时间戳，把当前 `context` 作为 `initialMessages` 传给 Agent。Agent 成功返回后，Session 取出相对于旧 context 的新增消息，形成该 run 的提交批次。

```text
Session.context + input
  -> Agent.run(initialMessages)
  -> AgentResult.messages
  -> newMessages = result.messages - old context
  -> completeRun
  -> 更新 Session.context / runHistory
```

失败时只写入错误和状态，内存中的临时消息不会进入下一次 run。

## 5. 关键决策

- Session 已关闭：拒绝新 run。
- 已有内存运行：拒绝重叠 run。
- 持久化配置缺少 `workspaceRoot`：创建 Session 失败。
- 载入时 workspace 不匹配：拒绝恢复。
- 存在未过期 running run：拒绝并发加载。
- lease 已过期：标记为 `interrupted` 后允许恢复。

## 6. 异常流程

```text
Agent 失败/取消 -> failRun(status=failed) -> 保留失败历史 -> context 不变
进程退出       -> running run 留在 store
再次 load      -> 未过期则拒绝；已过期则 interrupted
显式 recover   -> 中断过期 run -> 重新 load 已提交上下文
```

恢复会从 run checkpoint 读取已完成工具结果，避免重复写文件或重复执行命令；尚未执行的工具仍需经过原审批策略。任务级状态机和强制验证闭环尚未实现。

## 7. 持久化 / 审计

Session 通过 `startRun`、`completeRun`、`failRun` 记录生命周期；checkpoint 保存模型/工具边界和幂等结果；`audit_events` 保存受限运行事件。成功提交包含新增消息；失败只记录状态和错误。`ownerId`、`leaseUntil` 和 heartbeat 让其他进程判断运行是否仍被占用。

## 8. 安全边界

- Session ID 和 Run ID 必须通过安全字符校验。
- 恢复必须匹配当前工作区绝对路径。
- 同一 Session 同时只能有一个 active run。
- 恢复不会重放工具、命令或 patch 副作用。

## 9. 设计原因

Session 将 Agent 的一次性执行与多轮产品体验分离；成功消息才提交，保证失败 run 不污染后续上下文；lease 则补足单进程内存锁无法覆盖的跨进程并发问题。

## 10. 当前边界

**已实现**多轮上下文、持久状态、checkpoint、幂等工具结果、过期恢复和运行审计；**部分实现**恢复 CLI/API 和审计查询；**后续计划**是任务级状态机、强制验证和跨设备恢复。

## 11. 相关测试

- `test/agent/session.test.ts`
- `test/agent/sqlite-session-store.test.ts`
