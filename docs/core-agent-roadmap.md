# Core Agent 能力路线图

本文定义项目达到核心 coding agent 能力所需的开发顺序。每个阶段都是独立的可交付功能块；未满足前置阶段的能力不得提前开放。状态以代码、测试和平台探测结果为准。

## 总体顺序

```text
Sandbox V2（基础能力已落地）
  -> OpenAI Responses（已完成）
  -> 本地 MCP tools（已完成）
  -> 仓库指令加载与 Git 感知（已完成）
  -> 任务状态机与强制验证闭环（下一阶段）
  -> 持久任务恢复 CLI/API
  -> Skills
```

上下文预算、摘要、SQLite 审计、checkpoint 和 Session 基础已经存在，本路线只补它们在真实任务中的产品化使用，不重复建设。

## 阶段一：Sandbox V2（基础能力已完成，纵深能力进行中）

### 目标

让模型能够在不可信仓库中执行命令，同时不能获得宿主机权限或绕过统一安全边界。

### 范围

- Linux 增加 `no_new_privs`、seccomp、cgroup v2、只读系统挂载、收紧 `/proc`、设备限制和用户映射。
- Windows 加强 AppContainer/受限 Token、Job Object 资源限制、句柄继承清理，以及注册表、设备和凭据访问限制。
- 覆盖 symlink、junction、reparse point、shell、PowerShell、批处理、解释器、子进程和孙进程逃逸路径。
- 将 CPU、内存、PID 数、句柄数、磁盘和输出上限纳入 `ExecutionRequest` 与 Capability。
- 命令、测试和未来 MCP Server 的启动都只能经由同一个 `SandboxBackend`。

### 当前状态

Rust Helper 已具备 Linux namespace、`no_new_privs`、seccomp/cgroup 探测和 Windows AppContainer、Restricted Token、Job Object、句柄白名单等基础能力；能力不足时 Fail Closed。精细 `/proc`/设备限制、Windows 独立网络/注册表策略和 ACL 崩溃恢复仍未完成。

### 完成定义

隔离能力缺失时不注册工具；任何普通 subprocess 降级路径都必须被拒绝。

## 阶段二：OpenAI Responses（已完成）

### 目标

支持 OpenAI Responses API，同时保持现有 `ModelClient`、ToolRegistry、Approval、Sandbox 和审计语义不变。

### 范围

- 新增独立 Responses adapter，不把 provider 特性泄漏到 Agent。
- 转换统一消息、system prompt 和工具 manifest。
- 解析普通文本、流式文本、function tool call、tool result continuation、完成原因和 usage。
- 复用现有 transport 的超时、取消、错误分类、有限重试、响应体限制和网络审批。
- 显式配置 Chat Completions 或 Responses，禁止根据响应内容自动猜测协议。

### 完成定义

同一 Agent 更换模型协议后，工具调用、上下文压缩、checkpoint、审批和审计结果保持一致。

## 阶段三：本地 MCP Tools（已完成）

### 目标

以受控方式接入本地 MCP Server，先实现 tools 子集，不开放远程网络通道。

### 范围

- 仅支持显式配置的本地 `stdio` Server。
- 实现 `initialize`、`tools/list` 和 `tools/call`。
- 将 MCP 工具适配为 ToolRegistry 工具。
- Server 的可执行文件、参数、工作目录和环境变量全部由配置固定，模型不能决定。
- MCP Server 进程必须通过 SandboxBackend 启动。
- 调用前审批绑定 Server 身份、工具名、规范化参数、Capability 快照和 digest。
- 限制消息大小、工具数量、超时、并发和输出，并写入统一审计。
- 初始化失败、协议错误、崩溃、超时或版本不匹配时 Fail Closed。

### 暂不范围

远程 MCP、resources、prompts、OAuth、自动安装 Server。它们依赖后续网络 Capability 和策略系统。

### 完成定义

MCP 能力不能绕过 workspace、Approval、Sandbox、输出限制或审计链。

## 阶段四：仓库指令加载与 Git 感知（已完成）

### 仓库指令

- 按目录层级发现 `AGENTS.md`，定义根目录到当前子目录的合并和覆盖规则。
- 将指令以受限长度注入 system context，并记录来源和适用路径。
- 指令中的命令、URL、安装步骤和外部内容一律不自动执行。
- 提供查看、审计和禁用本次加载指令的能力。

### Git 感知

- 提供只读的分支、HEAD、upstream、脏状态、staged、unstaged 和 untracked 摘要。
- 在任务开始建立用户已有修改基线，结束时区分用户修改和 Agent 修改。
- 提供文件级 diff、提交前检查和 commit 草案预览。
- 后续开放 `git_commit` 时，审批必须绑定完整变更集、分支、提交信息和 digest。
- 默认禁止破坏性 reset、强制推送、删除分支和覆盖用户改动。

### 完成定义

Agent 在修改前能说明仓库规则和 Git 状态，结束时能准确报告自己产生的变更。

实现位置：`src/repository/instructions.ts`、`src/repository/git.ts`、`src/repository/tools.ts`。CLI 注入受限 `AGENTS.md` 上下文并注册只读仓库工具；Git 查询固定使用无 shell 的只读 argv，运行结果交叉标记用户已有修改、Agent 修改和重叠文件。

## 阶段五：任务状态机与强制验证闭环（下一步，P0）

### 目标

任务是否完成由状态和验证证据决定，而不是由模型单方面声明。

### 状态

```text
created -> analyzing -> planning -> executing -> validating
                                      ^              |
                                      |              v
                                  repairing <- 验证失败

终态：completed | completed_with_unverified_changes | blocked | cancelled | failed
```

### 范围

- 新增独立于单次 run 的 Task 实体，保存目标、计划、状态转换、关联 run、审批和验证记录。
- 模型可以提出计划，用户可以批准、修改或跳过。
- 代码发生变化后默认进入 `validating`。
- 根据变更和仓库配置选择类型检查、测试、格式检查或构建命令。
- 验证失败自动进入 `repairing`，将结构化失败摘要回传模型。
- 未产生验证证据时不能以普通 `completed` 结束；用户明确跳过时记录豁免原因。

### 完成定义

每个任务都能回答：改了什么、如何验证、未验证时为什么。

### 首批交付顺序

1. 定义 `Task`、状态转换和 SQLite 表，禁止非法跳转。
2. 将 Agent run、Git 基线、审批和验证结果关联到 Task。
3. 变更后自动进入 `validating`，先接入 `npx tsc --noEmit`、`npm test` 和 `git diff --check`。
4. 验证失败进入 `repairing`，仅把结构化错误摘要回传模型；验证通过才允许 `completed`。
5. 补充“未验证完成”的显式豁免与审计测试，再开放 CLI 展示。

## 阶段六：持久任务恢复 CLI/API

### 目标

把已有 Session、checkpoint、审计和 artifact 基础变成可操作的任务恢复能力。

### 范围

- CLI/API 支持创建、列出、查看、取消和恢复任务。
- 展示状态、最后 checkpoint、待审批操作、最后错误和验证结果。
- 恢复时只重放未完成的安全操作；已完成 tool call 从 checkpoint 读取。
- 恢复前重新校验 workspace、Git 基线、Helper 版本和 MCP Server 身份。
- workspace、环境或协议发生变化时转为 `blocked`，不得静默继续。
- CLI 与 API 共享同一个 TaskService 和恢复逻辑。

### 完成定义

进程异常退出后，用户可以安全查看并继续未完成任务，不需要模型猜测此前已经执行过的操作。

## 阶段七：Skills

### 目标

将重复的专业工作流做成可发现、版本化、受权限控制的能力包。

### 范围

- Skill 目录包含 manifest、指令、可选模板/脚本和依赖声明。
- 支持用户级和仓库级来源，仓库级 Skill 受 workspace 边界限制。
- manifest 声明名称、版本、适用条件、所需 Capability、MCP 依赖和输入 schema。
- 只有验证通过且策略允许的 Skill 才能进入模型上下文。
- Skill 指令带来源标记并受独立上下文预算约束。
- Skill 的文件、命令、网络和 MCP 操作继续使用既有 Approval、Capability、Sandbox 和审计。
- 禁止隐式安装依赖、启动未声明程序或扩大权限。

### 初始 Skill

优先实现 `review`、`test-and-fix`、`release-check`、`documentation` 和 `migration`。

### 完成定义

Skill 只是受控工作流和资源集合，不能形成绕过 Agent 安全边界的第二套插件执行通道。

## 分支与依赖

```text
codex/sandbox-v2-hardening
codex/openai-responses
codex/mcp-stdio-tools
codex/repository-context-git
codex/task-validation-loop
codex/task-recovery-interface
codex/skills-foundation
```

每个分支只处理一个阶段。MCP Server 启动必须等待 Sandbox V2；Skills 必须等待 MCP、仓库上下文和任务状态机稳定后再开发。

## 当前下一步计划

| 优先级 | 交付 | 主要验收 |
| --- | --- | --- |
| P0 | Task 状态机与强制验证闭环 | 非法状态拒绝；变更后必须验证；失败可修复并留证据 |
| P1 | 任务恢复 CLI/API | 列出、查看、取消、恢复；重新校验 workspace、Git 基线、Helper 和 MCP 身份 |
| P1 | Sandbox 纵深补强 | Linux `/proc`/设备和 Windows 网络/注册表策略有真实逃逸回归 |
| P2 | Skills 基础 | manifest、版本、来源、依赖和 Capability/Approval 继承 |
| P2 | 多 provider 与网络策略 | Anthropic adapter；联网 Capability 具备域名/IP/端口绑定和独立审批 |

每个阶段交付前必须通过 `npm test`、`npx tsc --noEmit`、`git diff --check`、Rust 测试以及对应平台安全回归；未通过的能力不得写入“已完成”。

## 核心完成标准

完成 Skills 基础后，项目可称为核心 coding agent 平台完成：具备安全执行、主流模型协议、外部工具、仓库理解、任务验证、持久恢复和专业工作流扩展。远程 MCP、网络 Capability、多 Agent、worktree、容器和 VM 属于后续扩展，不阻塞核心版本。
