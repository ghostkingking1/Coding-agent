# 安全命令执行 Sandbox 路线图

> 本文是命令执行安全能力的开发计划和长期约束。实现进度以代码、测试和本文为准；旧版能力差距文档中的路线顺序可能已经过时。

## 永久不变量

1. 模型永远不能直接获得 Host Shell。
2. 所有能够启动宿主机进程的 Agent Tool 必须经过同一个 `SandboxBackend`。
3. Approval 针对完整、规范化后的 `ExecutionRequest`，而不是一句命令字符串。
4. Rust Helper 是最终安全边界，必须独立重新执行安全检查，不能信任 TypeScript。
5. Sandbox 能力通过 Capability 表达，上层不直接判断操作系统。
6. 核心隔离不可用时必须 Fail Closed，绝不退化为普通 `subprocess`。
7. 命令执行默认关闭网络；联网能力只能作为后续独立 Capability 引入。
8. User Approval、Sandbox、Network Off、Fail Closed 四项始终同时成立。

## MVP：安全命令执行最小闭环

### 目标

在用户批准后，让模型执行结构化通用命令；命令必须由 Rust Helper 在 Linux 或 Windows 基础隔离环境中执行，默认无网络，任何核心能力缺失都拒绝执行。

### 交付内容

- 定义统一 `ExecutionRequest`：`executable`、`args[]`、`cwd`、显式环境变量、超时、stdin 模式、输出上限、文件系统范围和请求 Capability。
- 定义统一 `SandboxBackend`：能力探测、准备、执行、取消、清理和诊断；`run_command`、`run_tests` 及未来所有进程工具共用它。
- 工具只暴露结构化参数，不提供 Host Shell 或拼接后的 shell 字符串通道。
- Approval 前规范化 executable、cwd、参数、环境变量和 Capability，并生成不可变 request digest；执行前重新比对，任何变化都重新审批。
- Rust Helper 使用版本化 JSON Lines 协议，并独立校验协议、路径、Capability、资源限制、workspace 边界和网络关闭状态。
- Linux 基础隔离：user/mount/PID/network namespace、显式 workspace bind mount、非 workspace 默认不可见。
- Windows 基础隔离：受限 token 或 AppContainer、Job Object 进程树管理、默认无网络、显式 workspace 授权。
- Helper 初始化、能力探测、隔离建立或版本握手失败时返回 `sandbox_unavailable`，不得启动普通进程。
- 仅当所需 Capability 探测成功时，才向模型 manifest 注册 `run_command`；否则不暴露工具并在 CLI 诊断中说明原因。

### MVP 验收

- 模型只能发起结构化 `run_command`，无法获得 Host Shell。
- 未审批、审批后请求变化、Capability 不足、隔离不可用时均拒绝。
- 默认网络访问失败；workspace 内授权行为正常，workspace 外访问失败。
- 超时和取消能终止完整进程树。
- `run_command` 与 `run_tests` 使用同一个 `SandboxBackend`。
- TypeScript、Rust、Linux/Windows 集成和安全回归测试全部通过。

## V1：稳定性、资源限制和持久审计

- Helper 心跳、启动握手、版本兼容检查、执行 ID、状态机和幂等取消。
- 覆盖 Helper 崩溃、Agent 退出和启动后遗留状态的完整进程树清理。
- 限制并记录 wall-clock、CPU、内存、进程数量、句柄/文件描述符和 stdout/stderr 字节数。
- 输出流式传递；达到上限后按策略截断并终止或停止读取。
- 审计记录规范化请求摘要、审批决定、Capability 快照、Helper 版本、时间、退出原因、资源限制、输出截断和 workspace diff 引用。
- 审计不得保存 API key、认证头、完整请求或未经脱敏的敏感环境变量和输出。

验收：任何异常退出都不留下孤儿进程；资源限制可重复触发；审计可还原“批准了什么、执行了什么、结果是什么”；Helper 重启或版本不匹配不会绕过 Fail Closed。

## V2：纵深隔离和逃逸防护

- Linux：seccomp、`no_new_privs`、cgroup v2、只读系统挂载、收紧 `/proc` 和设备访问、用户/组 ID 映射。
- Windows：更严格的 AppContainer/受限 token、Job Object CPU/内存/PID 限制、句柄继承清理、设备/注册表/凭据访问限制、临时 ACL 崩溃恢复。
- 统一覆盖 symlink、junction、reparse point、shell、PowerShell、批处理、解释器、子进程和孙进程逃逸测试。
- 隔离 SSH、云凭据、token 文件和敏感环境变量；不将 secret 自动放入模型上下文。

验收：Windows/Linux 逃逸测试集通过；能力缺失时准确反映 Capability，不虚报隔离强度；策略要求的高风险能力不可用时拒绝执行。

## V3：网络 Capability 和风险策略

- 新增独立 network Capability，默认不存在；Approval 明确绑定域名/IP、端口、DNS、代理和有效期。
- Linux 使用隔离 network namespace、代理或 egress 过滤；Windows 使用受控网络过滤后端；无法可靠限制时拒绝联网 Capability。
- 覆盖 DNS、代理、IPv6、回环、Unix socket 和宿主机共享 socket 绕过路径。
- 引入只读、本地写入、构建/测试、依赖安装、网络和特权等风险分类；分类只影响展示和策略，不替代完整 Approval。

验收：默认所有命令无网络；联网请求独立审批并精确绑定网络策略；绕过测试通过；风险分类错误不会导致未经审批的副作用。

## V4：多 Agent、快照和更强隔离后端

- 每个 Agent 使用独立 sandbox identity、临时目录、进程组和 Capability 集合。
- 增加并发资源配额、执行前后快照、checkpoint 恢复和失败恢复策略。
- 增加可选 OCI 容器后端和 VM 后端；均明确 workspace mount、默认无网络和资源/PID 限制。
- `SandboxBackend` 对上层保持统一，上层不感知 OS、容器或 VM；后端能力不足仍 Fail Closed。

验收：Agent 之间不能读取彼此 workspace、环境或进程；崩溃后审计和 sandbox 状态可恢复；容器/VM 后端可替换原生后端而不修改 Agent Tool 契约。

## 开发顺序和质量门槛

当前状态：MVP 控制面和 Rust Helper 协议已实现；V1 已加入执行 ID、资源限制请求、Helper 侧 wall-clock 超时、Windows Job Object 进程/内存/CPU 限制、Linux `no_new_privs`/地址空间/进程数限制，以及命令执行审计事件。V2 已加入 Linux namespace 内的只读宿主根、仅 workspace 可写 bind mount、凭据目录覆盖、seccomp 过滤，以及 Windows 每次执行独立 AppContainer、`DISABLE_MAX_PRIVILEGE` Restricted Token、非 reparse workspace 最小 ACL 保存/恢复、Job Object 与标准流句柄白名单组合隔离。Windows 目标以挂起状态创建，必须先加入已配置 Job 后才恢复执行，避免 Job 纳入前的子进程竞态。

仍未宣称完成的 V2 能力：精细 `/proc`/设备限制，以及 Windows 的独立网络过滤、注册表显式 deny policy 和 ACL 崩溃后恢复守护。AppContainer 与 Restricted Token 默认拒绝未授权的网络、设备、注册表和用户凭据访问；但这些更细粒度策略必须有平台级逃逸验证后才能单独声明 Capability。Linux seccomp 会在握手中以独立 Helper 子进程探测；成功时声明 `hardening.seccomp`，并在 namespace/mount 建立后、目标程序 exec 前拒绝挂载、namespace、ptrace、bpf、内核模块、keyring 等高风险 syscall。Linux cgroup v2 会在宿主已委派可写层级时探测并声明，执行时把完整 sandbox 子树加入该 cgroup 并写入内存、PID、CPU 配额。其余能力也必须由平台探测证明后才能加入 Capability，不能以“请求已携带限制”代替实际内核隔离。

Windows 已有集成回归：workspace 写入成功、workspace 外读取失败、回环 TCP 失败以及超时后的延迟写入不发生。严格 AppContainer 不会修改宿主工具链 ACL；若目标程序需要继续启动未被系统授予 AppContainer 执行权限的宿主二进制，执行会明确失败而非放宽权限。这是当前 Fail Closed 的兼容性边界，受控工具链镜像属于后续隔离后端工作。

平台能力仍按探测结果决定：Linux 通过 `unshare` 和 `no_new_privs` 前置设置才启用对应能力；Windows 只有 AppContainer、Workspace ACL、Restricted Token、句柄白名单和 Job Object 探测成功才启用 `os.isolation`。任何能力不足继续 Fail Closed。

推荐分支：`codex/sandbox-mvp`、`codex/sandbox-v1-stability`、`codex/sandbox-v2-hardening`、`codex/sandbox-v3-network-policy`、`codex/sandbox-v4-isolation-backends`。

MVP 完成前不得向模型注册 `run_command`。每个阶段都必须覆盖正常路径、审批失败、隔离失败、资源限制、进程清理和逃逸尝试，并通过：

```text
npm test
npx tsc --noEmit
Rust 单元与集成测试
Windows/Linux 安全测试矩阵
git diff --check
```

任何“能力不可用”都必须作为明确拒绝原因显示，不能静默降级。MVP、V1、V2 完成后再推进模型适配器、外部工具协议和 skills；这些扩展必须复用同一 Capability、Approval 和 Sandbox 约束。
