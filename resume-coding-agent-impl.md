# Coding Agent 简历词条 · 实现对照

> 用途：把简历上 7 条"使用 X 实现 Y"的词条，逐条拆到代码级——**面试官问到哪一句，你能立刻指到哪个文件、哪个符号、哪个常量**。
> 所有符号名、常量值、行号均来自 `D:\SWEagent` 当前工作区实测，可直接 grep 验证。
> 最后更新：2026-09-17

---

## 〇、怎么用这份文件

- **第一遍**：通读"实现链路"，确认每条你都能用自己的话复述一遍。复述不出来的，就是面试会卡的地方。
- **第二遍**：只看"关键符号"表格。面试被追问时，你的回答里应该自然带出这些名字（它们证明你真的读过自己的代码）。
- **第三遍**：只看"追问预案"。这些是我预判面试官会问的第二问、第三问。
- **注意**：文末"事实核对"一节列了三个当前状态下的风险点，挂 GitHub 链接前必须处理。

---

## 一、全局：先记住这张代码地图

生产代码约 7800 行，46 个文件，分 7 层：

| 层 | 目录 | 职责 | 关键导出 |
|---|---|---|---|
| 执行内核 | `src/agent/` | 多轮循环、上下文、状态机、会话 | `Agent`、`TaskStateMachine`、`Session`、`ContextManager` |
| 工具层 | `src/tools/` | 注册、校验、审批、沙箱、命令、MCP | `ToolRegistry`、`SecurityPolicy`、`WorkspacePolicy`、`RustHelperSandboxBackend` |
| 模型层 | `src/model/` | 协议适配、HTTP 传输、重试 | `ModelClient`、`OpenAICompatibleModel`、`OpenAIResponsesModel`、`FetchHttpTransport` |
| 仓库层 | `src/repository/` | Git 只读查询、指令加载 | `GitRepository`、`GitChangeTracker` |
| 技能层 | `src/skill/` | Skill 目录与捕获 | `SkillCatalog` |
| 沙箱 helper | `sandbox-helper/` | OS 级隔离（独立进程） | 二进制，`--capabilities` / `--execute` |
| 入口 | `src/cli.ts`、`bin/veil.js` | CLI 与 REPL | `registerCliTools`、`CLI_MODEL_TOOL_NAMES` |

**一个必须记住的设计主线**：整个项目反复在做同一件事——**把"事实记录"和"给模型看的东西"分开**。
例子：门禁提示只临时塞进模型视图、不进 transcript；审计表只存结构化事件、不存 prompt 原文；工具输出超长就不进上下文、改存文件再给引用。这条主线在下面 7 条里出现了至少 4 次。

---

## 二、第 1 条 · 多轮执行闭环

> **简历原文**：使用 TypeScript 从零实现 Agent 多轮执行闭环，打通模型推理、工具调用与结果回灌，并通过步数上限、请求取消和断点续跑解决任务失控与中断丢失问题

### 实现链路

**1. 循环骨架**

入口是 `Agent.run()`，它做三件事就交给 `executeRun()`：准备消息数组、决定是否自建变更追踪器、用 `try/finally` 兜住释放逻辑。

真正的循环在 `executeRun()` 里，是一句朴素的 `for (; step <= this.options.maxSteps; step += 1)`。**没有递归、没有事件驱动的隐式跳转**——这是刻意的，多轮 Agent 最容易写成一团状态到处飞的代码。

**2. 一轮里发生什么**

① 循环开头先 `this.options.signal?.throwIfAborted()` 检查取消信号。放在开头而不是结尾，是为了**保证停止后不会再启动新的模型调用或工具执行**。

② 组装本次请求。这里有一个关键细节：如果任务状态机发现"有未验证的写入"，会**临时**往消息数组追加一条 system 提示（要求模型先调 `run_tests`）。注释写明这条提示只存在于本次模型视图，不写回 canonical transcript——否则 Session 恢复时上下文会被污染。

③ 交给上下文管理器压缩，然后 `generateWithRetry()` 调模型。

④ 模型返回的 assistant 消息**原样**推进消息数组（必须保留原始 toolCalls，下一轮 provider 才能把 tool result 和它关联上），随后立刻写一次 checkpoint，phase 记为 `"model"`。

⑤ 如果本轮没有 toolCalls → 收尾，`stopReason: "completed"`。

⑥ 有 toolCalls → 执行工具批次，结果作为 tool 消息追加，再写一次 checkpoint，phase 记为 `"tool"`，然后进入下一轮。

**3. 步数上限怎么落地**

常量 `DEFAULT_MAX_STEPS = 8`。构造函数里会校验它是正整数，非整数或小于 1 直接抛错——**不给"传 0 表示无限制"这种后门**。

循环正常退出（跑满）时，`stopReason` 是 `"max_steps"`，且如果存在未验证的写入，会把任务状态机 block 掉，理由是 `"maximum model steps reached before verification"`。

**4. 取消怎么落地**

单一个 `AbortSignal` 贯穿全程，从 `AgentOptions.signal` 往下传给模型请求和工具上下文，最终传到沙箱子进程。取消的检查点有两处：循环开头，以及 `defaultSleep()` 里——退避等待期间收到 abort 会立刻清掉定时器并 reject，不会傻等完 4 秒。

**5. 断点续跑怎么落地**

checkpoint 存的是 `{ sessionId, runId, step, phase, messages, toolResults }`。恢复时分两种 phase，逻辑完全不同：

- **phase = `"model"`**：说明上一轮模型调用完成后、工具还没跑完就断了。从消息数组**反向**找最后一个 assistant 消息，重新执行它的 toolCalls。
- **phase = `"tool"`**：说明工具批次的 checkpoint 已经写了。先找到最后一个 assistant 的下标，把它之后所有 tool 消息的 toolCallId 收集成 `resolved` 集合，然后**只跑不在集合里的** pending 调用。

这个区分很重要：phase=`"model"` 时可能一个工具都没跑，phase=`"tool"` 时可能跑了一半——不区分就会重复执行或漏执行。

**6. 幂等键**

每个工具调用的键是 `${runId}:${step}:${toolCallId}`。执行前先查 `replayToolResults`，命中就直接返回缓存结果、**不产生任何副作用**。这是断点续跑的最后一层保险：即使上面两种 phase 判断有偏差，已完成的工具也不会重放。

**7. 异常处理是刻意不对称的**

| 出错位置 | 后果 | 为什么 |
|---|---|---|
| 工具层抛错 | 转成 `{"error": "..."}` 的 tool 消息，`succeeded: false`，**run 继续** | 模型看到错误可以自我修复，这是 Agent 的价值所在 |
| 模型层抛错 | `emit run_failed` + `throw`，**整个 run 终止** | 模型都调不通了，没有"下一步"可言，硬撑只会浪费重试预算 |

### 关键符号（可直接 grep）

| 符号 | 位置 | 说明 |
|---|---|---|
| `DEFAULT_MAX_STEPS` | `src/agent/agent.ts:20` | 值 `8` |
| `DEFAULT_CONTEXT_BUDGET` | `src/agent/agent.ts:22` | `{ maxInputTokens: 32_000 }` |
| `executeRun` | `src/agent/agent.ts:81` | 主循环 |
| `executeToolBatch` | `src/agent/agent.ts:247` | 工具批次与并发门禁 |
| `executeOnePendingCall` | `src/agent/agent.ts:271` | 幂等键与缓存命中 |
| `checkpoint` | `src/agent/agent.ts:343` | phase 与 toolResults 落盘 |
| `TaskStateMachine` | `src/agent/task-state-machine.ts` | 状态集 `received/working/verifying/repairing/completed/blocked` |

### 追问预案

**Q：为什么是 8 步？**
A：8 是"够用且不失控"的经验值。一个正常的改代码任务——读文件、改文件、跑测试、看到失败、再改、再跑——大概 5 到 6 步，留 2 步余量。上限的意义不是精确控制，而是**给一个确定的天花板**：模型陷入循环时，成本是有界的。这个值可通过 `maxSteps` 传参覆盖，不硬编码在调用点。

**Q：为什么工具报错不终止，模型报错就终止？**
A：工具报错是**任务的一部分**——测试失败、文件不存在、命令超时，这些都是模型应该看到并据此修复的信息。把它们吞掉或直接终止，等于剥夺了 Agent 自我修复的能力。模型报错是**基础设施故障**（网络、限流、协议），重试预算耗尽后继续跑没有意义。

**Q：断点续跑具体续的是什么？**
A：续的是"工具执行"这一环，不是模型推理。模型推理是纯函数调用，重放它没有副作用；但工具会改文件、跑命令。所以 checkpoint 记的是 step + phase + messages + toolResults，恢复时重放未完成的工具，已完成的一律走缓存。

---

## 三、第 2 条 · 统一模型契约与双协议

> **简历原文**：使用统一 ModelClient 契约屏蔽模型供应商差异，以同一套上层语义适配 Chat Completions 与 Responses 双协议，支持 SSE 流式输出、并行工具调用与按错误类型区分的退避重试

### 实现链路

**1. 契约本身**

`ModelClient` 是一个只有五项的最小接口：`provider`、`model`、`capabilities`、`generate()`，以及可选的 `generateStream()`。整个 Agent 只认这个接口，不认任何供应商 SDK。

`ModelRequest` / `ModelResponse` / `ModelStreamEvent` 三种类型是"供应商无关语义"的全部——**协议差异一律在适配层内消化，一层都不许漏到上层**。

**2. 双协议怎么接**

- `OpenAICompatibleModel` 处理 `chat-completions` 协议
- `OpenAIResponsesModel` 处理 `responses` 协议

选择点在 `createConfiguredModelClient()`：一句 `config.protocol === "responses" ? OpenAIResponsesModel : OpenAICompatibleModel`。上层调用方完全不需要知道选了哪个。

**3. 协议不许猜**

协议由环境变量 `CODING_AGENT_MODEL_PROTOCOL` 显式指定，取值只能是 `chat-completions` 或 `responses`，默认 `chat-completions`。

README 里明确写了"禁止根据响应内容自动猜测协议"。理由：猜测意味着**请求已经发出去了**——如果猜错，你已经付了一次调用成本，还可能拿到一个语义不对的响应。显式配置把错误提前到启动时。

**4. SSE 流式怎么落地**

传输层是 `FetchHttpTransport.requestStream()`，返回一个带状态码、头、以及 `AsyncIterable<Uint8Array>` 的响应对象。

Agent 侧的 `collectStream()` 消费四类事件：

| 事件 | 处理 |
|---|---|
| `text_delta` | 累加到 content，同时 `emit model_delta` 让上层实时看到 |
| `tool_call_delta` | 按 `event.index` 聚合，id / name / argumentsDelta 分段累加 |
| `usage` | 记录 token 用量 |
| `done` | 记录 finishReason |

流式工具调用最容易出错的地方是**参数是分片到达的**——一个 JSON 字符串可能被切成七八段。所以必须按 index 聚合成完整字符串，最后才 `JSON.parse`。解析失败直接抛 `"Invalid streamed tool arguments"`，不猜。

聚合完成后按 `index` 升序排序，因为 Map 的遍历顺序不能保证与模型声明的顺序一致。

**5. 并行工具调用怎么落地**

模型一轮可以返回多个 toolCall。`executeToolBatch()` 用"分批 wave"的方式处理：

对一个调用，满足**任一**条件就先把当前 wave 刷出去（`Promise.all` 并发执行）：
- 这个调用不可并行（`manifest.parallelizable !== true`）
- 当前 wave 长度已达 `maxConcurrentToolCalls`，默认 4
- 这个调用与 wave 里已有的调用冲突（`conflictKey` 相同）

不可并行的调用单独串行执行。

**结果必须按声明顺序回传**，因为 tool 消息要和 assistant 消息里的 toolCalls 顺序对齐，否则下一轮 provider 关联不上。但 `Promise.all` 的完成顺序是不确定的，所以最后一步是 `calls.map(call => results.find(...))` 重新排序。

一个值得主动讲的取舍：**读同一个文件的两次 `read_file` 也算冲突，会被串行化**。这是保守选择——纯读理论上可以并发，但没给它开特例，因为判断"两次读是否真的无冲突"需要额外规则，收益小、复杂度高。

**6. 退避重试怎么落地**

`generateWithRetry()` 的四个参数都有默认值：

| 参数 | 默认值 |
|---|---|
| `maxAttempts` | 3 |
| `maxTotalMs` | 60_000 |
| `initialBackoffMs` | 250 |
| `maxBackoffMs` | 4_000 |

**只有四种错误码可重试**：`timeout`、`network`、`rate_limited`、`server_error`。

其余一律不重试，直接抛。这个划分是关键——参数错误（400）、认证失败（401）、权限不足（403）重试一万次也是同样的结果，只会浪费时间并可能触发风控。

退避时长：优先用响应头解析出的 `retryAfterMs`，没有才用 `initial * 2 ** (attempt - 1)` 指数退避，最后用 `maxBackoffMs` 封顶。

每次重试都 `emit model_retry` 事件并写审计，记录 errorCode 和实际 delayMs。

**7. 传输层的两条硬规则**

- **强制覆盖 `init.signal`**。注释写得很直接：避免调用方传入的另一信号绕过统一超时和取消处理。也就是说，传输层对外只认一个取消来源。
- **不向上泄漏原始错误 message**。`fetch` 和响应流的原始异常里可能带请求地址甚至凭据，所以统一替换成 `"Model request failed before a response was received"`。

资源限制：默认超时 30_000 ms，响应体上限 1 MB，超限直接终止读取。

### 关键符号

| 符号 | 位置 | 说明 |
|---|---|---|
| `ModelClient` | `src/agent/types.ts:213` | 五项最小接口 |
| `ModelRetryOptions` | `src/agent/types.ts:224` | 四个退避参数 |
| `OpenAICompatibleModel` | `src/model/openai-compatible.ts:14` 附近 | chat-completions 适配 |
| `OpenAIResponsesModel` | `src/model/openai-responses.ts:14` | responses 适配 |
| `createConfiguredModelClient` | `src/model/runtime-config.ts:67` | 协议选择点 |
| `FetchHttpTransport` | `src/model/transport.ts:55` | 受限 HTTP 传输 |
| `DEFAULT_TIMEOUT_MS` / `DEFAULT_MAX_RESPONSE_BYTES` | `src/model/transport.ts:3-4` | `30_000` / `1024 * 1024` |
| `ModelTransportError` | `src/model/errors.ts` | 错误码归一 |

### 追问预案

**Q：双协议适配，工作量最大的地方在哪？**
A：不在发请求，在**归一化响应**。两个协议的工具调用结构不同、流式事件不同、finishReason 的表达也不同。适配层的价值就是把这三处差异全部吃掉，让 `Agent` 里的代码只有一份。判断标准很简单：如果哪天要接第三个协议，看需不需要改 `Agent` —— 不需要改，说明契约划对了。

**Q：为什么不用现成的 SDK 直接调？**
A：SDK 会把供应商概念渗进上层。这里刻意只依赖 `fetch`，用一个 62 行的 `HttpTransport` 接口把它包起来，好处是**单元测试可以注入假 fetch，完全不碰网络**。

**Q：重试和熔断的区别是什么？**
A：本项目里重试在模型层（针对单次调用），熔断在命令工具层（针对渠道整体可用性）。重试是"这次失败了再来一次"，熔断是"连续失败太多次，先别再试了"。两个尺度不同。

---

## 四、第 3 条 · 工具注册、能力声明与路径边界

> **简历原文**：使用 manifest 能力声明与 Zod 参数校验构建工具注册与权限体系，解决工具越权调用与非法参数问题，并用 realpath 解析工作区边界拦截路径穿越与符号链接逃逸

### 实现链路

**1. manifest 声明了什么**

`ToolManifest` 是每个工具的"身份证"：

| 字段 | 作用 |
|---|---|
| `capabilities` | 四种能力之一或多种：`read` / `write` / `execute` / `network` |
| `inputSchema` | Zod schema，运行时校验 + 类型收窄 |
| `modelInputSchema` | 面向模型的 JSON Schema。**未声明就不发给模型** |
| `parallelizable` | 只有显式声明为 true，才允许同批次并发 |
| `conflictKey` | 返回相同键的调用必须串行 |
| `verification` | 本地执行的验证声明，不会发给模型 |

`modelInputSchema` 那个设计值得单独讲：**同一个工具可以「对内接受更多参数，对外只暴露一部分」**。比如一个工具内部需要 `sessionId`、`runId` 这类运行时字段，这些完全不该让模型看见，更不该让模型有机会伪造。所以 `ToolRegistry.listModelDefinitions()` 只挑声明了 `modelInputSchema` 的工具往外发。

**2. 执行顺序是刻意设计的**

`ToolRegistry.execute()` 的顺序是：

① 找工具 → ② **Zod 校验参数** → ③ 审批授权 → ④ 真正执行

校验放在审批之前，注释给了明确理由：**避免非法参数触发预览、副作用或路径解析**。因为 `preview()` 里可能已经读了文件、解析了路径——如果参数是脏的，这些动作本身就是一次信息泄漏。

**3. 审批怎么判定**

`SecurityPolicy.authorize()` 的规则：

- 工具没有 manifest 且 `requireManifest` 为真（默认就是真）→ 直接抛错。**没有身份证的工具不许跑。**
- capabilities 全是 `read` → 直接放行，不打扰用户。
- 其他情况 → 先调 `preview()` 生成预览，构造 `ApprovalRequest`，交给 `DefaultApprovalPolicy`。
  - 策略里如果配了 `confirm` 回调就走回调；**没配回调就返回 false**（默认拒绝）。
  - 被拒 → 抛 `ApprovalDeniedError`。

`DefaultApprovalPolicy` 的默认行为是"**只自动允许只读，其余一律要确认**"——这是一个 fail closed 的默认值。

**4. 路径边界怎么做的**

`WorkspacePolicy` 的构造函数第一件事：

    根目录 = fs.realpathSync.native(path.resolve(root))

**先 realpath 再存**。这样后续所有路径比较都在"已经解析掉符号链接"的同一基准上做，不会出现 A 路径没解析、B 路径解析了，比出来一个假的安全结论。

`resolveExisting()` 的顺序：
① 非空字符串检查 → ② 含 `\0` 直接拒 → ③ `fs.realpathSync.native(path.resolve(root, input))` → ④ `assertWithin` → ⑤ `assertVisible`

第 ③ 步的注释是：**先解析符号链接再做边界判断，防止链接把访问带出工作区**。这是整个方案的核心——如果先判断再解析，一个指向 `C:\Windows` 的符号链接在判断时看起来还在工作区里，解析后已经出去了。

`assertWithin()` 用相对路径三段判断：结果为空（就是根本身）、等于 `..`、以 `.. + 分隔符` 开头、或是绝对路径——任一命中就拒。

`assertVisible()` 默认拒绝隐藏路径。理由是 dotfile 里通常是凭据（`.env`）和工具元数据（`.git`）。要访问得显式开 `allowHidden`。

另外提供 `resolveControlledExisting()`：允许在**受控子树**内访问隐藏目录，给 Skill 这类需要读元数据的场景用——它先解析受控根，再算相对路径判断是否在根内，路径逃逸同样拒绝。

**5. 资源限制**

`maxFileBytes` 默认 1 MB，`maxEntries` 默认 5000。`resolveFile()` 会 `statSync` 检查 `isFile()` 和大小，超限抛错。

### 关键符号

| 符号 | 位置 | 说明 |
|---|---|---|
| `ToolManifest` | `src/agent/types.ts:40` | 六个字段 |
| `ToolCapability` | `src/agent/types.ts:7` | `read` / `write` / `execute` / `network` |
| `ToolRegistry.execute` | `src/tools/tool-registry.ts:50` | 校验→授权→执行 |
| `listModelDefinitions` | `src/tools/tool-registry.ts:37` | 只发声明过的 |
| `WorkspacePolicy` | `src/tools/security.ts:27` | 路径边界 |
| `resolveExisting` | `src/tools/security.ts:50` | realpath 后判边界 |
| `SecurityPolicy.authorize` | `src/tools/security.ts:184` | 审批入口 |
| `DefaultApprovalPolicy` | `src/tools/security.ts:136` | 只读自动放行 |
| `ApprovalDeniedError` | `src/tools/security.ts:152` | 拒绝异常 |

### 追问预案

**Q：realpath 就够了吗？能想到什么绕过方式？**
A：够挡住"路径穿越"和"符号链接逃逸"这两类。但有一个真实的时间窗口：**realpath 检查通过之后、真正 open 之前，路径可以被换成链接**——这是经典的 TOCTOU。本项目在沙箱执行这条链上处理了这个问题的同类变种（用 digest 绑定审批），文件读写这条链上是先 realpath 再交给 Node 的 fs，窗口理论上存在但需要本地攻击者已在同机运行。

**Q：为什么 Zod 和 JSON Schema 要两套？**
A：分工不同。Zod 是**运行时的门**，把 `unknown` 收窄成工具自己的输入类型，错误信息也更好。JSON Schema 是**给模型看的说明书**，模型只认这个格式。用 Zod 自动生成 JSON Schema 也可以，但那样"对外暴露哪些字段"就失去了显式控制点——现在必须手写 `modelInputSchema`，等于强制作者想一遍"这个参数该不该给模型看"。

**Q：只读工具为什么免审批？**
A：审批的意义是防副作用。只读没有副作用，每次都弹确认会让用户很快学会无脑点"是"，反而削弱了对写操作的注意力。**审批疲劳本身就是安全问题**。

---

## 五、第 4 条 · 沙箱 helper 与能力探测

> **简历原文**：使用受限命令执行与独立沙箱 helper 进程解决不可信命令的安全落地问题，限制工作目录、环境变量、超时、输出大小与子进程树，隔离能力探测不通过即拒绝开放命令工具，不降级裸跑

### 实现链路

**1. 三个后端，各司其职**

`SandboxBackend` 接口只有三样：`capabilities`、`assertAvailable()`、`spawn()`。实现有三个：

| 实现 | 用途 |
|---|---|
| `RustHelperSandboxBackend` | 生产后端，透明代理到独立 helper 进程 |
| `ProcessSandboxBackend` | 兼容本地测试与开发配置。**明确不宣称具备 OS isolation** |
| `UnavailableSandboxBackend` | helper 未配置或握手失败时使用，保证 fail closed |

`UnavailableSandboxBackend` 的 `assertAvailable()` 无论要什么能力都抛错，错误信息是 `"Sandbox backend is unavailable; refusing to spawn a host process"`。这就是"不降级裸跑"的实现——**没有可用的沙箱时，宁可不执行**。

**2. 能力握手**

构造函数里 `execFileSync(helperPath, ["--capabilities"])`，默认超时 3000 ms。

返回必须是 `{ backend: "rust-helper", version: "1", capabilities: [...] }`，backend 或 version 不对直接抛 `"invalid helper capability response"`。整个 try 的 catch 会把任何失败统一转成 `SandboxUnavailableError`。

这里有个兼容处理：旧版 helper 没上报新版细粒度别名，所以本地快照里补两个——有 `workspace.fs` 就补 `filesystem.workspace_write`，有 `process.spawn` 就补 `resource.limits`。

**3. 能力清单是按 OS 机制设计的**

能力名不是抽象等级，而是直接对应操作系统机制：

| 平台方向 | 能力名 |
|---|---|
| 通用 | `process.spawn`、`process-tree`、`workspace.fs`、`resource.limits`、`filesystem.workspace_write` |
| 网络 | `network.off`、`network.loopback`、`network.proxy`、`network.allowlist` |
| Windows 侧 | `hardening.appcontainer`、`hardening.handle_whitelist`、`hardening.restricted_token`、`hardening.explicit_environment`、`hardening.job_object`、`hardening.acl_recovery_journal` |
| Linux 侧 | `hardening.no_new_privs`、`hardening.read_only_root`、`hardening.credential_paths`、`hardening.seccomp`、`hardening.cgroup` |
| 抽象能力 | `os.isolation` |

设计原则写在源码注释里：**能力由后端声明，上层不得根据 platform 分支推断隔离强度**。也就是说，Agent 里不允许出现 `if (process.platform === "win32")` 这种代码来假设"Windows 上应该安全"。安不安全由 helper 自证。

**4. 执行请求怎么传**

TS 侧把 `ExecutionRequest` 序列化成 JSON → base64 → 作为 `--execute <base64>` 传给 helper 的 argv。helper 自己完成握手和请求校验，TS 侧只负责传递规范化后的请求。

字段包括：`workspace_root`、`execution_id`、`executable`、`args`、`cwd`、`env`、`timeout_ms`、`max_stdout_bytes`、`max_stderr_bytes`、`network`、`cpu_time_ms`、`memory_bytes`、`max_processes`。

**5. 风险分级与最小能力集**

`classifyExecution()` 把每次执行分到 R1–R5：

| 条件 | 等级 |
|---|---|
| 网络不是 off | R5 |
| 是 shell，或参数里有 `.ps1/.bat/.cmd/.sh/.py/.js/...` 脚本文件 | R4 |
| 是脚本运行时或工具链命令（node/python/git/npm/cargo/rustc...） | R4 |
| env 里带 `PATH` | R3 |
| `maxProcesses > 1` | R3 |
| 有写意图 | R2 |
| 其余 | R1 |

`decideSandboxPolicy()` 再推导需要哪些能力：

基础四项必查：`process.spawn`、`workspace.fs`、`networkCapability(policy.network)`、`resource.limits`。
按需追加：多进程 → `process-tree`；allowlist 网络 → `network.proxy`；有写意图 → `filesystem.workspace_write`。

然后 `missingCapabilities = required 里能力快照没覆盖的`。**只要 missing 非空，`allowed` 就是 false**。原因也写进返回值了：`Missing sandbox capabilities: ...`

**6. 审批绑定摘要（这条是最有含金量的设计点）**

`policyBindingDigest(request, policy, capabilities)` 把三样东西拼起来算 SHA-256：

① 规范化后的请求（args 原序、env 键排序、network 规范化、capabilities 排序）
② 推导出的策略
③ **实际的能力快照**

意义：**审批和执行之间，任何一项变了，摘要就对不上，必须重新授权**。这挡住了 TOCTOU——先拿一个低风险请求骗到审批，执行时偷换成高风险请求。也挡住了"审批时 helper 能力齐全、执行时能力掉了"这种情况。

另外 `executionRequestDigest()` 里明确把 `executionId` 排除在语义外，注释解释：它只用于运行追踪，不算审批语义，所以同一个请求的 preview 和 execute 必须得到同一个摘要。

**7. CLI 侧的开关逻辑**

`registerCliTools(registry, workspace, helperPath = process.env.CODING_AGENT_SANDBOX_HELPER, ...)`

- **未设** `CODING_AGENT_SANDBOX_HELPER` → 只注册 5 个工作区工具，`run_command` 根本不出现。
- **已设** → 先 `sandbox.assertAvailable(["process.spawn", "workspace.fs", "network.off", "os.isolation"])`，通过才注册全部 6 个。

关键在失败路径：这个异常**没有 catch**。它会冒到顶层，结果是**一个工具都不注册**。这就是 fail closed 的字面实现——不是"少了 run_command，其他照常"，而是整个注册流程中止。

`CLI_MODEL_TOOL_NAMES` 常量锁定了默认暴露给模型的 5 个名字：`read_file`、`list_files`、`apply_patch`、`run_tests`、`search_text`。

**8. 命令工具自身的限制**

| 限制 | 值 |
|---|---|
| 默认超时 | 10_000 ms |
| stdout / stderr 上限 | 64 KB 各 |
| 环境变量 | 白名单透传，不是全量继承 |
| 资源 | `cpuTimeMs` / `memoryBytes` / `maxProcesses` |
| 网络默认 | `network.off`，扩展必须由本地策略配置 |

### 关键符号

| 符号 | 位置 | 说明 |
|---|---|---|
| `SandboxBackend` | `src/tools/sandbox.ts:74` | 三方法接口 |
| `SandboxCapability` | `src/tools/sandbox.ts:5` | 22 项能力清单 |
| `RustHelperSandboxBackend` | `src/tools/sandbox.ts:140` | 生产后端与握手 |
| `UnavailableSandboxBackend` | `src/tools/sandbox.ts:119` | fail closed |
| `executionRequestDigest` | `src/tools/sandbox.ts:223` | 请求摘要 |
| `classifyExecution` | `src/tools/sandbox-policy.ts:22` | R1–R5 分级 |
| `decideSandboxPolicy` | `src/tools/sandbox-policy.ts:52` | 最小能力集与 allowed |
| `policyBindingDigest` | `src/tools/sandbox-policy.ts:80` | 防 TOCTOU 的绑定摘要 |
| `registerCliTools` | `src/cli.ts:107` | 探测不通过即全不注册 |
| `CLI_MODEL_TOOL_NAMES` | `src/cli.ts:41` | 5 个默认工具 |

### 追问预案

**Q：为什么把沙箱单独做成一个进程，不直接在 Node 里做？**
A：因为**能做到什么隔离取决于操作系统，而不是取决于用什么语言写**。Windows 上要 `CreateJobObject`、`FwpmEngineOpen0`、`CreateRestrictedToken`、`CreateAppContainerProfile`；Linux 上要 namespace、seccomp BPF、cgroup v2、`prctl`。这些都是系统调用级操作，需要一个能直接跟内核对话、且崩溃了不会拖垮主进程的边界。独立进程同时带来两个好处：**隔离能力可以自证**（`--capabilities`），**崩溃爆炸半径有限**。

**Q：helper 挂了怎么办？**
A：分两种。启动时握手失败 → `SandboxUnavailableError`，CLI 那个未捕获的异常会让整个工具注册中止，一个都不注册。运行中 spawn 失败 → `assertAvailable` 会先抛，命令工具收到 `SandboxUnavailableError`，工具层把它转成 `{error: ...}` 的 tool 消息返回给模型。两种情况都不会退化成"直接在本机跑"。

**Q：`os.isolation` 这个能力名是不是太抽象了？**
A：它是个**门槛标记**，不是实现。CLI 拿它作为"这个后端是否真的做了 OS 级隔离"的准入条件——`ProcessSandboxBackend` 的能力快照里**没有**它，所以那个后端在 CLI 路径上永远过不了探测。把"是不是真隔离"编码成一个显式能力位，比在上层判断后端类型名更不容易出错。

---

## 六、第 5 条 · MCP 外部工具接入

> **简历原文**：使用宿主指定的 MCP 客户端接入本地 stdio 与远程两类外部工具，解决外部工具越权访问宿主进程的风险，工具发现与调用前均须审批

### 实现链路

**1. 两个客户端**

| 客户端 | 协议 | 文件 |
|---|---|---|
| `McpStdioClient` | 本地 stdio | `src/tools/mcp.ts` |
| `McpRemoteClient` | 远程 Streamable HTTP | `src/tools/mcp-remote.ts` |

两者都实现 `McpClient` 接口，所以上层适配代码只写一份。

**2. "宿主指定"到底指什么**

`mcp.ts` 里有一句注释：**本地 MCP Server 的启动信息完全由宿主配置，模型永远不能传入这些字段**。

这是关键。启动一个 MCP Server 等于执行一个本地进程——如果模型能决定启动哪个可执行文件、带什么参数、在什么目录下跑，那这个能力本身就是个后门。所以这些字段只能来自宿主的配置文件，模型的输入里根本没有这一项。

配置加载在 `loadMcpConfig()` / `defaultMcpConfigPath()`，Server 需要显式选择（环境变量 `CODING_AGENT_MCP_SERVERS` 逗号分隔）才会被启用。

**3. 发现的工具怎么变成普通工具**

`createMcpTools(client)`：连上 Server → `listTools()` → 每个工具包成一个普通 `Tool`，以**稳定前缀**注册，避免与内建工具撞名。

同时提供 `createMcpResourceTools()` 和 `createMcpPromptTools()`，分别把 MCP 的 resources/prompts 也适配成工具。

这里有一条贯穿性规则：**远程返回的内容始终作为不可信 tool result**，注释明确"不把远程返回内容提升为 system prompt"。MCP prompt 里可能夹带指令，如果直接当 system 用，就是一次 prompt injection 的入口。

**4. 能力快照分开算**

`McpRemoteClient.capabilitySnapshot` 返回的是 `{ backend: "remote-http", capabilities: ["network", ...] }`，注释写明：**远程业务能力与本机用于连接 Server 的 network capability 分开计算**。

意思是"这个远程 Server 能做什么"和"我要连它需要本机开放什么"是两件事，不能混成一个数字。

**5. OAuth 与 PKCE**

`OAuthAuthenticator` 实现完整的授权码 + PKCE 流程：

① **元数据发现**：`discoverAuthorizationServerMetadata()` 和 `discoverProtectedResourceMetadata()`。远程 Server 返回 401 且带 resource metadata URL 时，客户端会去抓这个 URL 拿授权服务器信息。

② **PKCE 三件套**：`code_challenge` + `code_challenge_method=S256` + `code_verifier`。挑战值用 S256（SHA-256）而不是 plain，防止授权码在传输中被截获后直接兑换。

③ **state 防 CSRF**：`crypto.randomBytes(32)` 转 base64Url 生成 state，回调时校验 `callbackResult.state !== state` 就抛 `"OAuth state mismatch"`。

④ **刷新去重**：`refreshes` 是一个 `Map<string, Promise<OAuthCredential>>`。同一个 key 的并发刷新请求只会真正发一次，其他的复用同一个 Promise。这是很实用的细节——多个工具同时发现 token 过期时，不会打出一串刷新请求。

⑤ **凭证存储**：`MemoryCredentialStore`（测试/临时）与 `FileCredentialStore`（落盘）。

**6. 审批在两个时点**

- **bootstrap 时**：`approveBootstrap: (request) => prompt.confirmTool({ toolName: 'mcp_${serverId}_bootstrap', capabilities: ['network'], ... })` —— 启动一个 MCP Server 也要走确认。
- **工具调用时**：MCP 工具作为普通 `Tool` 注册进 `ToolRegistry`，所以自动继承 `SecurityPolicy.authorize()` —— 有 manifest、非只读就要审批。

**7. 登录必须交互式**

`veil /mcp login <id>` 之前先检查 `isInteractiveTerminal(stdin, stdout)`，不是 TTY 直接抛 `"MCP login requires an interactive TTY"`。理由是不允许在自动化环境里静默走完 OAuth 授权——那等于把用户授权变成无人值守行为。

### 关键符号

| 符号 | 位置 | 说明 |
|---|---|---|
| `McpStdioClient` | `src/tools/mcp.ts:57` | 本地 stdio |
| `McpRemoteClient` | `src/tools/mcp-remote.ts:61` | 远程 Streamable HTTP |
| `createMcpTools` | `src/tools/mcp.ts:189` | 适配为普通 Tool |
| `McpProtocolError` | `src/tools/mcp.ts:52` | 协议异常统一拒绝 |
| `OAuthAuthenticator` | `src/tools/mcp-auth.ts:108` | PKCE + 刷新 |
| `FileCredentialStore` | `src/tools/mcp-auth.ts:29` | 凭证落盘 |
| `McpRuntime` | `src/tools/mcp-runtime.ts` | 生命周期与 bootstrap |
| `handleMcpSlashCommand` | `src/cli.ts:239` 附近 | `/mcp list/login/logout` |

### 追问预案

**Q：为什么 MCP 工具要审批，内建工具却不用？**
A：内建工具的行为是你自己写的，边界在代码里可见。MCP 工具的行为定义在**外部进程或远程服务**里，你无法审计它到底做什么。所以它不是"多一层校验"，而是**信任等级本来就不同**。同理，MCP 返回的内容一律当不可信输入处理。

**Q：为什么不用现成的 MCP 客户端库？**
A：这个项目里 MCP 客户端是手写的协议实现——初始化握手、`tools/list`、`tools/call`、resources/prompts，加上 OAuth。手写的理由和整个项目的方向一致：**要把审批点插在协议层里**。用第三方库的话，审批只能挂在调用外围，而拿不到"发现阶段"这个机会——而 MCP 的风险恰恰有一部分在发现阶段（一个 Server 报出来的工具数量、名称、schema 本身就可以是攻击面）。

**Q：远程 MCP 和本地 MCP 的风险差别在哪？**
A：本地 stdio 的风险是**进程权限**——它跑在你的机器上，用你的用户身份。远程的风险是**数据外泄和 prompt injection**——你得把上下文发出去，回来的内容不可信。所以本地侧重点在启动信息不允许模型控制，远程侧重点在内容不提升为 system prompt、返回内容当不可信 tool result。

---

## 七、第 6 条 · SQLite 会话与运行 checkpoint

> **简历原文**：使用 SQLite 持久化会话与运行 checkpoint 解决任务中断后的恢复问题，工具结果带稳定幂等键且已完成工具不重放，审计表 append-only 不落 API key 与完整模型请求

### 实现链路

**1. 用的是 Node 内置 SQLite**

`node:sqlite` 的 `DatabaseSync`，不加原生依赖。这也是整个项目"运行时依赖只有 `diff` + `zod`"这条原则的一部分。

构造函数立刻打三条 PRAGMA：

    PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;

- **WAL**：读写不互相阻塞，多进程读友好。
- **foreign_keys = ON**：SQLite 默认是关的，必须显式打开才能真正生效。
- **busy_timeout = 5000**：锁竞争时等 5 秒再报错，而不是立刻失败。

**2. 表结构七张**

| 表 | 作用 |
|---|---|
| `schema_migrations` | 版本记录 |
| `sessions` | 会话：工作区根、状态、时间 |
| `runs` | 每次运行：输入、状态、结果、owner、租约 |
| `messages` | 消息全量，`UNIQUE(session_id, sequence)` |
| `checkpoints` | 运行断点，`PRIMARY KEY(run_id)` |
| `context_checkpoints` | 上下文压缩断点 |
| `audit_events` | 审计事件，`UNIQUE(session_id, sequence)` |

**3. 迁移是逐版本递进的**

`SCHEMA_VERSION = 5`。`migrate()` 先读当前版本：

- 版本 **高于** 支持值 → 直接抛 `"Session database schema ${current} is newer than supported"`。**不尝试降级**，因为那等于用新代码改旧结构，数据风险不可控。
- 版本 1 → 加 `owner_id` / `lease_until` 两列 → 2
- 版本 2 → 建 `checkpoints` → 3
- 版本 3 → 建 `context_checkpoints` → 4
- 版本 4 → 建 `audit_events` + 索引 → 5
- 空库 → 一次性建全部表

每一版都在事务里执行。

**4. 事务同时承担跨进程互斥**

`transaction()` 用的是 `BEGIN IMMEDIATE`，不是普通的 `BEGIN`。

`startRun()` 里那句注释就是理由：**SQLite 事务同时承担跨进程互斥，避免两个终端在内存锁之外并发占用同一 Session**。

逻辑是：事务内先查这个 session 有没有 `status = 'running'` 的 run，有就抛 `"Session already has an active run"`。因为是 IMMEDIATE 事务，写锁一开始就拿到了，两个进程同时进来的话第二个会等锁，等到了再查就已经能看到第一个的插入。

**5. 租约与心跳**

光有"有没有 running"这个判断不够——**进程被 kill -9 之后，数据库里那条 run 会永远停在 running**，会话就再也没法用了。

所以加了租约机制：
- `lease_until` 默认 `now + 30_000 ms`
- `heartbeatRun()` 定期续租，且必须匹配 `owner_id`（只有持有者能续）
- `interruptExpiredRuns()` 把 `status = 'running'` 且租约已过期的 run 改成 `interrupted`，清空 owner 和租约
- `resumeRun()` 只能恢复 `status = 'interrupted'` 的 run，且 `changes !== 1` 就抛错（说明状态不对，别硬来）

**6. checkpoint 用 UPSERT**

    ON CONFLICT(run_id) DO UPDATE SET step=..., phase=..., payload_json=..., updated_at=...

同一个 run 只保留最新一个 checkpoint，不需要历史。`phase` 有 CHECK 约束只允许 `'model'` 和 `'tool'` —— 和第一节的恢复逻辑严格对应。

`context_checkpoints` 单独一张表，存的是上下文压缩状态：`covered_through_sequence`（压到哪条消息）、`source_prefix_hash`（源消息前缀指纹）、`summary_segments_json`、`retained_tail_start`。

**指纹那个字段是关键**：摘要按源消息前缀缓存，**同一个前缀绝不重复摘要**。否则每轮都重摘要一次，既费钱又不稳定。

**7. 审计表为什么不落敏感内容**

`record(event)` 插入的列是一份严格白名单：

`session_id`、`run_id`、`sequence`、`event_type`、`step`、`tool_call_id`、`tool_name`、`attempt`、`status`、`error_code`、`request_id`、`metadata_json`、`created_at`

**没有 prompt 列，没有 model response 列，没有 API key 列。**

这就是"不落 API key 与完整模型请求"的实现方式——**不是靠过滤，是靠表结构里根本没有这两个字段**。写不进去，比"记得别写"可靠。

`sequence` 自增且 `UNIQUE(session_id, sequence)`，保证同一会话内事件有序且不重。

**8. append-only 怎么保证**

审计表只提供 `record()` 写入和 `listAuditEvents()` 读取，没有 update、没有 delete 方法。API 层面就没有修改路径。

错误信息也只截断保留：`metadata: { error: message.slice(0, 1024) }`——审计要能定位问题，但不能变成日志倾倒场。

**9. 关闭时合并 WAL**

`close()` 先 `PRAGMA wal_checkpoint=FULL` 再关句柄。而且这一步被 `try/catch` 包住，注释说明：**数据库已损坏时仍继续释放句柄**——清理动作不能因为清理失败而卡住。

### 关键符号

| 符号 | 位置 | 说明 |
|---|---|---|
| `SCHEMA_VERSION` | `src/agent/sqlite-session-store.ts:6` | 值 `5` |
| `SqliteSessionStore` | `src/agent/sqlite-session-store.ts:9` | 存储实现 |
| `startRun` | `:37` | 跨进程互斥 |
| `heartbeatRun` | `:52` | 续租 |
| `interruptExpiredRuns` | `:89` | 超期回收 |
| `saveCheckpoint` | `:94` | UPSERT |
| `saveContextCheckpoint` | `:103` | 摘要指纹 |
| `record` | `:112` | 审计白名单 |
| `transaction` | `:137` | `BEGIN IMMEDIATE` |

### 追问预案

**Q：为什么不用 PostgreSQL / Redis？**
A：场景是**单用户、本地、零部署**。SQLite 随 Node 自带、有真事务、单文件可拷。要换成多用户高并发，接口是 `SessionStore`，换实现即可，上层不动。

**Q：checkpoint 每次都写全量 messages，会不会很重？**
A：会，而且是已知取舍。代价换来的是恢复逻辑极简——不需要在恢复时重放消息构造过程。优化方向是只存增量 + 定期压实。当前会话规模下这个开销可以接受，**但这是个真实的优化项，面试时主动说比被问出来好**。

**Q：审计表为什么不做成通用的 event sourcing？**
A：通用 event sourcing 需要 schema 和重放语义，复杂度是数量级上升。这里的目标很窄：**回答"这次运行里发生了什么、哪一步失败了"**。窄目标就别用重方案。

---

## 八、第 7 条 · 工作区快照与 Git 基线

> **简历原文**：使用运行前后工作区快照生成任务级 unified diff，叠加 Git 基线区分用户已有改动与 Agent 改动

### 实现链路

**1. 快照放在磁盘，不放在内存**

`RunChangeTracker.start()` 用 `fs.mkdtemp(path.join(os.tmpdir(), "coding-agent-baseline-"))` 建临时基线目录。

这个选择有明确理由，写在注释里：**避免把工作区内容留在内存**。一个正常项目几百 MB，全量读进内存既浪费又危险。

**2. 快照里存什么**

每个文件一条记录：`fileType`（`text` / `binary` / `untracked`）、`size`、`mtimeMs`、`hash`（sha256）、`baselinePath`。

文本文件会**实际复制到基线目录**——因为 diff 时需要原始内容，而不是只比较哈希。二进制文件只记元数据，不复制。

**3. 性能优化：先比元数据，再算哈希**

遍历时对每个文件：

- 如果上一次快照里有同路径、且 `size` 和 `mtimeMs` 都一样 → **直接复用旧条目，不重读、不重算哈希**。

注释很直白：**绝大多数未变化文件无需再次读取和计算哈希**。这是整个快照方案的性能基础——第二次快照（`finish()` 时）的成本主要落在真正变化的文件上。

- 只有当元数据变了，才计算哈希。

**4. 三条资源上限与完整性标记**

| 上限 | 默认值 |
|---|---|
| 单文件 | 1 MB |
| 文件数 | 5000 |
| 快照总字节 | 64 MB |
| diff 文本 | 64 KB |

超过任一限制的文件被标记为 `untracked`，**不参与 diff**，路径收集进 `untrackedPaths`。

读失败或读期间被改动的文件进 `omittedPaths`，并把 `complete` 置为 false。

这两个集合会一路传到 `RunDiff` 里返回给调用方。**"快照可能不全"必须显式暴露，不能静默**——否则用户会以为 diff 就是全部改动。

**5. 防"拷贝期间被改"**

复制到基线目录之后，会**再算一次哈希**对比：

    if (hash !== await hashFile(baselinePath)) { complete = false; omittedPaths.push(relative); continue; }

也就是说，如果复制过程中文件被改动了，这个文件就不算有可靠基线，直接排除。这是很细但很实在的一步——没有它，diff 可能基于一个从来没存在过的内容状态。

**6. 跳过什么**

- 所有 dotfile 和 dot 目录（`entry.name.startsWith(".")`）
- `DEFAULT_IGNORED_DIRECTORIES`：`.git`、`node_modules`、`target`

这三个正是最占空间、最不需要看 diff 的目录。

二进制判定：读前 8192 字节，只要包含 `0` 字节就判为 binary。二进制文件在 diff 里只输出一行 `Binary files a/... and b/... differ`。

**7. diff 怎么生成**

`finish()` 做第二次快照 → 取前后路径并集排序 → 跳过任一侧是 untracked 的 → `sameMetadata`（哈希相同）跳过 → 剩下的调 `renderDiff()`。

最终用 `diff` 包的 `createTwoFilesPatch(\`a/${path}\`, \`b/${path}\`, before, after, "", "", { context: 3 })` 生成标准 unified diff 格式。

**8. 释放时机（三个触发点）**

| 场景 | 谁负责释放 |
|---|---|
| 一次性运行正常结束 | `finish()` 内部 `if (!reuseBaseline) await this.dispose()` |
| 异常 / 取消路径 | `Agent.run()` 的 `finally`，条件是 `ownsChangeTracker \|\| !completed` |
| REPL 会话 | 传 `reuseBaseline: true`，finish 不清理，由 `runInteractiveSession` 的 finally 显式 dispose |
| 进程被 kill -9 的残留 | `cleanupStaleBaselineDirectories()` 按 mtime > 24h 清理 |

最后那条是兜底：进程被强杀时没有任何 finally 会跑，临时目录会留在 `os.tmpdir()`。清理函数只认自己的前缀 `coding-agent-baseline-`，**不触碰其他临时目录**，而且单个目录失败不影响其他（catch 里是空注释，明确写着"清理是兜底操作"）。

**9. 复用基线时的增量提升**

`promoteBaseline()` 在 `reuseBaseline` 模式下，把当前快照"提升"为下一轮的基线：

- untracked → 原样保留
- 元数据未变 → 复用旧条目（含旧的 baselinePath）
- 变化的文本文件 → 复制到基线目录，更新 baselinePath

**只复制新增和变化的文件**，未变化的继续引用旧基线。REPL 里跑很多轮时，这个差别就是"每轮全量拷贝"和"每轮只拷改动的"。

**10. Git 基线怎么叠加**

`GitRepository` 用固定 argv 调 git：

    spawn("git", ["-c", "core.hooksPath=", "-C", root, ...args], { shell: false, windowsHide: true, ... })

三层防护：
- **`-c core.hooksPath=`** 强制清空 hooks 路径 —— 防止仓库里的恶意 hook 被执行
- **`--no-ext-diff --no-textconv`** —— 禁止外部 diff 程序和 textconv 过滤器，防止仓库配置注入执行
- **`shell: false`** —— 参数不走 shell，没有命令注入面

输出上限 256 KB，超了直接 `child.kill()` 并抛错。

状态解析用 `git status --porcelain=v1 --branch -z`。用 `-z`（NUL 分隔）而不是换行分隔，因为路径里可能包含空格和特殊字符。

**11. 区分用户改动与 Agent 改动**

这是这一条的核心价值。`GitChangeTracker` 在 run 前记一次 status，run 后记一次，然后交叉计算：

| 集合 | 算法 | 含义 |
|---|---|---|
| `userModifiedPaths` | before 有 ∩ after 有 | 运行前就改了、运行后还在改的 → **用户自己的改动** |
| `agentModifiedPaths` | diff 里有 ∩ （after 有 或 before 没有） | Agent 改过、且当前存在 → **Agent 的改动** |
| `overlappingPaths` | 上面两者交集 | **同一个文件既被用户改过又被 Agent 改过** |

`overlappingPaths` 是最有价值的一项：它明确标出"这个文件有冲突风险"，而不是笼统说"这个文件变了"。

另外 git 变更报告里还带 branch、upstream、ahead、behind，方便判断当前起点在哪。

**12. commit 也要绑定摘要**

`commitPreview(message)` 把 `status` + `message` + `diffCheck`（`git diff --check` 的输出，用于发现空白错误和冲突标记）拼起来算 sha256 摘要。

意义和沙箱那条一样：**你审批的是"这个摘要对应的这次提交"，不是"某个叫 commit 的操作"**。审批和执行之间状态变了，摘要就对不上。

commit message 还会校验不能为空、不能含 `\r` / `\n` / `\0`。

### 关键符号

| 符号 | 位置 | 说明 |
|---|---|---|
| `RunChangeTracker` | `src/agent/run-diff.ts:90` | 快照与 diff |
| `cleanupStaleBaselineDirectories` | `src/agent/run-diff.ts:48` | 残留清理 |
| `snapshotWorkspace` | `src/agent/run-diff.ts:220` | 遍历与哈希 |
| `promoteBaseline` | `src/agent/run-diff.ts:201` | 增量提升 |
| `DEFAULT_IGNORED_DIRECTORIES` | `src/agent/run-diff.ts:12` | `.git` / `node_modules` / `target` |
| `GitRepository` | `src/repository/git.ts:22` | 固定 argv 只读查询 |
| `GitChangeTracker` | `src/repository/git.ts:66` | 交叉标记 |
| `overlappingPaths` | `src/repository/git.ts:18` | 冲突风险文件 |
| `commitPreview` | `src/repository/git.ts:45` | 提交摘要绑定 |

### 追问预案

**Q：为什么要自己做快照，不给 `git diff` 就行了？**
A：因为**工作区不一定干净**。用户可能开工前就有一堆未提交改动，`git diff` 会把它们和 Agent 的改动混在一起。快照法回答的是"这次运行改了什么"，git 法回答的是"相对于最后提交改了什么"——两个不同的问题。而且工作区可能根本不是 git 仓库，快照法在非 git 目录下也能工作（走 fallback 路径）。

**Q：快照性能和项目大小什么关系？**
A：第一次是全量遍历 + 对每个文件算哈希，成本与文件数和总字节数线性相关。第二次开始因为元数据短路，只有变化的文件会重算哈希。所以**首次快照是主要成本**，可以通过忽略目录进一步降低。上限设计（1 MB / 5000 文件 / 64 MB）保证最坏情况有界。

**Q：`overlappingPaths` 有了之后做什么？**
A：当前是只报不拦——把它附在结果里，让调用方知道风险。合理的下一步是：对这些文件的写入要求二次确认，或者在最终 diff 里单独标记。

---

## 九、事实核对与风险（挂简历前必须处理）

### 1. 测试不是全绿

实测 **141 个用例，131 通过 / 10 失败**。

失败集中在 `run_command` + Windows 沙箱相关（约 #119、#121–124）和 `run_tests` 相关（约 #128、#129、#131–133）。报错是 `TypeError: Cannot read properties of undefined (reading 'mode')` 和断言类型不符（期待 `SandboxUnavailableError` / `ApprovalDeniedError`，实收 `TypeError`）。

**结论：这是未提交的重构打红的，不是环境问题**（helper 二进制已经在 `sandbox-helper/target/release/` 构建好了）。

**处理原则：简历上不要写测试数量。** 挂 GitHub 链接就必须先把红的修绿，否则"本地有未推送代码 + 红测试"是最容易被追问倒的地方。

### 2. 代码分了三层，面试官看到的不是本地这份

- `origin/main`（面试官点进去看到的）= 本地 HEAD **加** 远程 MCP 相关文件（`mcp-remote.ts` 447 行、`mcp-auth.ts` 315 行、`mcp-runtime.ts` 120 行等）
- 本地 HEAD `053b921` 是 `origin/main` 的祖先
- 当前分支 `codex/skills-foundation` **没有上游、没有推送**

意思是：简历第 5 条讲的远程 MCP 和 OAuth，**远程仓库里是有的**（这条安全）；但 skill 模块、精细网络策略、Linux `/proc` 收紧、Windows 网络过滤这些**新代码只在本地，没推**。

### 3. 唯一一条真机验收证据

`docs/compatibility-notes.md` 里记着：2026-08-29 用 `glm-5.3` 在隔离的 scratch 仓库完成了「读 `calculator.js` → patch → `run_tests` 失败 → 再 patch → `run_tests` 通过」。

**这是简历上唯一可以直接引用的"结果证据"。沙箱那部分没有对应记录**——被问"你怎么验证沙箱真的隔离了"时，目前只能说能力探测 + 单测，没有端到端攻防验证。这是可以主动承认的边界，比被问出来好。

### 4. 一个必然被问的问题：「为什么用 Rust 不用 C++」

简历正文没提语言，但 `sandbox-helper/src/main.rs` 在 GitHub 上公开，绕不过去。

**回答方向**：承认用了 Rust，然后把重点拉回机制——这一层要处理的不是"用什么语言写业务逻辑"，而是"跟操作系统要隔离能力"：Windows 上是 Job Object、WFP、AppContainer、受限令牌、目录 ACL；Linux 上是 namespace、seccomp BPF、cgroup v2、`no_new_privs`、只读根。选 Rust 是因为这些全是 `unsafe` 密集的系统调用和句柄操作，Rust 的所有权模型让句柄生命周期不容易写漏。

**更强的说法（如果你真做了）**：这一层是纯机制、不依赖生态，换成 C++ 是直译——`windows-sys` 那套对应 Win32 API 直调（`CreateJobObject` / `AssignProcessToJobObject` / `FwpmEngineOpen0` / `CreateRestrictedToken` / `CreateAppContainerProfile` / `SetNamedSecurityInfo`），`libc` 那套对应裸 syscall + `prctl` 装 seccomp BPF + 写 cgroup v2 文件。**但注意：这句话只有在真重写了之后才能说。** 现在 helper 是 Rust，简历上写 C++ 就是造假，点开仓库即穿帮。

---

## 附：7 条词条与代码的对应总表

| # | 词条核心 | 主要文件 | 必须记住的常量 |
|---|---|---|---|
| 1 | 多轮执行闭环 | `agent/agent.ts`、`agent/task-state-machine.ts` | `DEFAULT_MAX_STEPS = 8` |
| 2 | 统一模型契约与双协议 | `model/openai-compatible.ts`、`model/openai-responses.ts`、`model/transport.ts` | `maxAttempts 3` / `maxTotalMs 60_000` / `initial 250` / `max 4_000` |
| 3 | manifest 与路径边界 | `tools/tool-registry.ts`、`tools/security.ts` | `maxFileBytes 1MB` / `maxEntries 5000` |
| 4 | 沙箱与能力探测 | `tools/sandbox.ts`、`tools/sandbox-policy.ts`、`sandbox-helper/` | 握手超时 `3000` / 命令超时 `10_000` / 输出 `64KB` |
| 5 | MCP 接入 | `tools/mcp.ts`、`tools/mcp-remote.ts`、`tools/mcp-auth.ts` | PKCE `S256` / state 32 字节 |
| 6 | SQLite 与会话恢复 | `agent/sqlite-session-store.ts`、`agent/session.ts` | `SCHEMA_VERSION = 5` / 租约 `30_000` |
| 7 | 快照 diff 与 Git 基线 | `agent/run-diff.ts`、`repository/git.ts` | 快照上限 `1MB/5000/64MB` / diff `64KB` |
