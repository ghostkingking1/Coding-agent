# Coding Agent 简历词条(7 条写入版)

> 依据《王宏斌-岗位待定-哈尔滨理工大学-计算机科学与技术专业.pdf》的项目版式整理。
> 7 条,与简历现有 Coding Agent 条目数量一致,可整块替换「项目介绍 + 主要工作」。

---

## 一、写入版(直接粘贴)

Coding Agent |2026.08 – 至今　　　　GitHub地址:https://github.com/ghostkingking1/Coding-agent

项目介绍:基于 TypeScript 从零实现的本地 Coding Agent,对标 Claude Code / Codex CLI,运行时依赖仅 diff 与 zod;把安全边界下沉到独立沙箱进程,让模型在受控工作区内自主改代码、跑命令

技术栈:TypeScript、Node.js、SQLite、Zod、MCP

主要工作:

1. **核心执行闭环与任务状态机**:实现多轮执行循环与任务状态机:步数上限兜底失控成本,取消信号全链路穿透、随时可中断;每轮落检查点,中断后凭幂等键续跑、不重复执行;文件写入强制转入验证态,无验证证据不许收尾
2. **精细化上下文预算管控**:落地四阶段上下文降级(工具输出截断、冗余清理、旧轮次摘要、工具批次折叠),摘要按源消息哈希缓存,同一前缀不重复摘要;超大工具输出落盘会话隔离目录,上下文仅携带引用与预览,大输出不再挤占窗口;token 以启发式预估算、真实返回校准修正
3. **统一模型接入层与智能路由**:构建统一模型客户端契约,兼容 Chat Completions 与 Responses 双协议、更换供应商不改上层;网络、限流等瞬时错误指数退避重试,认证与协议类错误快速终止;按上下文占比、失败率、风险关键词等打分路由,简单任务不占强模型配额,决策与原因写入审计
4. **工具权限体系与沙箱隔离**:工具前置声明读/写/执行/联网能力与入参结构,未声明不对模型暴露;入参统一校验,拦截路径穿越与符号链接逃逸,文本修改经 diff 预览审批后写入;七档风险分级的独立沙箱进程承载不可信命令,以 Job Object 管控进程树与资源、WFP 过滤网络、受限令牌与 AppContainer 收窄权限,限制工作目录、环境变量与超时;审批摘要与能力快照哈希绑定,探测不通过即不降级裸跑
5. **外部工具纳管与出网管控**:接入宿主 MCP 客户端纳管本地与远程外部工具,接入与调用沿用统一审批框架,启动参数只由宿主配置、模型不可传入;远程授权采用带 PKCE 的 OAuth 2.0,凭据存用户目录、不落工作区;出网默认关闭,开启后经受控代理按主机与端口过滤,拒绝的外联原因可追溯
6. **SKILL.md 技能体系**:实现技能发现、匹配、使用与沉淀闭环——扫描用户与仓库双来源技能目录,元数据校验筛出有效技能;触发词加权打分匹配并给出命中理由,模型经只读工具按需读取、限额注入;验证通过的运行可沉淀为新技能,提取脱敏最小证据生成草稿,审批后写入且不可覆盖已有技能
7. **工作区版本化与可观测审计**:实现工作区快照与任务级差异管理,流式哈希只对变化文件计算差异,精确回答「本次运行改了什么」且不覆盖用户已有修改;支持工作区原子回滚到任意检查点;SQLite 持久化会话与运行断点,审计表只追加、不落敏感信息

---

## 二、面试备忘(按条,含从简历下沉的细节)

- 第 1 条:六态具体为 接收/执行/验证/修复/完成/阻塞(`src/agent/task-state-machine.ts`);工具失败转错误消息继续跑、模型失败直接终止的不对称取舍;取消信号在循环开头/模型请求/工具上下文/退避等待四处生效(`src/agent/agent.ts:117,130,320,199`);工具批次并行调度、写操作按冲突键串行(同批并发上限默认 4,`executeToolBatch`);检查点粒度是批次边界,批次中间取消会重放批次,写工具以 patch 冲突形式暴露给模型修正
- 第 2 条:四阶段完整名称为工具输出头尾截断、冗余内容清理、旧轮次摘要、连续工具批次折叠;落盘输出支持按偏移分页回读;token 低估即时上调、高估缓慢回落的双向修正语义;压缩是非破坏式的:原始 transcript 只增不减,模型视图每轮从全量消息重算(`context-manager.ts:57-92`),摘要只存在于视图;摘要缓存:超预算时每轮的丢弃集高度重叠,以源消息前缀哈希为键(内存缓存 `context-manager.ts:18,126`,持久化字段 `context_checkpoints.source_prefix_hash`)命中即跳过摘要模型调用,并避免非确定性摘要导致压缩视图逐轮漂移;断点恢复时靠哈希证明磁盘上的摘要仍对应这批消息,不用重摘。为什么不做成破坏式(直接用摘要替换旧消息):Session 恢复/审计/检查点需要全量原始记录,且预算或策略调整后同一份 transcript 可重算更优视图
- 第 3 条:支持流式输出与并行工具调用;流式工具调用参数分片按 index 聚合;打分完整维度为上下文占比/轮数/工具调用量/失败率/风险关键词;重试优先用响应头 retryAfterMs 再指数退避
- 第 4 条:参数校验先于审批(防脏参数触发预览副作用);副作用发生前拦截;隐藏路径默认拒绝;`modelInputSchema` 未声明不对模型暴露(`src/tools/tool-registry.ts:48`);沙箱独立成进程的原因(OS 隔离能力与主进程爆炸半径);七档 = R0–R6(`src/tools/sandbox-policy.ts:7`),按风险推导最小能力集;Windows 机制实证 `sandbox-helper/src/main.rs`(1814 行):Job Object(`CreateJobObjectW`/`AssignProcessToJobObject`)、受限令牌(`CreateRestrictedToken`)、AppContainer(每次执行独立身份)、WFP 动态会话(`FwpmEngineOpen0`,BFE 原子清理、崩溃不留规则);helper 启动时动态探测 OS 能力并自报,某机制不可用就不上报对应能力;被问「只支持 Windows?」:Linux 侧也实现了(unshare namespace、seccomp BPF、cgroup v2、no_new_privs、只读根),简历聚焦实际验证过的主力环境;被问语言:helper 是 Rust,答「这层核心是 OS 机制而非语言,独立进程负责直接调系统接口」;被问「CC/Codex 也这样审批吗」:两家默认安全档同为 diff+确认(CC default 每编辑确认、acceptEdits 才自动;Codex 只读档确认、写档位直接应用),差异在它们有会话级档位预授权,本项目当前恒严(写必审),审批策略经 confirm 回调可插拔,档位是可加的 UX 层,默认取严是 fail-closed 刻意选择,审批疲劳由「只读自动放行」缓解;审批摘要 = SHA-256(规范化执行请求 + 推导沙箱策略 + 能力快照),实现见 `sandbox.ts:227,242`、`sandbox-policy.ts:102,113`;防两类攻击:TOCTOU 审批后偷换请求、能力静默降级(批准时 WFP 装得上、执行时装不上);executionId 不参与摘要(无语义的流水号),保证同一请求预览/执行摘要必然一致
- 第 5 条:本地 MCP 走 stdio;「统一审批框架」指 MCP 工具注册进同一 ToolRegistry、自动继承同一 SecurityPolicy,并非第二套审批;bootstrap 审批拒绝即不接入(`src/tools/mcp-runtime.ts:68`);OAuth 并发刷新去重;远程返回内容一律按不可信 tool result 处理、不提升为 system prompt;出网管控双层:WFP 只放回环(内核层强制「绕不开代理」,`main.rs:267` loopback_guard)+ 本机受控代理按 allowlist 做 host:port 过滤与 allow/deny 留痕(`network-proxy.ts` NetworkProxyEvent),代理地址经执行请求注入(`main.rs:21-26`);默认 network.off,开启网络风险分级即 R5(`sandbox-policy.ts:37`);一句话:过滤在用户态代理,强制在内核 WFP,两层缺一不可
- 第 6 条:简历只写技能体系,AGENTS.md 治理表述已删,以下作面试储备。技能事实已核实:双来源 `SkillSource = repository | user`(`src/skill/types.ts:3`)、触发词与打分字段(`types.ts:9,35`)、Zod 元数据校验、单资源限额 128KB(`catalog.ts:25`);触发词打分是程序侧选择(可审计、注入量可控),CC 的 Agent Skills 是模型读描述自主触发,无代码侧匹配;技能闭环四段:发现(双来源扫描+Zod 校验,不合格标 invalid)、匹配(加权打分 name×6/trigger×4/tag×3/description×2,top-8 带 reasons)、使用(list_skills/read_skill 只读工具,内容≤32k 字符带 untrusted 警示)、沉淀(仅 completed+验证通过的 run 可生成草稿,只提取脱敏后的目标/工具名/文件模式、不存 transcript;write_skill 无 modelInputSchema 模型不可见、审批写入、wx 标志不可覆盖);打分时机:每用户请求仅一次(`cli.ts:50` formatSkillContext 把候选注入「Skill candidates」块,工具执行与模型轮次不打分),/skill use 显式选定旁路打分(score 100);成本:描述符常驻内存,≤128 技能×4 字段集合比对,微秒级;已知取舍:tokenize 按非文字字符切分,中文连续短语成单 token 与触发词全等比较,中文触发词命中弱,改进方向子串/n-gram 匹配。「不可覆盖」双层实现:应用层 stat 预检抛 already exists + OS 层 wx(O_EXCL)排他创建兜底;设计动机:技能是模型消费的内容,允许覆盖=技能库可被静默替换成持久化注入载体,故工具路径只增不改,与审计表 append-only 同哲学;技能修订靠人工直接编辑文件储备(被主动问到说明文件安全时再用):分层加载+就近优先与 CC/Codex 同构;不可信治理与符号链接拦截是两家都没有的加固——CC/Codex 把 CLAUDE.md/AGENTS.md 当可信指令注入,投毒说明文件是其公认注入面,本设计立场「内容可引导行为,权限边界在代码里」;Codex 社区 symlink 工作区加载错乱是已知坑;被问「CC 为什么不标记不可信」:说明文件用途就是指挥 agent,治理目标是内容改变不了权限边界而非不信内容
- 第 7 条:任务级 diff(`run-diff.ts`)与检查点回滚(`workspace-checkpoint.ts`)是两个独立机制。diff:双快照+基线落盘(内存只存元索引)、流式哈希(64KB 分块)、两道短路(size+mtime 复用条目、哈希相同跳过)、完整性三防线(超限标 untracked/拷贝后重哈希/前后两次 stat)且 complete/omittedPaths 显式暴露、REPL 增量 promoteBaseline、24h 兜底清理。回滚:内容寻址对象库(sha256 去重,checkpointId=内容哈希)、两档(known_good 须验证 passed,partial 不可回滚)、staging 演练(恢复到隔离目录+全量校验+重跑测试才落盘)、journal 可恢复事务(备份+journal+失败按 journal 回滚+崩溃后 recoverInterruptedRollback)、工作区租约、symlink 父链拒绝;回滚不依赖归属分类;审计:「audit_events」白名单列结构(会话/运行/序号/事件类型/步骤/工具/状态/错误码/元数据),表结构上没有 prompt、模型响应、API 密钥列——不落敏感信息靠 schema 而非写入时过滤;API 只有 record 与 list,无 update/delete;错误信息截断 1024 字符;「写操作强制测试」已并入第 1 条状态机验证态口径,第 7 条不再重复,被问测试门禁时用第 1 条答(写入→verifying→无验证证据不许 completed);行业对比:CC 2.0 自动 checkpoint+/rewind(每次 Claude 编辑前存档,仅覆盖 Claude 自己的编辑、不含 bash 副作用,保留 30 天)证明 agent 需要自有撤销机制;被问「git 不就够了吗」:git diff 答「相对上次提交改了什么」,任务级快照答「本次运行改了什么」——脏工作区直接跑是常态,按 git 撤 agent 改动会连用户未提交工作一起删;非 git 目录也能用;归属区分/冲突标记(overlappingPaths)已从简历删除——回滚只依赖基线快照,不依赖归属分类,该信息仅是补充风险信号,作为面试储备(被问「你和用户同时改一个文件怎么办」时再讲)
- 行业对比(第 2 条被问「CC/Codex 怎么做的」时用):Codex 一次性 handoff 摘要物理替换全历史(用户消息保留、无摘要缓存);Claude Code 三层渐进(旧工具结果清占位符→保持前缀稳定命中 Prompt Cache→LLM 九段结构化摘要+自动重读文件);共同哲学是「便宜的先来」,与四阶段降级同构。独有差异:大输出落盘可分页回读(CC 清空/Codex 砍掉,不可恢复)、前缀哈希摘要缓存(仅非破坏式每轮重算的架构才需要)。主动认的差距:前缀稳定性对 Prompt Cache 不友好(CC 有设计)、压缩后无自动状态重建(CC 自动重读 5 个文件)

---

## 三、可选项

- 项目介绍里的「对标 Claude Code / Codex CLI」如果不想点明参照物,删掉即可,不影响其余内容。
- 技术栈可补齐与新条目呼应的关键词:`TypeScript、Node.js、SQLite、Zod、diff、MCP、OAuth`。
