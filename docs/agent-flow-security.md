# 工具安全与审批链路

## 1. 目标

确保模型或调用方提供的工具参数在任何文件写入、命令执行或网络请求发生前经过统一校验、能力判断、预览和 Approval。

## 2. 整体流程

```text
Tool Call
  -> ToolRegistry 查找
  -> Zod inputSchema
  -> SecurityPolicy
  -> capability 判断
  -> preview
  -> Approval
  -> execute
  -> ToolMessage
```

## 3. 核心模块

| 模块 | 状态 | 责任 | 入口 |
| --- | --- | --- | --- |
| ToolRegistry | **已实现** | 统一查找、校验和执行 | `src/tools/tool-registry.ts:execute()` |
| SecurityPolicy | **已实现** | manifest、capability、预览和审批 | `src/tools/security.ts:authorize()` |
| WorkspacePolicy | **已实现** | realpath、边界、隐藏路径和资源限制 | `src/tools/security.ts:WorkspacePolicy` |
| ApprovalPolicy | **已实现** | 只读自动允许，副作用默认拒绝 | `DefaultApprovalPolicy` |
| OS Sandbox | **部分实现** | SandboxBackend 和 helper 控制面已存在 | `src/tools/sandbox.ts` |

## 4. 数据流

工具 manifest 提供 capability、输入 schema 和模型 JSON Schema。只有声明 `modelInputSchema` 的工具才进入模型工具列表；执行时先把 unknown 输入解析成工具类型，再把解析结果送入预览和审批。

Workspace 路径先转为 realpath，再检查是否仍在根目录内、是否隐藏、是否是普通文件/目录以及是否超过大小限制。

## 5. 关键决策

- 无 manifest 且要求 manifest：拒绝。
- capability 全为 `read`：默认允许，不触发副作用审批。
- 包含 `write/execute/network`：生成预览并请求 Approval。
- Approval 拒绝：不调用工具 execute。
- 命令所需 Sandbox capability 不足：Fail Closed，不退化为普通 spawn。

## 6. 异常流程

```text
路径越界/符号链接逃逸 -> WorkspaceSecurityError -> 不执行
schema 错误            -> ToolInputValidationError -> 不预览/不审批
Approval 拒绝           -> ApprovalDeniedError -> 无副作用
Sandbox 不可用          -> SandboxUnavailableError -> 不启动宿主进程
工具执行异常            -> Agent 转为 error ToolMessage
```

## 7. 持久化 / 审计

Approval 请求包含工具名、capability、解析后的 input 和 preview。当前这些请求通过回调提供，未形成独立审计表；工具结果进入 Agent transcript，Session 成功时随消息持久化。

## 8. 安全边界

- 默认拒绝未知 capability 和未声明 manifest。
- 默认隐藏路径不可见，拒绝 workspace 外路径和 symlink escape。
- 命令 cwd、环境变量、超时、输出和子进程树均有限制。
- Sandbox 的 `Unavailable` 和 capability 缺失必须拒绝，不能静默降级。
- 应用层 cwd/realpath 约束不等于 OS 级隔离。

## 9. 设计原因

统一执行入口可以保证校验和授权顺序不被工具调用路径绕过；预览让用户批准具体操作而非模糊命令；Fail Closed 避免安全后端不可用时意外回落到宿主机执行。

## 10. 当前边界

**已实现**应用层路径策略、Approval、输入校验和 Sandbox 控制面；**部分实现**Rust helper/OS 隔离按平台能力启用；**后续计划**是风险分级、网络 capability 和纵深隔离。

## 11. 相关测试

- `test/tools/security.test.ts`
- `test/tools/tool-schema.test.ts`
- `test/tools/sandbox.test.ts`
- `test/tools/patch-tools.test.ts`
