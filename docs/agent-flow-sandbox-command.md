# 命令、测试与 Sandbox 链路

## 1. 目标

在用户批准后执行结构化命令或测试，并通过统一 SandboxBackend、工作区 cwd、环境白名单、网络关闭、资源限制和进程树清理控制宿主机风险。

## 2. 整体流程

```text
Tool Call
  -> run_command / run_tests schema
  -> 规范化 ExecutionRequest
  -> 生成预览和 Approval
  -> SandboxBackend capability 检查
  -> Rust Helper 或受限 process backend
  -> 子进程执行
  -> 输出限制/超时/取消
  -> 结构化结果
  -> ToolMessage -> Model
```

## 3. 核心模块

| 模块 | 状态 | 责任 | 入口 |
| --- | --- | --- | --- |
| run_command | **部分实现** | 结构化通用命令执行 | `src/tools/command-tools.ts:createRunCommandTool()` |
| run_tests | **已实现** | 将 npm script 包装为测试结果 | `src/tools/test-tools.ts:createRunTestsTool()` |
| SandboxBackend | **部分实现** | capability 探测和进程启动边界 | `src/tools/sandbox.ts` |
| Rust Helper | **部分实现** | JSON Lines/能力握手和平台隔离控制 | `sandbox-helper/src/main.rs` |
| OS 隔离 | **部分实现** | Windows/Linux 由 helper 能力决定 | 缺少能力时 Fail Closed |

## 4. 数据流

输入包含 executable/command、args、cwd、env、timeout、输出上限和 network=off。命令计划阶段解析 cwd、过滤环境变量并生成预览；执行阶段将规范化请求传给 SandboxBackend。

`run_tests` 固定构造 `npm run <script> -- <args>`，复用命令工具的审批、cwd、超时和输出限制，再将退出码转换为 `passed/failed/timed_out/aborted/error`。

## 5. 关键决策

- cwd 不在 workspace 或为隐藏/非法路径：拒绝。
- timeout 超过最大值：拒绝。
- 环境变量不在 allowlist：不透传。
- Sandbox 缺少所需 capability：拒绝启动。
- Approval 针对完整规范化请求和 digest，而不是原始命令字符串。
- stdout/stderr 达到上限：截断并标记，按策略终止或停止读取。

## 6. 异常流程

```text
Approval 拒绝 -> 不启动进程
Sandbox 握手失败 -> sandbox_unavailable -> Fail Closed
进程启动失败 -> error 结果
非零退出码 -> failed 测试结果
超时 -> 终止进程树 -> timed_out
取消 -> 终止进程树 -> aborted
Helper 崩溃 -> 当前执行失败 -> 清理/恢复流程
```

`ProcessSandboxBackend` 只声明 process spawn、进程树、workspace fs 和 network off，不宣称 `os.isolation`。正式强隔离要求 helper 能力探测通过。

## 7. 持久化 / 审计

预览记录命令、参数、cwd、超时、输出上限和环境变量名称，不记录环境变量值。结果记录退出码、signal、输出、截断、超时、取消和耗时；完整输出可由 ToolOutputStore 落盘后分页读取。

## 8. 安全边界

- 不提供 shell 字符串通道，默认 `shell=false`。
- workspace root 显式传给 helper，默认网络关闭。
- Windows 使用 Job Object/taskkill 管理进程树；POSIX 使用进程组和强制信号。
- helper 未配置或能力不足时绝不回落到普通宿主执行。
- 当前控制面不等同于所有平台都已具备 OS 级隔离。

## 9. 设计原因

统一后端让 `run_command`、`run_tests` 和未来进程工具共享安全约束；Rust helper 独立重新检查请求，避免 TypeScript 校验被绕过；结构化测试结果让模型能够形成“失败 -> 修复 -> 再测试”反馈闭环。

## 10. 当前边界

**已实现**结构化命令/测试、网络关闭、超时取消和 Fail Closed 控制面；**部分实现**Rust helper 的 Windows/Linux 隔离；**后续计划**是资源配额、seccomp/AppContainer 加固、网络 capability 和容器/VM 后端。

## 11. 相关测试

- `test/tools/command-tools.test.ts`
- `test/tools/test-tools.test.ts`
- `test/tools/sandbox.test.ts`
- `docs/sandbox-roadmap.md`
