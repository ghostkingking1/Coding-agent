# SWEagent 源码课程大纲

> 本文件既是**课程大纲**，也承载已经展开的课程正文。每课给出「读完能回答的问题」+「真实文件与符号的阅读顺序」+「选读验证」+「暂缓项归属」；被展开的课程会就地补上完整讲解（场景与目标 → 主链与阅读顺序 → 沿流程带读 → 重要分支 → 完整流程串联 → 复述任务）。
>
> **当前进度：** `01` 已展开；`02`–`20` 仍为 `大纲`。需要展开哪一课，用编号指定，我再沿真实调用链把那一课写开（按规范只更新指定课程，不动其他课程与你自己加的内容）。

---

## 一、这份大纲的定位

### 项目用途

一个**原生的 TypeScript coding agent**（CLI 命令名 `veil`）：在受控工作区内，用大模型驱动一个「模型请求工具 → 工具执行 → 结果回传模型」的有限循环，完成文件读取、代码修改、命令执行和测试验证，并在运行结束时给出本次改动的 unified diff。

项目对外的一个重要特征是**零 Agent 框架依赖**：不使用 LangChain / LangGraph，运行时依赖只有 `diff` 和 `zod` 两个包，Agent 循环、工具注册表、审批策略、上下文压缩全部自研。

另一个特征是**没有构建步骤**：`npm start` 直接用 `node --experimental-strip-types src/cli.ts` 跑 TypeScript 源码，类型检查单独用 `npx tsc --noEmit` 做。所以「读源码 = 读运行时真正执行的东西」，不存在编译产物与源码不一致的问题。

### 本次学习目标

把项目从「一条端到端主链」开始重建理解，逐层下钻到：执行循环、上下文预算、工具与审批安全链、模型协议适配、持久化与恢复、变更追踪、任务验证、以及 MCP / Skill 两个扩展机制。

### 源码版本

| 项 | 值 |
| --- | --- |
| HEAD commit | `053b921bfe76c25d520bc60b1a114a7dc704d849` |
| commit 标题 | `feat(agent): enforce coding task verification` |
| 提交时间 | 2026-09-13 17:05:35 +0800 |
| 当前分支 | `codex/skills-foundation` |
| 工作区状态 | 干净，无未提交改动 |

**影响结论的本地改动：无。** 工作区与 HEAD 一致，因此本大纲中的所有路径与符号都对应这个 commit，后续你改了代码需要重新核对。

### 规模基线（用于判断每课的阅读量）

| 区域 | 文件数 | 行数 |
| --- | --- | --- |
| `src/agent/` | 10 | 1,969 |
| `src/tools/` | 15 | 2,253 |
| `src/model/` | 6 | 899 |
| `src/repository/` | 3 | 244 |
| `src/skill/` | 5 | 396 |
| `src/cli.ts` + `src/index.ts` | 2 | 522 |
| `test/` | 21 | 2,977 |
| `sandbox-helper/src/main.rs` | 1 | 1,814 |
| `docs/` | 13 | 1,339 |

生产 TypeScript 约 **6,300 行**，Rust helper **1,814 行**，测试约 **3,000 行**。全项目合计约 **12,663 行**。

### 前置基础

按必要性排序，标 ★ 的是没有会卡住的：

| 知识点 | 为何需要 | 在本项目中的位置 | 必要性 |
| --- | --- | --- | --- |
| TypeScript 严格模式 + ESM | 全部生产代码是 `.ts` 且 `"type": "module"`，导入路径带 `.ts` 后缀 | `tsconfig.json`、所有 `src/**` | ★ |
| Node.js 22+ 运行时特性 | `--experimental-strip-types`（直接跑 TS）、`--env-file-if-exists`、`node:test` | `package.json` scripts | ★ |
| `AbortSignal` 与取消传播 | 模型请求、命令执行、MCP 调用全部接受取消信号 | `ModelRequest.signal`、`ExecutionRequest` | ★ |
| Zod | 工具**执行侧**输入校验，与模型侧 JSON Schema 是两套 | `src/tools/tool-input-schemas.ts` | ★ |
| LLM 工具调用协议 | `tool_calls` / function calling、tool result 关联、SSE 增量 | `src/model/openai-compatible.ts` | ★ |
| SQLite 基础 | Session 与审计持久化 | `src/agent/sqlite-session-store.ts` | 中 |
| 进程与 OS 安全概念 | realpath、符号链接逃逸、进程树终止、Job Object / namespace / seccomp | `src/tools/security.ts`、`sandbox-helper/` | 中 |
| Rust 基础语法 | 第 08 课要读 1,814 行 Rust | `sandbox-helper/src/main.rs` | 仅第 08 课 |

### 覆盖范围与尚未覆盖

**本大纲覆盖：** `src/` 全部五个模块、`src/cli.ts` 与 `src/index.ts`、`sandbox-helper/`、`test/` 全部 21 个测试文件、`docs/` 中与实现对应的链路文档。

**本次不覆盖：**

- `docs/official-coding-agent-gap-analysis.md` 的逐条差距论证——只在第 20 课作为「路线图与边界」的阅读材料引入，不单独成课。
- CLI 的 TTY / REPL 交互细节（含终端渲染、单行摘要格式）——属于第 01 课的选读，不单独成课。
- `sandbox-helper/target/` 构建产物、`bin/veil.js` 启动壳——非逻辑代码，不单独成课。
- 仓库内**未见 CI 配置**（无 `.github/` 目录），因此没有「CI 流水线」这一课；质量门禁目前靠第 19 课的本地命令清单。

---

## 二、主线：先用一条流程建立全貌

第 01 课会完整走通这条链路，后面所有课程都是把其中某一段放大。先看全貌，再看局部——这是本大纲的排序依据。

```text
用户输入 veil "<请求>"
  -> src/cli.ts 解析参数 / 进入 TTY REPL
  -> 组装 workspace policy、工具注册表、模型客户端
  -> Session 或 Agent.run(input)
  -> ContextManager 从完整 transcript 生成「模型视图」
  -> ModelClient.generate()  -> HTTP transport -> provider adapter
  -> 返回 assistant 文本 或 tool_calls
        |                          |
        | 无 tool call             | 有 tool call
        v                          v
     finalText              ToolRegistry.execute(name, input, ctx)
                                   |  1. Zod 校验输入
                                   |  2. SecurityPolicy 判定 capability
                                   |  3. 需要副作用 -> 生成预览 + 请求审批
                                   |  4. 经 SandboxBackend 执行（命令类）
                                   v
                             ToolMessage 回灌 transcript
                                   |
                                   +--> 回到下一轮模型请求（受 maxSteps 限制）

运行结束
  -> AgentResult = finalText + messages + steps + stopReason
  -> RunChangeTracker 比对运行前后快照 -> RunDiff
  -> Session 提交消息到 SQLite（失败则不提交）
```

---

## 三、课程清单

课程按**学习依赖**排序，不按目录结构排序。每课都能独立回答一个具体问题。

### 第一段：建立全貌

#### 01 项目全貌与端到端主链：`veil "..."` 从输入到回答走了哪些层

**状态：** `已展开`

---

##### 1. 场景与目标

**触发：** 在终端执行 `veil "修复 calculateTotal 的空数组问题并跑测试"`，或全局安装后 `npm start -- "<请求>"`。

**学完这一课你应该能解释：**

- 一次请求从 `process.argv` 到最终输出，经过哪些模块，**谁创建了谁**；
- 哪一步是"模型决定的"，哪一步是"代码写死的"——这个边界是整个项目的设计核心；
- 为什么同一份 CLI 代码在 TTY 和非 TTY 下行为完全不同；
- 为什么"模型请求要审批"和"工具要审批"是**两套独立的策略**。

**最少前置概念：** 三个够用了。

1. **工具调用（tool calling）** —— 模型可以返回的不是纯文本，而是一组"我要调用某某工具、参数是这些"的结构化请求；Agent 执行完再把结果塞回对话，让模型继续。本项目整个循环就建立在这上面。
2. **`AgentResult`** —— 一次运行的返回值：最终文本 + 完整消息 + 步数 + 停止原因 + 可选 diff。
3. **`AbortSignal`** —— Node 的取消信号。本项目把它一路透传到模型请求和子进程。

---

##### 2. 主链与阅读顺序

**完整主链（先看这个）：**

```text
bin/veil.js
  -> src/cli.ts  main()
       |- 参数判定（--help / --version / 有请求 / 无请求）
       |- WorkspacePolicy({ root: process.cwd() })     工作区 = 当前目录
       |- readModelRuntimeConfig(process.env)          .env -> config
       |- loadRepositoryContext(root)                   AGENTS.md + Git + 基线
       |- createConfiguredModelClient(config, ...)      模型（审批恒真）
       |- ToolRegistry(SecurityPolicy(工具审批回调))
       |- registerCliTools(registry, workspace, ...)    决定暴露哪些工具
       |- new Agent(model, registry, { systemPrompt, verification, changeTracker })
       `- agent.run(input, { gitChangeTracker })
              |
              v
        Agent.run()                      agent.ts:56
          |- changeTracker.start()       工作区快照 baseline
          |- gitChangeTracker.start()    Git 基线
          `- executeRun()                agent.ts:81
                 |- TaskStateMachine.start()
                 |- 注入 system prompt / skill context / user message
                 `- for (step = 1; step <= maxSteps; step++)
                        |- ContextManager.compact()   生成「模型视图」
                        |- ModelClient.generate()     受重试策略包裹
                        |- messages.push(assistant)
                        |- checkpoint(phase: "model")
                        |- calls.length === 0 ? 收尾 : executePendingCalls()
                               |- executeToolBatch()      并发/串行波次
                               |     `- ToolRegistry.execute()
                               |           `- SecurityPolicy 审批
                               `- checkpoint(phase: "tool")
                 |
                 `-> finishResult()   run-diff -> AgentResult
       |
       `- console.log(finalText) / printRunDiff / printGitChanges
```

**必读路径与符号（严格按此顺序）：**

| # | 位置 | 看什么 | 看完能说出 |
| --- | --- | --- | --- |
| 1 | `package.json` | `scripts.start` | 为什么这个项目**没有构建步骤**——`node --experimental-strip-types src/cli.ts` 直接跑 TS 源码，所以读源码等于读运行时装的东西 |
| 2 | `bin/veil.js` | 全局命令壳 | 安装成 `veil` 后请求怎么进到 `cli.ts` |
| 3 | `src/cli.ts:411-423` | `isMainModule()` | 用 `pathToFileURL(resolve(argv[1])).href === import.meta.url` 判断"是被当入口跑还是被 import"，所以 `test/cli.test.ts` 能直接 import 它而不触发副作用 |
| 4 | `src/cli.ts:133-186` | `main()` | 整条一次性运行路径的装配顺序；**这里是全项目的依赖装配中心** |
| 5 | `src/cli.ts:37` | `CLI_MODEL_TOOL_NAMES` | 暴露给模型的 5 个工具名单，且它的顺序与注册顺序一致 |
| 6 | `src/cli.ts:102-112` | `registerCliTools` | 暴露范围**由环境变量决定**（下面分支 D 讲） |
| 7 | `src/cli.ts:115-131` | `LazyConfiguredModel` | 为什么 `veil` 启动不校验模型配置——延迟到第一次 `generate()` 才初始化 |
| 8 | `src/index.ts` | 导出清单 | **项目架构地图**。这份清单就是"公共契约有哪些"的完整答案，建议完整过一遍 |
| 9 | `src/agent/types.ts` | `AgentOptions` / `AgentRunOptions` / `AgentResult` / `RunEvent` / `ModelClient` / `Tool` | 先读契约再读实现，`agent.ts` 会变得非常好读 |
| 10 | `src/agent/agent.ts:56-79` | `Agent.run()` | 入口校验、消息来源、**changeTracker 的所有权与释放规则** |
| 11 | `src/agent/agent.ts:81-159` | `executeRun()` | 主循环本体、门禁提示注入、终止判定的三个出口 |
| 12 | `src/agent/agent.ts:219-245` | `executePendingCalls()` | 一批工具调用的收尾：写消息、喂验证器、checkpoint、发事件 |
| 13 | `src/agent/agent.ts:247-269` | `executeToolBatch()` | 并发/串行的波次算法，以及**为什么结果要按声明顺序回传** |
| 14 | `src/agent/agent.ts:161-175` | `finishResult()` | `AgentResult` 是怎么拼出来的 |
| 15 | `src/agent/agent.ts:20-22` | 两个常量 | `DEFAULT_MAX_STEPS = 8`、`DEFAULT_CONTEXT_BUDGET = 32_000 tokens` |
| 16 | `docs/agent-flow-user-request.md` | 官方主链文档 | 对照代码验证。**文档与实现冲突时以实现为准** |

**选读证据：**

- `test/cli.test.ts:14-26` —— 直接断言 `registry.list()` 等于 `CLI_MODEL_TOOL_NAMES`，并且 `registry.get("run_command") === undefined`。**这是"CLI 不给模型 run_command"这一条的权威规格。**
- `test/agent/agent.test.ts`（20 处 `test()`）—— 循环行为、批次编排、取消的规格说明。第 02 课会细读，本课只需要确认"这些行为是被测试锁死的"。

**本课暂缓（都有明确归属）：**

- 上下文压缩的降级链细节 → **第 03 课**
- 工具的 Zod schema / capability 声明 → **第 04 课**
- 审批策略与工作区边界的内部实现 → **第 05 课**
- 重试退避的错误分类表 → **第 11 课**
- `RunChangeTracker` 的快照算法与 SHA-256 比对 → **第 14 课**
- `TaskStateMachine` 的状态转移合法性 → **第 15 课**

---

##### 3. 沿流程带读

###### 3.1 CLI 入口：先分流，再装配

`src/cli.ts:411-418` 用 `isMainModule()` 包住 `await main()`，失败时把错误信息打到 `console.error` 并把 `process.exitCode` 设为 1。**注意它不 `throw` 出去**——这样顶层不会留下未处理的 Promise rejection 噪音。

`main()` 的第一个动作是分四种情况：

1. 取命令行参数；
2. 参数里含 `--help` 或 `-h` → 打印用法后返回；
3. 参数里含 `--version` 或 `-v` → 打印 `veil 0.1.0` 后返回；
4. 其余参数拼成一个请求字符串；
5. 请求为空 → 走无参数分支（TTY 进 REPL，非 TTY 报错退出）；
6. 否则 → 走一次性运行。

三个容易被忽略的细节：

- **`--help` 和 `--version` 是"包含判定"，不是"第一参数判定"。** 所以 `veil "解释一下 --help"` 会打印用法而不是执行请求。这是有意还是疏漏，代码里没有说明——**如果你要改，这是第一个该动的地方**（可以记为待改进项）。
- **`args.join(" ")` 把多参数拼成一个请求字符串。** 所以 `veil 修复 bug` 和 `veil "修复 bug"` 等价。反过来说，请求里的引号由 shell 剥离，代码这一层看不到。
- **版本号 `veil 0.1.0` 是硬编码的**，和 `package.json` 的 `version` 是两个来源。改版本时别漏。

###### 3.2 依赖装配：六个对象，顺序有讲究

`src/cli.ts:158-179` 是**全项目唯一一处把主要部件装配到一起的地方**。按依赖顺序看：

① `WorkspacePolicy` —— 用当前终端目录（`process.cwd()`）建立工作区；
② `readModelRuntimeConfig(process.env)` —— 读环境变量里的模型配置；
③ 配置为空 → **直接抛错**（`No model configured`），不降级成模拟模型；
④ `loadRepositoryContext` 用 ① 的 root 加载仓库上下文；
⑤ `createTerminalPrompt()` —— 建终端交互对象；
⑥ `try` 块内按顺序装配：
   - `createConfiguredModelClient` 建模型客户端（审批恒真）；
   - `ToolRegistry` + `SecurityPolicy` 建工具注册表（审批转发给 `prompt.confirmTool`）；
   - `registerCliTools` 注册工具；
   - `new Agent(model, registry, {...}).run(input, {...})` 跑主循环；
⑦ `finally` 块：`prompt.close()` —— 无论成功还是抛异常，readline 一定被关掉。

四个必须理解的点：

**① 工作区就是当前终端目录。** `process.cwd()`。所以 `veil` 能操作什么，取决于你在哪个目录敲的命令——这也解释了为什么 README 强调"当前终端目录会作为 workspace"。

**② 配置缺失时是 `throw`，不是降级成模拟模型。** 这一点在 README 里专门写过："未配置时该请求会明确报错，不会降级为模拟模型"。**设计意图很清楚：宁可失败，也不让用户以为自己在跟真模型说话。** 这是本项目管理风格的一个缩影——后面你会反复看到同一种取舍：**fail closed，不猜、不降级。**

**③ `WorkspacePolicy` 先于 `config` 创建。** 因为 `loadRepositoryContext(workspace.root)` 要用它解析出来的 root。

**④ `try/finally` 只包住 `prompt.close()`。** 也就是说：无论 Agent 跑成功还是抛异常，readline 一定会被关掉。**这是 CLI 层唯一的资源清理点**，值得记住。

###### 3.3 两套审批：这是本课最重要的一节

项目里有**两处**注入审批，策略完全不同：

**模型审批 —— 恒真放行**：`DefaultModelApprovalPolicy(() => true)`。

**工具审批 —— 逐次询问**：`DefaultApprovalPolicy`，实际动作是转发给终端的 `prompt.confirmTool`。

**同一个概念（审批），两套完全不同的策略。** 先说事实：

- **模型审批默认放行**，理由写在 `src/cli.ts:165` 的注释里：*"模型服务由本机 .env 显式配置，CLI 将其视为会话级授权，不逐次打断用户。"* 也就是说——**你写下完整的 `.env` 配置这个动作本身，被解释为"我授权这个模型服务在本次会话中接收我的对话内容"**。
- **工具审批逐次询问**，因为工具的副作用是**不可逆的**（改文件、跑命令），而模型请求只是把内容发出去。

再看 `createTerminalPrompt()`（`src/cli.ts:337-355`）在非 TTY 时的行为：

`createTerminalPrompt` 先判 stdin 和 stdout 是不是 TTY：**只要有一个不是**，就返回一个降级版 —— 审批回调恒返回 `false`（永远拒绝），关闭动作是空操作。

**非 TTY 环境下所有需要审批的工具一律被拒。** 这就把 README 那句"非 TTY 环境默认拒绝这些副作用"落到了实处——它不是靠文档约定，是靠这个恒 `false` 的回调。

> **为什么这么设计：** 自动化环境（CI、管道、被别的程序调用）里没有人能回答"要不要执行"。此时如果默认放行，一个被注入的请求就能改文件、跑命令。**默认拒绝是唯一安全的选择。**
>
> **代价：** 想在脚本里用 `veil` 做自动化，必须自己注入一个 `ApprovalPolicy`——CLI 没有提供"非交互式放行"的开关，这个能力目前只在程序化调用（直接 `new Agent(...)`）路径上存在。**如果你后续要做 CI 集成，这是第一个要补的缺口。**

###### 3.4 工具暴露范围：由环境变量决定

`registerCliTools(registry, workspace, helperPath, repositoryTools)`（`src/cli.ts:102-112`），其中 `helperPath` 默认取环境变量 `CODING_AGENT_SANDBOX_HELPER`。它按这个变量分两条路走：

**分支一 —— 没配沙箱 helper：** 不注册 `run_command`；`createWorkspaceTools` 产出的其余 5 个工具，加上全部仓库工具，照常注册。

**分支二 —— 配了 helper：** 先造一个 `RustHelperSandboxBackend`，调 `assertAvailable` 验证它真能提供四类隔离能力 —— 进程创建（`process.spawn`）、工作区文件访问（`workspace.fs`）、断网（`network.off`）、操作系统级隔离（`os.isolation`）。**四项全过之后**，才把 `createWorkspaceTools` 的**全部 6 个**工具（含 `run_command`）连同仓库工具一起注册。

所以要看清 `createWorkspaceTools` 到底产出什么（`src/tools/workspace-tools.ts:26-111`）。它返回 **6 个工具，顺序固定**：

1. `read_file`
2. `list_files`
3. `apply_patch`（来自 `createPatchTool`）
4. `run_command`（来自 `createRunCommandTool`）
5. `run_tests`（来自 `createRunTestsTool`）
6. `search_text`

**分支一过滤掉 `run_command` 后正好剩 5 个**，就是 `CLI_MODEL_TOOL_NAMES` 的内容——顺序都对得上。`test/cli.test.ts:20` 用 `assert.deepEqual` 锁死了这个顺序。

三个关键理解：

**① `run_command` 给不给模型，取决于 `CODING_AGENT_SANDBOX_HELPER` 这个环境变量有没有值。** 不是无条件不给。默认情况下（大多数人没设这个变量）走分支一，模型拿不到通用命令工具——这就是 README 那句"CLI 不向模型开放通用 `run_command`"的真实条件。**这也是本大纲第 20 课落差表里第 4 项的答案。**

**② `assertAvailable([...])` 失败会抛异常，而这个异常没有被 catch。** 它会一路冒到 `main()` 的调用方，被 `isMainModule()` 那个 `try/catch` 打印成错误并退出。**换句话说：声称有隔离能力但实际证明不了，就不注册任何工具——直接不启动。** 这比"降级到无隔离执行"安全得多，也正是"fail closed"在这个项目里的字面实现。

**③ 分支二注册的是 6 个工具，比分支一多一个 `run_command`。** 所以同一个二进制在不同机器上暴露给模型的工具清单可能不同。**这解释了为什么 `CLI_MODEL_TOOL_NAMES` 这个常量只被测试引用、没被生产代码引用**——它记录的是"默认情况下的期望清单"，而不是运行时的事实来源。

###### 3.5 `Agent.run()`：入口校验与 tracker 的所有权

`src/agent/agent.ts:56-79` 的 `Agent.run(input, runOptions)` 做四件事：

1. **入口校验**：`input` 去空白后为空 → 直接抛错 `Agent input must not be empty`；
2. **定消息起点**：三选一，优先级是「恢复点 `resumeCheckpoint` 里的 messages」>「调用方传的 `initialMessages`」>「空数组」；
3. **定追踪器归谁**：调用方传了、或 Agent 配置里带了 `changeTracker` → 用它，`ownsChangeTracker = false`；两者都没有、且 `includeRunDiff` 没被关掉 → Agent 自己建一个 `RunChangeTracker`，`ownsChangeTracker = true`。若 `includeRunDiff === false`，这轮**根本没有追踪器**；
4. **启动 → 跑 → 兜底释放**：先启动追踪器快照，再进 `executeRun` 跑主循环；正常结束打上 `completed = true`；**无论是哪条路**，`finally` 里都判 `ownsChangeTracker || !completed` 决定要不要 `dispose()`。

**追踪器的释放规则值得单独记，因为它有两个触发点、容易看漏：**

| 场景 | `ownsChangeTracker` | `completed` | `finally` 里是否 dispose | 实际谁来清理 |
| --- | --- | --- | --- | --- |
| Agent 自建 tracker，正常结束 | `true` | `true` | **是** | `finally` |
| Agent 自建 tracker，抛异常 | `true` | `false` | **是** | `finally` |
| CLI 传入 tracker，正常结束 | `false` | `true` | **否** | **`finish()` 内部** |
| CLI 传入 tracker，抛异常 | `false` | `false` | **是** | `finally` |

第三行是最绕的。答案在 `run-diff.ts:155-159`：

1. **选比对方式**：没有 root 或没有基线快照 → 走 `finishFallback`（兜底比对）；否则走 `finishSnapshot`（快照比对）；
2. **顺手清理**：`reuseBaseline` 为假就调 `dispose()` —— 这就是「CLI 传进来的 tracker 由 `finish()` 自己清理」那句的落点；
3. 返回 diff。

**`dispose()` 发生在返回 diff 之前**，删掉的是临时基线目录。CLI 一次性运行时 `new RunChangeTracker({ root })` 没传 `reuseBaseline`，默认 `false`，所以正常路径下由 `finish()` 清理。

而在 REPL 里（`src/cli.ts:196`）传的是 `reuseBaseline: true`，`finish()` **就不会**清理——因为下一轮输入还要拿这一轮的终态当新基线。此时由 `runInteractiveSession` 的 `finally`（`src/cli.ts:260`）显式 `runTracker.dispose()`，以及在请求失败后重建 tracker 前也会先 `dispose()`（`src/cli.ts:252-253`）。

> **这是"所有权"最典型的写法：谁创建谁释放，但可复用的对象要把释放权交还给调用方。** 判断依据是一个明确的布尔量 `ownsChangeTracker` + `reuseBaseline`，而不是靠约定。**值得学的点：把所有权写成代码里的显式条件，而不是注释里的君子协定。**

兜底还有一层：`cleanupStaleBaselineDirectories`（`run-diff.ts:48`）按 mtime 清理超龄的残留基线目录——防的是进程被 `kill -9` 这类连 `finally` 都跑不到的情况。

###### 3.6 主循环：三个出口，一个门禁

`executeRun`（`agent.ts:81-159`）是核心。先看**准备阶段**（81-111）：

1. **建验证器**：`verification.mode === "coding"` 时创建 `TaskStateMachine`，并把它的状态转移转成 `task_state_changed` 事件往外发；其他模式没有验证逻辑。建完立刻 `start()`；
2. **判断是不是恢复运行**：看调用方有没有传 `resumeCheckpoint`；
3. **注入 system prompt**：没在恢复、配了 `systemPrompt`、且现有消息里还没有 system 角色 → 追加一条；
4. **注入 skill 上下文**：没在恢复、配了 `skillContext` → 调它拿内容，拿到非空值才追加一条 system；
5. **注入用户输入**：没在恢复 → 把 `input` 作为 user 消息压进 `messages`。

**注意三个 `!resumed` 守卫。** 恢复运行时不重新注入——因为那些消息已经在 checkpoint 的 `messages` 里了，重复注入会让同一条 system prompt 出现两次。

**system prompt 注入还有一个额外的 `messages.some(role === "system")` 检查**：如果调用方通过 `initialMessages` 自己塞了 system 消息，Agent 就不覆盖它。**这是"调用方优先"原则。**

然后是**循环本体**（113-154），逐步看：

`maxSteps` 是循环上限（默认 `DEFAULT_MAX_STEPS = 8`）。每一轮做这些事：

① **查取消** —— 每轮开头调一次 `signal.throwIfAborted()`；
② 通知验证器开始工作（`verification.beginWork()`）；
③ 发 `model_started` 事件；

④ **组装本次模型视图**。若验证器判定"改了东西但没过验证"（`requiresVerification` 为真），就在**临时副本**里追加一条 system 消息，内容是"工作区被改过但验证没过，你必须调 `run_tests` 才能收尾"；否则直接用 `messages` 本身。**这条门禁消息只存在于本次模型视图，不写回 `messages`**；

⑤ 交给 `contextManager.compact` 按上下文预算压缩（默认 `DEFAULT_CONTEXT_BUDGET`）；
⑥ 组装请求：压缩后的消息 + 当前工具清单（`tools.listModelDefinitions()`）+ 取消信号；
⑦ 用 `generateWithRetry` 带重试地请求模型；回来的 `usage` 存在就交给 `contextManager.observeUsage`；
⑧ ④～⑦ 整体包在 `try` 里：模型层抛错 → 先发 `run_failed` 事件，**再把错误原样抛出**，整个 run 到此终止；

⑨ 把模型返回的原始消息压进 `messages` —— **`toolCalls` 必须原样保留**；
⑩ checkpoint 一次，阶段记 `"model"`；
⑪ 取 `response.message.toolCalls`，为空 → 进入出口 A / 出口 B；
⑫ 有工具调用 → 交给 `executePendingCalls` 执行；
⑬ 执行完若验证器已判死（`isBlocked`）→ 以 `blocked` 收尾。

循环正常跑完（步数用尽）→ 落到出口 C。

**关于第 ① 步：取消检查为什么放在每轮开头。** 不在轮中检查，因为一轮内的取消由 `signal` 透传到模型请求和子进程自己处理。

**关于第 ④ 步：门禁提示是本课最精巧的一处设计。** 当"工作区被改过但验证没通过"时，Agent 会**临时往模型视图里插一条 system 消息**，命令模型去跑测试。关键是这段代码的注释写明了动机：

> *"门禁提示只存在于本次模型视图，不写入 canonical transcript，避免污染 Session 恢复上下文。"*

也就是说：`messages`（canonical transcript，运行事实记录）**不会**被加进这条提示；只有送给模型的 `modelMessages` 会。这样恢复会话时不会看到一条莫名其妙、只出现过一次的 system 指令。**"事实记录"和"模型视图"分离——这是整个项目反复出现的一条主线，第 03 课会系统讲。**

**关于第 ⑧ 步：模型层异常直接 `throw`，不返回结果。** 对比一下工具异常（3.7 节）——**工具失败会变成一条 tool message 继续跑，模型失败会终止整个 run。** 这个不对称非常重要：工具失败模型还能自我修复，模型挂了就没有下一步了。

**关于第 ⑨ 步：压进 `messages` 的是原始 `ModelResponse.message`，包含原始 `toolCalls`。** 源码注释：*"保留原始工具调用，下一轮 provider 才能正确关联对应的 tool result。"* 如果你把 `toolCalls` 洗掉只留文本，下一轮 provider 就无法把 `tool` 消息和 `assistant` 消息对上，tool calling 协议直接坏掉。

**出口 A —— 无 tool call，且不需要验证：** 先让验证器 `complete()`，然后以 `stopReason = "completed"` 收尾，`finalText` 就是 assistant 的 `content`。

**出口 B —— 无 tool call，但"改了东西还没验证"：**

1. 通知验证器"这里需要验证"（`noteVerificationRequired`）；
2. 验证器**还没判死**（`!isBlocked`）→ `continue`，**回到循环、带着门禁提示再问一次模型**；
3. 已判死 → 以 `stopReason = "blocked"` 收尾。

**模型想收尾，代码不让。** 这是"完成由证据决定、不由模型声明决定"在循环层的落地（第 15 课展开）。`continue` 会带着第 ④ 步那条门禁提示再请求一次模型；只有当验证器判定"已经没救了"（`isBlocked`）才以 `blocked` 收尾。

**出口 C —— 步数用尽：**

1. 若还处在"需要验证"状态 → 调验证器的 `block`，理由是"验证前就用完了模型步数"；
2. `stopReason` 取 `isBlocked ? "blocked" : "max_steps"`；
3. 以这个 stopReason 收尾，**最终文本是空字符串**。

注意 `finalText` 是**空字符串**——步数用尽时没有可交付的回答。`DEFAULT_MAX_STEPS = 8`（`agent.ts:20`），构造时校验必须为正整数（`agent.ts:42-44`），非法直接抛错。

###### 3.7 一批工具调用：并发、串行与顺序回传

`executePendingCalls`（`agent.ts:219-245`）做四件事：发批次开始事件、执行批次、把结果写进 `messages`、喂验证器并 checkpoint。

**执行批次**（`agent.ts:247-269`）是波次算法：

1. 准备两个数组：结果数组、当前波次数组（初始为空）；
2. 定义 `flush`：波次为空就跳过；否则把波次整体拷出来、清空，然后**并发**跑完这一波（`Promise.all`），结果追加进结果数组；
3. 按 `calls` 顺序逐个看：只要命中任一门槛（不可并行 / 波次已满 / 与波内冲突），就先 `flush` 一次；
4. 若命中的是"不可并行" —— **立刻单独串行执行**这一个调用，然后 `continue`；
5. 其余情况把调用压进波次，等后面一起并发；
6. 全部扫完后再 `flush` 一次；
7. 结果**按 `calls` 的原始声明顺序**重排后返回。

三个门槛决定一次工具调用是进"并行波次"还是立刻串行：

| 条件 | 含义 |
| --- | --- |
| `!isParallelizable(call)` | 工具 manifest 没声明 `parallelizable: true` → **永远串行** |
| `wave.length >= maxConcurrentToolCalls` | 当前波次已达上限（默认 **4**，`agent.ts:45`）→ 先冲刷再重新攒 |
| `conflicts(call, wave)` | 与同波次里的某个调用**冲突键相同** → 先冲刷，避免并发改同一个资源 |

`conflicts` 的判据是 `manifest.conflictKey(input)` 的返回值是否相等。看 `workspace-tools.ts` 里的实际实现：

- `read_file` → `` `file:${input.path}` ``
- `list_files` → `` `directory:${input.path}` ``
- `search_text` → `` `search:${input.path}` ``

所以**读同一个文件的两次 `read_file` 会被判为冲突、串行执行**。这个取舍偏保守——两个纯读操作其实并发是安全的。**代码没有为读操作开特例，说明作者把"正确"放在"极致并发"之前。** 想改成"读读可并发、读写/写写串行"，就得让 `conflictKey` 带上能力类别——这是个合理的优化方向。

**最后一步是这一节的结论：按 `calls` 的原始声明顺序重新排列结果。** 前面 `Promise.all` 的完成顺序是不确定的，但回传给模型的 `tool` 消息必须和 `assistant` 里声明 `toolCalls` 的顺序对齐——否则 provider 侧关联会错乱。**"并发执行、按声明顺序回传"是这一步的全部意义。**

**幂等与重放**（`agent.ts:271-280`）：

1. 拼幂等键：`runId`（缺省用 `"run"`）+ `step` + `toolCallId`，冒号连接；
2. 拿这个键去 `replayToolResults` 里查；
3. 命中 → 直接拼一条 tool 消息返回，**不执行任何工具**；`succeeded` 靠 `isToolErrorMessage` 判，`rawResult` 从缓存反序列化。

恢复运行时命中缓存的调用**不产生任何副作用**，直接拿 checkpoint 里的结果拼一条 tool 消息。这就是"已完成工具不重放"的实现（第 13 课细讲）。

**单个工具执行**（`agent.ts:294-318`）——注意异常处理：

- **成功**：调 `tools.execute` 执行 → 发 `tool_completed` 事件 → 把结果序列化后包成一条 tool 消息，`succeeded: true`，原始结果一并带出；
- **失败**：`catch` 住任何异常 → 发 `tool_failed` 事件 → 把异常信息包成 `{"error": "..."}` 的 tool 消息，`succeeded: false`。

**run 不会因为工具失败而中断。** 审批拒绝（`ApprovalDeniedError`）、路径越界（`WorkspaceSecurityError`）、命令超时——全都走失败那条路。

这个 `{ error }` 的形状有讲究：`agent.ts:367-372` 的 `isToolErrorMessage` 要求对象**恰好有且仅有 `error` 一个键**，用来在统计成功/失败数时区分"真错误"和"碰巧也带 error 字段的正常结果"。**一个靠形状而非靠字段名的约定——脆弱但明确。**

**大输出处理**（`agent.ts:329-335`）：

1. 先把结果序列化成字符串；
2. 长度没超预览上限（`maxPreviewCharacters`）→ 原样返回；
3. 超了 → **先看 `read_tool_output` 在不在工具表里，不在才注册**（注释：只在引用真出现时才公开它，保持普通请求的工具清单稳定）；
4. 把全文落盘（`toolOutputStore.save`），只把返回的句柄消息交给模型。

动机写在注释里：*"保持普通请求的工具清单稳定"*——工具清单每轮都在变会让模型困惑，也会让 prompt 缓存失效。**这是一种"按需揭示能力"的设计，第 03 课会讲模型怎么用它分页取回。**

###### 3.8 `finishResult`：结果是怎么拼出来的

`agent.ts:161-175`：

1. 有追踪器 → 先 `changeTracker.finish()` 拿到 diff；
2. 拼 `AgentResult`：最终文本、`messages` 的**拷贝**、步数、`stopReason`、任务状态、验证器摘要；
3. **`diff` 和 `gitChanges` 是条件字段** —— 没配对应追踪器时这两个键**根本不存在**（不是塞 `undefined`）；`gitChanges` 还要把 diff 传进去做交叉标记；
4. 发 `run_finished` 事件，返回结果。

两处值得注意：

- **`taskState` 有一个降级表达式**：没有验证器时，`completed` 映射成 `completed`，其他一律 `working`。所以**不开 `verification` 的调用方拿到的 `taskState` 是不精确的**——它区分不出失败和中断。同理，`verification` 字段本身也会降级成一个全 `false` 的默认摘要（`required` / `writeObserved` / `verificationPassed` / `verificationAttempts` / `repairAttempts`）。
- **`gitChanges` 依赖 `diff`**（作为参数传入 `finish(diff)`），用来交叉标记"用户已有改动"和"Agent 改动"（第 14 课）。

---

##### 4. 重要分支

**分支 A —— 无参数 + 非 TTY：报错退出，不进 REPL**

不是交互式终端（`isInteractiveTerminal` 为假）→ 往 stderr 打 `Interactive mode requires a TTY. Usage: npm start -- <request>`，把 `process.exitCode` 设为 `1`，返回。

`isInteractiveTerminal`（`cli.ts:286-288`）要求 `input.isTTY === true && output.isTTY === true`，**两者都要**。理由写在同一处注释里：*"避免管道进程永久等待"*——如果只重定向了 stdout，readline 会一直等 stdin。

注意它设置的是 `process.exitCode` 然后 `return`，**不 `process.exit()`**——让 Node 自己正常结束，事件循环里的其他句柄有机会收尾。

**分支 B —— 有参数 + 非 TTY：能读、不能写**

这就是 3.3 节那个恒 `false` 的 `confirmTool`。实际效果：

| 工具 | capability | 非 TTY 下 |
| --- | --- | --- |
| `read_file` / `list_files` / `search_text` | `read` | ✅ 正常执行（只读默认允许） |
| `apply_patch` | `write` | ❌ 审批恒拒 → `{error}` |
| `run_tests` | `execute` | ❌ 审批恒拒 → `{error}` |

**所以 `veil "跑一下测试" > log.txt` 这种用法会得到一个"测试没跑、权限被拒"的回答。** 这不是 bug，是设计。

**分支 C —— 模型审批 vs 工具审批，相互独立**

3.3 节已详述。要点：**两套策略都实现同一个 `ApprovalPolicy` 形状，但注入点和默认值完全不同**——模型侧恒真（.env 即授权），工具侧逐次问（副作用不可逆）。

**分支 D —— `helperPath` 决定 `run_command` 是否存在**

3.4 节已详述。补充一个边界：`assertAvailable` 抛异常时**没有任何工具被注册**，且异常冒到顶层。**"证明不了隔离就不提供能力"，而不是"隔离不了就裸跑"。**

**分支 E —— 空输入在两层被挡**

- CLI 层：参数拼起来去空白后为空 → 进无参数分支（TTY 则 REPL）
- Agent 层：`input` 去空白后为空 → 抛 `Agent input must not be empty`

**两层都挡**，因为 `Agent` 是公开 API，程序化调用不经过 CLI。

**分支 F —— 模型想收尾但没验证**

3.6 节的出口 B。`continue` 而非 `break`，且下一轮会带上门禁提示。**只有验证器 `isBlocked` 时才以 `blocked` 结束。**

**分支 G —— 是否开 `verification`**

CLI 传了 `verification: { mode: "coding", maxRepairAttempts: 3 }`（`cli.ts:176`），所以走完整的门禁逻辑。但 `verification` 是**可选**的——不传就没有 `TaskStateMachine`，出口 B 不存在，模型说收尾就收尾。

**分支 H —— 输出超限触发能力揭示**

3.7 节的懒注册 `read_tool_output`。**注意这是运行中修改 `ToolRegistry`**，所以同一 run 的后续步骤里工具清单和前面不同。

---

##### 5. 完整流程串联

用一个具体输入重走一遍。设工作区是 `D:\demo`，`.env` 配好了，终端是 TTY，`CODING_AGENT_SANDBOX_HELPER` **未设置**（默认情况）。

**输入：**

```text
D:\demo> veil "修复 calculateTotal 的空数组问题并跑测试"
```

**① CLI 分流。** `isMainModule()` 通过 → `main()` → 无 `--help` / `--version` → `input = "修复 calculateTotal 的空数组问题并跑测试"` 非空 → 一次性运行路径。

**② 装配。**

- 用 `WorkspacePolicy` 把当前目录 `D:\demo` 定为工作区；
- 从 `.env` 读出模型配置（provider / baseUrl / model）；
- 用 `loadRepositoryContext` 读 `D:\demo` 祖先链上的 `AGENTS.md`，并构造 `GitRepository` 和 `GitChangeTracker`；
- 建终端交互对象 —— 因为是 TTY，返回真实的询问实现；
- 模型客户端用**恒真审批**，工具注册表用 `prompt.confirmTool` **逐次问**；
- 调 `registerCliTools` 注册工具 —— `helperPath` 取默认值、环境变量没设 → 走**分支一** → 注册 5 个工具（`read_file`、`list_files`、`apply_patch`、`run_tests`、`search_text`）加 3 个仓库工具（`get_repository_instructions`、`get_git_status`、`get_git_file_diff`）；
- 构造 `Agent`，带上 system prompt、`verification: { mode: "coding", maxRepairAttempts: 3 }`、事件回调 `writeRunEvent`，以及自建的 `RunChangeTracker`。

**③ `Agent.run(input, { gitChangeTracker })`。**

- 启动变更追踪器：对 `D:\demo` 建一次快照索引（路径 / 类型 / 大小 / mtime / SHA-256），文本基线写进临时目录；
- 启动 Git 追踪器：记录运行前的 Git 状态。

**④ `executeRun` 准备。**

- 因为 `mode === "coding"`，创建 `TaskStateMachine` 并启动；
- `messages` 初始是两条：一条 `createCodingSystemPrompt` 生成的 system，一条用户输入。

**⑤ step 1 —— 探查。**

- 取消检查通过 → 通知验证器开始工作 → 发 `model_started`；
- 此时还没写任何东西，`requiresVerification` 为假 → **不带门禁提示**；
- 上下文压缩（预算 32000 tokens）没超 → 原样下发；
- 模型返回两个工具调用：读 `src/calc.js`、搜 `calculateTotal`；
- 原始 assistant 消息（含 `toolCalls`）压进 `messages`，checkpoint 一次；
- 两个调用都可并行、冲突键也不同（一个是 `file:...`、一个是 `search:...`）→ **同一波次并发执行**；
- 结果**按声明顺序**回传两条 tool 消息，checkpoint 一次、发批次结束事件。

**⑥ step 2 —— 修改 + 审批。**

- 模型返回 `apply_patch`；
- 工具注册表执行它：Zod 校验 → 安全策略判定含 `write` → 生成补丁预览 → 交给 `prompt.confirmTool` → **终端弹出预览，你按 `y`**；
- 写入成功，发 `tool_completed`，tool 消息回灌；
- 因为这次调用的能力里含 `write`，验证器记下"工作区被写过" → **`requiresVerification` 变成 `true`**。

**⑦ step 3 —— 门禁提示生效。**

- 回到循环开头。这次 `requiresVerification` 为真 → 送给模型的消息里**多一条 system 门禁提示**，而 `messages` 本身没变；
- 模型返回 `run_tests`；
- `run_tests` 的清单声明了自己能判定成败 → 验证器据此记录一次验证结果；
- 假设这次**测试失败** → 记为未通过，`requiresVerification` 仍为 `true`。

**⑧ step 4 —— 修复。**

- 又带着门禁提示问模型 → 模型再 `apply_patch` 改一次 → 再 `run_tests`，这次通过；
- 验证器记下通过 → `requiresVerification` 变 `false`；
- 至此用掉 3 次 repair 额度中的 1 次。

**⑨ step 5 —— 收尾。**

- 模型这次没有工具调用，且 `requiresVerification` 已是 `false` → 验证器 `complete()` → 以步数 5、`stopReason = "completed"` 收尾。

**⑩ 结果与输出。**

- 变更追踪器 `finish()`：比对前后快照，发现只有 `src/calc.js` 的 SHA-256 变了 → 只对这一个文件算 unified diff；
- `reuseBaseline` 为假 → **`finish()` 内部顺手清掉临时基线目录**；
- 任务状态记为 `completed`；
- Git 追踪器 `finish(diff)` → 区分出哪是用户本来就有的改动、哪是 Agent 改的；
- 发 `run_finished`；
- `run()` 的 `finally` 里：`ownsChangeTracker` 为假、`completed` 为真 → **不再重复清理**；
- 回到 `main()`：最终回答和 diff 打到 stdout，Git 改动打到 stderr；
- 最后 `finally` 关掉 readline。

**这个流程里已经实现的失败、恢复与清理路径：**

| 情况 | 实际行为 | 依据 |
| --- | --- | --- |
| 审批时按 `n` | `ApprovalDeniedError` → 转成 `{error}` 的 tool 消息 → **run 继续**，模型看到拒绝原因 | `agent.ts:312-317` |
| 工具抛异常 | 同上，转 `{error}`，不中断 | `agent.ts:312-317` |
| 模型请求超时 / 网络错 | `generateWithRetry` 按错误分类退避重试，最多 3 次、总时长 60s | `agent.ts:177-199`（第 11 课） |
| 模型返回不可重试错误 | 立即 `throw` → 发 `run_failed` → **整个 run 结束** | `agent.ts:133-136` |
| 改了东西但反复不验证 | 每轮注入门禁提示；到 `maxSteps = 8` → `block("maximum model steps reached before verification")` → `stopReason = "blocked"` | `agent.ts:156-158` |
| 用户中断（`AbortSignal`） | 下一轮开头 `throwIfAborted()` 抛出；`completed` 仍为 `false` → **`finally` 里 `dispose()` 清理基线** | `agent.ts:115`、`agent.ts:77` |
| 进程被强杀 | `finally` 跑不到；靠 `cleanupStaleBaselineDirectories` 按 mtime 兜底清理 | `run-diff.ts:48` |
| 恢复运行 | `resumeCheckpoint` 提供消息与步数；命中 `replayToolResults` 的工具调用**不产生副作用** | `agent.ts:61`、`agent.ts:274-278` |

**注意这里没有的东西：** 没有 Planner、没有 Reviewer、没有任务 DAG（`docs/agent-flow-user-request.md` 第 10 节明确列为未实现）。**一轮 run 的"计划"完全由模型在对话里隐式完成**，代码只提供循环和边界。

---

##### 6. 流程回顾与复述任务

**一句话回顾这条链：**

> `cli.ts` 按 TTY 和参数分流，装配工作区 / 模型 / 工具表 / 验证器，交给 `Agent.run`；`Agent` 在 `maxSteps` 内反复"模型 → 工具 → 回灌"，其中模型失败终止运行、工具失败降级成 `{error}` 继续跑；改了工作区就必须过验证门禁；结束时用运行前后快照算出 diff，再由 CLI 分 stdout / stderr 两路输出。

**请你自己复述下面三个问题**（不用跑项目，对着代码说即可）：

1. 一个工具调用从"模型返回"到"结果回灌给模型"，中间一共经过哪几个方法？**特别说清审批发生在哪个方法、Zod 校验又在它前面还是后面。**
2. 为什么模型层异常要 `throw` 终止 run，而工具层异常要降级成 `{error}` 消息继续跑？**如果两边都终止，会失去什么能力？**
3. CLI 传入的 `changeTracker`，正常结束时是谁把它清理掉的？**为什么 `run()` 的 `finally` 里没有清理它、却不算泄漏？**

**答不上来的地方就是你的漏洞清单。** 第 1 题定位不到，回 3.5–3.7；第 2 题说不清，回 3.6 关于第 ⑧ 步那段和 3.7 的异常处理；第 3 题卡住，回 3.5 的所有权表格。

---

**本课完成标准自检：**

- 主链按真实调用顺序展开（`main` → `Agent.run` → `executeRun` → `executePendingCalls` → `executeToolBatch` → `finishResult`）✅
- 每个结论可定位到代码：`cli.ts:102-112/133-186/337-355`、`agent.ts:20-22/45/56-79/81-159/161-175/219-245/247-269/271-280/294-318/329-335/367-372`、`run-diff.ts:48/155-159`、`workspace-tools.ts:26-111`、`test/cli.test.ts:14-26` ✅
- 设计取舍在影响流程理解处补充（两套审批、`run_command` 条件注册、并发冲突键偏保守、门禁提示不入 transcript）✅
- 末节含流程回顾 + 三项自行复述任务，不要求运行项目 ✅
- 未确认边界已标记：`--help`/`--version` 用包含判定是否有意、非交互式放行能力缺失 ✅

---

---

### 第二段：执行内核

#### 02 Agent 执行循环：模型和工具之间那个循环为什么不是 `while(true)`

**读完能回答：** 循环的终止条件有哪几个；`maxSteps` 用尽和模型主动停止在结果上如何区分；一次模型返回多个 tool call 时按什么规则决定并行还是串行；取消信号怎么穿透到工具层。

**主链：** `Agent.run` → 组装消息 → `ContextManager` → `ModelClient.generate` → 分支（无 tool call / 有 tool call）→ `ToolRegistry.execute` → 结果回灌 → 下一轮

**必读路径与符号：**

1. `src/agent/types.ts` — `RunEvent`（`model_started` / `tool_requested` / `tool_completed` / `tool_failed` / `run_finished` / `run_failed`）、`AgentResult`、`ModelFinishReason`
2. `src/agent/agent.ts:56` — `Agent.run()`：主循环、步数计数、终止判定、事件发射
3. `src/agent/agent.ts` — 多工具批次的并行/串行判定与"按模型声明顺序回传"的实现
4. `src/agent/agent.ts` — `AbortSignal` 的传递路径与取消后的清理
5. `test/agent/agent.test.ts`（20 处 `test()`）— 循环边界行为的**权威规格**

**选读验证：** `test/agent/agent.test.ts` 中关于 maxSteps、多工具批次、取消的用例

**暂缓：** 上下文如何被压缩 → 第 03 课；工具怎么被校验和审批 → 第 04、05 课。

**状态：** `大纲`

#### 03 消息契约与上下文预算：完整 transcript 和「模型视图」为什么要分开

**读完能回答：** 为什么压缩上下文不能直接改消息数组；token 超预算时按什么顺序逐级降级；大 stdout 怎么做到不撑爆上下文；摘要为什么能跨轮复用。

**主链：** 完整 transcript 累积 → 估算 token → 超预算触发降级链 → 生成 `ContextResult` 发给模型（原始 transcript 不变）

**必读路径与符号：**

1. `src/agent/types.ts` — `Message` / `SystemMessage` / `UserMessage` / `AssistantMessage` / `ToolMessage`、`ContextBudget`、`ContextResult`、`ContextCheckpoint`
2. `src/agent/types.ts:155` — `ContextDegradation` 枚举，这是**降级链的真实顺序**：
   `tool_output_truncated` → `snipped` → `context_collapsed` → `old_messages_summarized` → `current_request_exceeds_budget`
3. `src/agent/context-manager.ts:14` — `DefaultContextManager`，逐级降级的实现
4. `src/agent/context-manager.ts:226` — `createDeterministicContextManager`（测试用确定性版本，理解它对拍测试的意义）
5. `src/agent/tool-output-store.ts` — `ToolOutputStore` / `ToolOutputArtifact`：大输出落盘 + 分页引用
6. `src/tools/tool-output-tool.ts` — `createToolOutputReadTool`：模型如何按 artifactId 分页取回
7. `docs/agent-flow-context.md` — 官方上下文链路文档

**选读验证：** `test/agent/context-manager.test.ts`、`test/agent/tool-output-store.test.ts`

**暂缓：** checkpoint 如何在恢复时被读取 → 第 13 课；这些表在 SQLite 里怎么存 → 第 12 课。

**状态：** `大纲`

#### 04 工具契约与注册表：一个工具从声明到能被模型调用要走完哪些校验

**读完能回答：** 为什么模型侧的 JSON Schema 和执行侧的 Zod 是两套而不是共用一套；`capability` 从哪来、谁在用它做判断；没声明模型 schema 的工具为什么模型看不到。

**主链：** `defineTool` 声明 manifest → 注册进 `ToolRegistry` → `listModelDefinitions()` 暴露给模型 → 模型返回 tool call → `ToolRegistry.execute` 先 Zod 校验再分发

**必读路径与符号：**

1. `src/agent/types.ts` — `Tool`、`ToolManifest`、`ToolCapability`（`read` / `write` / `execute` / `network`）、`ToolContext`、`ModelToolDefinition`
2. `src/tools/tool-schema.ts` — `defineTool` / `validateToolInput` / `ToolInputValidationError`
3. `src/tools/tool-registry.ts:32,37,50` — `ToolRegistry.list()` / `listModelDefinitions()` / `execute(name, input, context)`
4. `src/tools/tool-input-schemas.ts` — 执行侧 Zod 原子 schema：`SAFE_ENV_KEY_PATTERN`、`pathInputSchema`、`argsInputSchema`、`envInputSchema`、`stringWithoutNullByteSchema`
5. `src/tools/model-tool-schemas.ts` — 模型侧 JSON Schema：`readFileModelInputSchema`、`applyPatchModelInputSchema`、`createRunCommandModelInputSchema(maxTimeoutMs)` 等
6. `test/tools/tool-schema.test.ts`（8 处）— 校验边界与「非法输入不进审批阶段」的规格

**选读验证：** `test/tools/tool-schema.test.ts`

**暂缓：** 校验通过之后谁能拦住副作用 → 第 05 课；具体工具实现 → 第 06、07 课。

**状态：** `大纲`

---

### 第三段：安全与执行（本项目的重头戏）

#### 05 工作区边界与审批：副作用发生前的最后一道闸在哪

**读完能回答：** realpath 校验如何挡住符号链接逃逸；为什么隐藏路径要单独拒绝；审批发生在 Zod 校验之后、副作用之前的准确位置；默认策略为什么是「拒绝」而不是「允许」。

**主链：** 工具执行请求 → `WorkspacePolicy` 解析与边界检查 → capability 判定 → 需要副作用则生成预览 → `ApprovalPolicy` 请求确认 → 拒绝则返回结构化错误、不产生任何副作用

**必读路径与符号：**

1. `src/tools/security.ts:27` — `WorkspacePolicy`：realpath 解析、越界判定、隐藏路径、文件/条目上限
2. `src/tools/security.ts:18` — `WorkspaceSecurityError`
3. `src/tools/security.ts:130` — `ApprovalPolicy` 接口
4. `src/tools/security.ts:136` — `DefaultApprovalPolicy`（默认拒绝语义）
5. `src/tools/security.ts:152` — `ApprovalDeniedError`
6. `src/tools/security.ts:171` — `SecurityPolicy implements ToolExecutionPolicy`：把上面几步串起来的编排点
7. `src/agent/types.ts` — `ApprovalRequest`、`ToolExecutionPolicy`
8. `docs/agent-flow-security.md` — manifest / capability / fail-closed 的官方说明

**选读验证：** `test/tools/security.test.ts`

**暂缓：** OS 级隔离（这是**应用层**策略，不等同于进程隔离）→ 第 07、08 课。

**状态：** `大纲`

#### 06 文件读搜与 patch：怎么做到「先看到 diff 预览，再决定写不写」

**读完能回答：** 四个工作区工具的输入输出契约；patch 的预览 diff 是怎么生成的；精确替换失败时如何不留下半个文件；读取为什么要限制大小。

**主链：** 模型给出文件路径与替换内容 → 边界校验 → 生成 `PatchPreview`（受限 diff）→ 审批 → 写入 → 返回 `PatchResult` 与逐文件状态

**必读路径与符号：**

1. `src/tools/workspace-tools.ts` — `createWorkspaceTools`：`read_file` / `list_files` / `search_text` 三个只读工具
2. `src/tools/patch-tools.ts:56` — `createPatchTool(policy)`
3. `src/tools/patch-tools.ts:10-51` — `PatchFileResult` / `PatchPreview` / `PatchResult` / `PatchChange` / `PatchInput`
4. `src/tools/model-tool-schemas.ts:62` — `applyPatchModelInputSchema`：模型看到的 patch 参数长什么样
5. `test/tools/patch-tools.test.ts`（5 处）— 预览、失败路径、边界用例

**选读验证：** `test/tools/patch-tools.test.ts`

**暂缓：** patch 产生的改动如何被 diff 捕获 → 第 14 课。

**状态：** `大纲`

#### 07 命令执行与 Sandbox 抽象：为什么不能直接 `child_process.spawn`

**读完能回答：** 三种 `SandboxBackend` 的差异与选择逻辑；`fail closed` 在这个项目里的准确含义；命令超时后怎么保证子进程树被清干净；为什么 CLI 只给模型开放 `run_tests` 而不开放通用 `run_command`。

**主链：** 模型请求执行 → `classifyExecution` 定风险级 → `decideSandboxPolicy` 结合可用能力决策 → 经 `SandboxBackend` 启动 → 超时/取消 → 终止进程树 → 结构化结果

**必读路径与符号：**

1. `src/tools/sandbox.ts:74` — `SandboxBackend` 接口（抽象层）
2. `src/tools/sandbox.ts:44-69` — `SandboxCapabilities` / `SandboxCapability` / `ExecutionRequest` / `SandboxSpawnRequest`
3. `src/tools/sandbox.ts:92` — `ProcessSandboxBackend`（降级路径）
4. `src/tools/sandbox.ts:119` — `UnavailableSandboxBackend`（不可用即拒绝）
5. `src/tools/sandbox.ts:140` — `RustHelperSandboxBackend`（强隔离路径，→ 第 08 课）
6. `src/tools/sandbox.ts:223` — `executionRequestDigest`：请求规范化摘要，理解它为何是审批绑定的基础
7. `src/tools/sandbox-policy.ts:7,33,46,56` — `RiskClass`（`R0`–`R6`）/ `classifyExecution` / `defaultCommandPolicy` / `decideSandboxPolicy`
8. `src/tools/sandbox-policy.ts:78,105` — `policyBindingDigest` / `sandboxPolicyDigest`
9. `src/tools/command-tools.ts:133` — `createRunCommandTool(policy, options)`
10. `src/tools/command-tools.ts:100` — `DEFAULT_MAX_COMMAND_TIMEOUT_MS`（120s）
11. `src/tools/test-tools.ts:66` — `createRunTestsTool(policy, options)`
12. `docs/agent-flow-sandbox-command.md` — 官方命令与沙箱链路文档

**选读验证：** `test/tools/command-tools.test.ts`、`test/tools/test-tools.test.ts`、`test/tools/sandbox.test.ts`

**暂缓：** Rust helper 内部的隔离实现 → 第 08 课；出网命令的代理限制 → 第 09 课。

**状态：** `大纲`

#### 08 Rust Helper 深潜：OS 级隔离到底做了什么、能力不足时为什么必须拒绝

**读完能回答：** 为什么这部分用 Rust 而不留在 TypeScript；helper 收到请求后重新校验了哪些东西（以及为什么"上层已校验过"不算数）；Windows 与 Linux 走的隔离机制分别是什么；能力探测失败时谁负责拒绝。

**主链：** TS 侧 capability 握手 → 规范化 `ExecutionRequest` → base64 JSON 经 stdin 传入 → helper 重新校验 workspace/cwd/资源/network → 建立隔离 → 启动目标进程 → 回传结构化结果

**必读路径与符号：**

1. `sandbox-helper/Cargo.toml` — 依赖与二进制名
2. `sandbox-helper/src/main.rs` — 1,814 行，建议按三段读：
   - 协议层：输入解析、capability 握手、结果回传格式
   - 校验层：workspace / cwd / 资源上限 / `network: off` 的**重复校验**
   - 隔离层：Windows（Job Object、Restricted Token、句柄白名单、网络限制）与 Linux（namespace、`no_new_privs`、seccomp、cgroup 探测）
3. `src/tools/sandbox.ts:132,140` — `RustHelperSandboxOptions` / `RustHelperSandboxBackend`：TS 侧如何发起握手
4. `package.json` — `scripts.sandbox:build`（`cargo build --release`）
5. `docs/sandbox-roadmap.md` — 已落地能力与纵深补齐项

**选读验证：** `test/tools/sandbox.test.ts`；手工验证需先 `npm run sandbox:build`

**暂缓：** 精细化 `/proc`、设备、Windows 注册表/网络策略属于**未完成**，见第 20 课。

**状态：** `大纲`（建议在 07 之后、且时间充裕时再读）

#### 09 出网治理：`network` capability 与受控代理

**读完能回答：** 为什么出网要独立于 `execute` 单独成类 capability；`ControlledNetworkProxy` 限制了哪些维度；域名/IP/端口绑定是怎么落到策略上的；出网命令和普通命令在审批上有什么不同。

**主链：** 出网命令请求 → 目标策略校验 → `ControlledNetworkProxy` 建立受限通道 → 代理转发与限制（超时/大小/并发）→ 事件与结果回传

**必读路径与符号：**

1. `src/tools/network-proxy.ts:44` — `ControlledNetworkProxy`
2. `src/tools/network-proxy.ts:9-30` — `NetworkProxyLimits` / `NetworkProxyEvent` / `NetworkTargetPolicy` / `ControlledNetworkProxyOptions`
3. `src/tools/network-command.ts:29` — `createManagedNetworkCommandTool(...)`
4. `src/tools/sandbox.ts:30,195,207` — `ExecutionNetworkPolicy` / `normalizeNetworkPolicy` / `canonicalNetworkPolicy`
5. `src/tools/sandbox-policy.ts` — `NetworkPolicy` 与 `RiskClass` 中与网络相关的分级

**选读验证：** 本课**未见独立测试文件**（`test/tools/` 下无 network 相关测试），阅读时以源码与策略函数为准，此点记为待确认。

**暂缓：** 域名/IP/端口绑定的完整策略模型在路线图中标为 P2 扩展，见第 20 课。

**状态：** `大纲`

---

### 第四段：模型接入

#### 10 ModelClient 契约与两套协议 adapter：怎么做到换协议不动 Agent

**读完能回答：** `ModelClient` 这个契约抽象掉了什么；Chat Completions 与 Responses 在工具调用表达上的差异；为什么协议必须显式配置、禁止按响应内容猜测；SSE 增量事件怎么被解析成统一的 `ModelStreamEvent`。

**主链：** `ModelRequest`（消息 + 工具 + 取消信号）→ 具体 adapter → 协议转换 → HTTP 调用 → 响应解析回 `ModelResponse`

**必读路径与符号：**

1. `src/agent/types.ts:213` — `ModelClient` 接口：`generate(request)`
2. `src/agent/types.ts:200-232` — `ModelRequest` / `ModelResponse` / `ModelCapabilities` / `ModelUsage` / `ModelRetryOptions`
3. `src/agent/types.ts:116` — `ModelStreamEvent`：流式事件的统一形态
4. `src/model/openai-compatible.ts:43` — `OpenAICompatibleModel.generate()`：文本与 function tool call 转换
5. `src/model/openai-compatible.ts:16` — `OpenAICompatibleResponseError`
6. `src/model/openai-responses.ts:14` — `OpenAIResponsesModel.generate()`：函数调用延续与 `previous_response_id`
7. `src/model/runtime-config.ts:39,67` — `readModelRuntimeConfig` / `createConfiguredModelClient`：协议的选择点在这里
8. `docs/agent-flow-model-network.md` — 官方模型链路文档

**选读验证：** `test/model/openai-compatible.test.ts`（7 处）、`test/model/openai-responses.test.ts`（3 处）

**暂缓：** 网络层与审批 → 第 11 课。

**状态：** `大纲`

#### 11 Transport、模型审批与错误重试：哪些错误能重试、哪些绝不能

**读完能回答：** `FetchHttpTransport` 统一兜住了哪些失败形态；错误分类后各类的重试决策；为什么"模型请求"本身也要审批（对话里可能带仓库内容）；`.env` 里每个配置项在代码里的落点。

**主链：** `ApprovedModelClient.generate` → 审批（可能上传对话/工具结果）→ `FetchHttpTransport` 发请求 → 超时/取消/大小限制/HTTP 错误分类 → 分类决定重试或立即返回

**必读路径与符号：**

1. `src/model/approval.ts:40` — `ApprovedModelClient.generate()`（审批包裹层）
2. `src/model/approval.ts:19,32` — `DefaultModelApprovalPolicy` / `ModelApprovalDeniedError`
3. `src/model/transport.ts:45` — `FetchHttpTransport`：超时、取消、响应大小、HTTP 错误、JSON 解析
4. `src/model/transport.ts:28-44` — `HttpTransport` / `HttpRequest` / `HttpResponse` / `FetchHttpTransportOptions`
5. `src/model/errors.ts:2,24` — `ModelTransportErrorCode`（**错误分类表**）/ `ModelTransportError`
6. `src/model/runtime-config.ts:16-38` — `OpenAICompatibleRuntimeConfig` / `ModelRuntimeOptions`（对应 `.env` 各项）
7. `.env.example` — 配置项模板
8. `docs/compatibility-notes.md` — 真实模型验收观察到的兼容性结果

**选读验证：** `test/model/transport.test.ts`（9 处）、`test/model/approval.test.ts`、`test/model/runtime-config.test.ts`

**暂缓：** 审计事件如何落库 → 第 12 课。

**状态：** `大纲`

---

### 第五段：状态、持久化与变更

#### 12 Session 与 SQLite 数据模型：这套 schema 是为哪些问题服务的

**读完能回答：** 七张表各自存什么、解决什么问题；为什么消息要按 `sequence` 排而不是按时间；`runs` 的 owner / lease 字段是为谁准备的；审计表**故意不存**什么。

**主链：** 创建 Session → `startRun` 写 `running` → Agent 执行 → `completeRun` 事务（状态 + 消息 + 时间戳）→ 失败走 `failRun`

**必读路径与符号：**

1. `src/agent/session-store.ts:43` — `SessionStore` 接口全集（这是数据访问的**权威契约**）
2. `src/agent/session-store.ts:3-41` — `SessionRecord` / `StoredRunRecord` / `StoredMessage` / `CompleteRunInput` / `PersistedRunStatus` / `PersistedSessionStatus`
3. `src/agent/sqlite-session-store.ts:9` — `SqliteSessionStore`：建表、迁移、事务
4. `src/agent/types.ts:233,249` — `AuditEvent` / `AuditSink`：审计事件的形状与写入接口
5. `src/agent/session.ts:46` — `Session`：`run()` 与消息提交边界
6. `src/agent/session.ts:7-44` — `RunResult` / `FailedRun` / `SessionRun` / `SessionResult` / `SessionOptions`
7. `docs/agent-flow-persistence.md` — 官方持久化文档（含七张表清单）

**七张表：** `sessions`、`runs`、`messages`、`schema_migrations`、`checkpoints`、`context_checkpoints`、`audit_events`

**选读验证：** `test/agent/sqlite-session-store.test.ts`（9 处）、`test/agent/session.test.ts`

**暂缓：** 恢复路径 → 第 13 课。

**状态：** `大纲`

#### 13 恢复与幂等：进程崩了之后怎么保证不重放副作用

**读完能回答：** `interrupted` 是怎么被判定出来的；lease 过期与"接管"的关系；为什么恢复必须**显式**调用 `resume()`；已完成工具结果靠什么避免重放。

**主链：** 进程退出 / lease 过期 → run 标记 `interrupted` → `SessionManager.recover(sessionId)` 接管 → 显式 `Session.resume()` → 从 checkpoint 继续 → 已完成工具读结果、未完成的重新走审批

**必读路径与符号：**

1. `src/agent/session-manager.ts:39,53` — `SessionManager.recover()` / `list()`
2. `src/agent/session.ts:109` — `Session.resume()`：**显式**恢复入口
3. `src/agent/session-store.ts:48-49` — `startRun` / `resumeRun`：owner 与 lease 的写入点
4. `src/agent/types.ts:349,359` — `CheckpointRecord` / `CheckpointSink`：checkpoint 的形状
5. `src/agent/sqlite-session-store.ts` — checkpoint 的读写实现
6. `src/agent/tool-output-store.ts` — 工具结果的稳定标识（与幂等键相关）
7. `docs/agent-flow-session.md` — 官方 Session 生命周期文档

**选读验证：** `test/agent/session.test.ts`、`test/agent/tool-output-store.test.ts`

**暂缓：** 任务级恢复（跨 run 的 Task 实体）→ 第 15 课；`Task` 恢复 CLI/API 尚未实现 → 第 20 课。

**状态：** `大纲`

#### 14 运行变更追踪：怎么准确说出「这次运行改了什么」

**读完能回答：** 为什么用「运行前后快照」而不是 `git status` 来算本次改动；如何区分用户已有改动和 Agent 改动；`complete: false` 和 `untrackedPaths` 各代表什么风险；基线目录为什么必须清理。

**主链：** 运行前建快照索引 + baseline 目录 → 运行（patch / 命令 / 测试都可能改文件）→ 运行后再快照 → 按 SHA-256 差异定位变化 → 仅对变化文件算 unified diff → 清理基线

**必读路径与符号：**

1. `src/agent/run-diff.ts:90` — `RunChangeTracker`：快照与 diff 主流程
2. `src/agent/run-diff.ts:16-47` — `RunDiffFile` / `RunDiff` / `RunChangeTrackerOptions`
3. `src/agent/run-diff.ts:48` — `cleanupStaleBaselineDirectories`：残留基线清理
4. `src/repository/git.ts:22` — `GitRepository`：只读 git 查询（无 shell，argv 形式）
5. `src/repository/git.ts:66` — `GitChangeTracker`：运行前后的 git 状态对比
6. `src/repository/git.ts:6-19` — `GitFileState` / `GitStatusSummary` / `GitChangeReport` / `GitCommitPreview`
7. `src/agent/session.ts:147` — `Session.run(input, { changeTracker, gitChangeTracker })`：两个 tracker 的注入点
8. `docs/agent-flow-diff-and-output.md` — 官方 diff 与输出文档

**选读验证：** `test/agent/run-diff.test.ts`（13 处）

**暂缓：** 提交（`git_commit`）本身**未开放** → 第 20 课。

**状态：** `大纲`

---

### 第六段：任务闭环与仓库上下文

#### 15 任务状态机与强制验证闭环：「完成」为什么不能由模型说了算

**读完能回答：** 状态集合与合法转移；`VerificationPolicy` 为什么是独立配置；验证失败怎么进入修复态；"未验证就结束"在数据上如何表达。

**主链：** 任务创建 → 状态推进 → 代码变更后进入验证 → 验证失败转修复 → 重新验证 → 通过才允许完成

**必读路径与符号：**

1. `src/agent/types.ts:9` — `TaskState`：**代码中的真实状态集**
   `received` | `working` | `verifying` | `repairing` | `completed` | `blocked`
2. `src/agent/types.ts:11,16` — `VerificationPolicy` / `VerificationSummary`
3. `src/agent/task-state-machine.ts:6` — `TaskStateMachine`：合法转移与拒绝非法跳转
4. `test/agent/task-state-machine.test.ts`（3 处）— 转移合法性的规格
5. `docs/core-agent-roadmap.md` 阶段五 — 设计意图与首批交付顺序

> ⚠️ **文档与实现不一致（本大纲已核实）：** 路线图阶段五描述的状态是
> `created -> analyzing -> planning -> executing -> validating -> repairing`，
> 而代码里 `TaskState` 实际是上表六个值。**以实现为准**——第 20 课会集中列出这类落差。
> 这恰好是路线图文档滞后于实现的证据：HEAD commit 正是 `feat(agent): enforce coding task verification`。

**选读验证：** `test/agent/task-state-machine.test.ts`

**暂缓：** 任务级恢复 CLI/API（尚未实现）→ 第 20 课。

**状态：** `大纲`

#### 16 仓库上下文注入：`AGENTS.md` 怎么进入模型、又怎么不被当成指令执行

**读完能回答：** 祖先链上多个 `AGENTS.md` 的合并与覆盖规则；注入时受什么长度约束；为什么仓库指令被标记为"不可信内容"；它不能做哪些事。

**主链：** 确定 workspace 根 → 从根到当前目录收集 `AGENTS.md` → 按规则合并 → 截断并记录 digest → 格式化为受限上下文 → 注入 system context

**必读路径与符号：**

1. `src/repository/instructions.ts:40` — `RepositoryInstructionLoader`：发现、合并、截断
2. `src/repository/instructions.ts:77` — `formatRepositoryInstructions`：注入文本的生成
3. `src/repository/instructions.ts:6-38` — `RepositoryInstructionSource` / `RepositoryInstructions` / `RepositoryInstructionOptions`
4. `src/repository/tools.ts:11` — `createRepositoryTools(instructions, repository)`：只读仓库工具
5. `AGENTS.md`（项目根）— **本项目自身就是被加载的指令文件**，读它等于看到了一个真实样例
6. `README.md` 功能更新日志 2026-09-12 段 — 该能力的落地说明

**选读验证：** `test/repository/repository-context.test.ts`（3 处）

**暂缓：** git 只读查询与变更归属 → 第 14 课（同一个 `repository/` 模块的另一半）。

**状态：** `大纲`

---

### 第七段：扩展机制

#### 17 MCP 接入：外部工具怎么进来又不破坏既有安全链

**读完能回答：** Server 的可执行文件/参数/cwd/环境变量由谁决定；`initialize` → `tools/list` → `tools/call` 三步各做什么；Server 进程为什么要经 SandboxBackend 启动；哪些失败必须 fail closed。

**主链：** 读取宿主配置（固定 Server 身份）→ 经 Sandbox 启动 stdio Server → `initialize` → `tools/list` → 适配成 `ToolRegistry` 工具 → 调用时绑定身份与参数摘要审批 → `tools/call` → 输出受限 + 审计

**必读路径与符号：**

1. `src/tools/mcp.ts:59` — `McpStdioClient`：协议客户端
2. `src/tools/mcp.ts:75,85` — `listTools()` / `callTool(name, args, signal)`
3. `src/tools/mcp.ts:54` — `McpProtocolError`
4. `src/tools/mcp.ts:171` — `createMcpTools(client)`：适配进 ToolRegistry
5. `src/tools/mcp.ts:14-53` — `McpStdioServerConfig` / `McpToolPreview` / `McpToolResult`
6. `test/fixtures/mcp-server.ts` — 测试用假 Server，理解握手最小形态
7. `docs/core-agent-roadmap.md` 阶段三 — 范围与"暂不范围"（远程 MCP / resources / prompts / OAuth 均未开放）

**选读验证：** `test/tools/mcp.test.ts`（3 处）+ `test/fixtures/mcp-server.ts`

**暂缓：** 网络型 MCP 依赖出网 capability → 第 09 课。

**状态：** `大纲`

#### 18 Skill 体系：能力包怎么做到可发现、可匹配、受控捕获

**读完能回答：** `SkillManifest` 声明了什么；user 级与 repository 级的边界差异；Skill 如何被匹配进模型上下文；从一次成功 Session 捕获成 Skill 草稿的流程。

**主链：** 扫描 Skill 目录 → 解析 manifest → 构建 `SkillCatalog` → 按条件匹配 → 受控注入上下文 → （捕获路径）从 `SessionResult` 生成 `SkillDraft` → 经审批写盘

**必读路径与符号：**

1. `src/skill/types.ts:5-75` — `SkillManifest` / `SkillResource` / `SkillDescriptor` / `SkillMatch` / `LoadedSkill` / `SkillCatalogOptions` / `SkillCatalogLike` / `SkillCaptureInput` / `SkillDraft` / `SkillSource`
2. `src/skill/catalog.ts:31,72` — `SkillCatalog` 与其 `list()`
3. `src/skill/capture.ts:14` — `createSkillDraft(session, name, workspaceRoot, userRoot, global)`
4. `src/skill/capture.ts:38` — `createSkillWriteTool(workspaceRoot, userRoot)`：写盘仍走审批
5. `src/skill/tools.ts:10,43` — `createSkillTools(catalog)` / `SkillToolContext`
6. `src/skill/index.ts` — 模块出口
7. `docs/core-agent-roadmap.md` 阶段七 — 设计约束（Skill 不得形成绕过安全边界的**第二套插件执行通道**）

> 注意：路线图把 Skills 排在最后且标注"未完成"，但**代码中该模块已存在**，当前分支名正是 `codex/skills-foundation`。第 20 课会一并列出这类「文档滞后」项。

**选读验证：** `test/` 下**未见 skill 专项测试文件**，此点记为待确认。

**状态：** `大纲`

---

### 第八段：验证与边界

#### 19 测试地图与质量门禁：每个测试文件在锁什么行为

**读完能回答：** 21 个测试文件各自覆盖哪条主链；哪些模块测试薄；本地质量门禁的完整命令清单。

**主链（阅读顺序）：** 按「核心循环 → 安全 → 协议 → 持久化」的顺序扫，而不是按目录顺序

**必读路径与符号：**

1. `package.json` — `scripts.test`（`node --experimental-strip-types --test "test/**/*.test.ts"`）
2. 核心：`test/agent/agent.test.ts`（20）、`test/agent/context-manager.test.ts`（9）、`test/agent/session.test.ts`（4）
3. 安全：`test/tools/security.test.ts`（3）、`test/tools/sandbox.test.ts`（9）、`test/tools/patch-tools.test.ts`（5）、`test/tools/command-tools.test.ts`（9）、`test/tools/tool-schema.test.ts`（8）
4. 协议：`test/model/openai-compatible.test.ts`（7）、`test/model/transport.test.ts`（9）、`test/model/runtime-config.test.ts`（4）、`test/model/approval.test.ts`（2）
5. 持久化与变更：`test/agent/sqlite-session-store.test.ts`（9）、`test/agent/run-diff.test.ts`（13）、`test/agent/tool-output-store.test.ts`（3）、`test/agent/task-state-machine.test.ts`（3）
6. 其他：`test/cli.test.ts`（9）、`test/tools/test-tools.test.ts`（6）、`test/tools/mcp.test.ts`（3）、`test/repository/repository-context.test.ts`（3）、`test/model/openai-responses.test.ts`（3）
7. `AGENTS.md` — 项目自身的分支、测试、提交要求

**质量门禁命令：** `npm test`、`npx tsc --noEmit`、`git diff --check`、Rust 侧 `cargo test`（以及安全回归）

**规模：** 21 个测试文件、静态统计 `test()` 调用 **141 处**。
⚠️ 本次**未运行 `npm test`**，141 是静态计数；实际通过数请以本机运行为准（注：早前记录的"57 个测试"与当前静态计数差距较大，很可能是后续新增测试导致，建议跑一次核对）。

**覆盖薄弱点：** skill 模块、network-proxy / network-command 未见专项测试。

**状态：** `大纲`

#### 20 路线图、能力差距与当前边界：还没做什么、为什么

**读完能回答：** 项目自己认定的能力缺口；哪些"未完成"其实已经有代码雏形；下一步优先级顺序及其依赖关系。

**主链（阅读顺序）：** 先看已落地的能力总结，再看差距报告，最后看路线图的依赖顺序

**必读路径与符号：**

1. `docs/feature-summary.md` — 截至 2026-09-12 的**已实现**清单与「当前边界」段
2. `docs/core-agent-roadmap.md` — 七阶段顺序、分支名、当前下一步优先级表（P0/P1/P2）
3. `docs/official-coding-agent-gap-analysis.md` — 与官方 coding agent 的差距、证据与后续路线
4. `docs/sandbox-roadmap.md` — 沙箱纵深补齐项
5. `docs/compatibility-notes.md` — 真实模型验收观察
6. `docs/feature-summary.md` 与 `docs/core-agent-roadmap.md` 的「未完成」表述

**本课要专门核对的「文档滞后于实现」清单（本大纲已初步核实）：**

| 项 | 文档说法 | 代码事实 | 处置 |
| --- | --- | --- | --- |
| 任务状态集 | 阶段五：`created/analyzing/planning/executing/validating/repairing` | `TaskState` 为 `received/working/verifying/repairing/completed/blocked` | 以代码为准，展开第 15 课时定论 |
| Skills | 阶段七，排在最后、标注未完成 | `src/skill/` 已存在 5 个文件；当前分支 `codex/skills-foundation` | 展开第 18 课时核实完成度 |
| 网络能力 | 路线图标为 P2 扩展 | `network-proxy.ts` / `network-command.ts` 已实现 | 展开第 09 课时核实策略完整度 |
| `run_command` 是否暴露给模型 | README：CLI **不**向模型开放通用 `run_command` | 工具本身存在（`createRunCommandTool`） | 展开第 01/04 课时核实 CLI 注册范围 |

**状态：** `大纲`

---

## 四、怎么用这份大纲

**最短路径（时间紧，只想捡回主链）：** 01 → 02 → 04 → 07 → 10。这五课覆盖"请求怎么走、循环怎么写、工具怎么被管、命令怎么被执行、模型怎么被接入"，是本项目的骨架。

**面试重点路径：** 05（安全边界）→ 07（沙箱抽象）→ 11（错误重试分类）→ 13（恢复幂等）→ 14（变更追踪）。这五课是"能讲出设计取舍"的部分，明显比"会用 API"值钱。

**完整路径：** 按 01 → 20 顺序。建议每课读完对应测试文件再往下走——测试是这个项目里最诚实的规格说明。

**展开方式：** 告诉我课号（例如"展开 07"），我会沿真实调用链把那一课写开：逐步的输入/下一步/输出、关键分支、异常与清理路径，以及可验证的选读证据。**只更新指定课程，其余课程与你自己加的内容保持原样。**

**一个提醒：** 遇到看不懂的文件或概念，继续追问即可。这份大纲负责给学习路径和顺序，不提供逐行讲解——逐行讲解应该由你指着具体代码来问，那样效率更高。

---

## 五、大纲自检

- **主要功能是否都有归属：** `src/` 五个模块 + `cli.ts` / `index.ts` + `sandbox-helper` 均已分配到 01–20 课，无遗漏模块。
- **课程是否按学习依赖排序：** 先全貌（01）、再执行内核（02–04）、再安全与执行（05–09，依赖工具契约）、再模型接入（10–11）、再状态与变更（12–14）、再任务与仓库（15–16）、再扩展机制（17–18）、最后验证与边界（19–20）。
- **学习者能否按路线找到真实源码：** 每课所有路径与符号均取自当前 HEAD（`053b921`）的实际导出，已在源码中定位。
- **相邻课程是否重复同一核心流程：** 06 与 07 已按「文件操作 vs 命令执行」拆分；14 与 16 已按「变更追踪 vs 指令注入」拆分，各回答不同问题。
- **未覆盖模块与不确定边界是否列出：** 见「覆盖范围与尚未覆盖」与第 20 课落差表；未运行 `npm test`、skill / network 无专项测试等不确定项均已显式标注。
