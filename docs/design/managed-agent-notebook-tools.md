# Managed NotebookEdit 与后续多媒体边界

状态：2026-09-09，基于 `942af888cd` 实现 NotebookEdit 的 Runtime 迁移和完整内容修改。下述限定验收已通过；不改变普通 daemon 默认入口。完整目标仍见 [默认替换方案](managed-agent-daemon-default.md)。

## 迁移前的缺口

迁移前，Read 已通过 Runtime 执行，NotebookEdit 仍由 Gateway 构造和执行。这使同一次会话的 notebook 读取缓存落在 worker，而编辑准备在 Gateway 检查另一份缓存；简单注册另一个本地工具不能解决作用域问题。

NotebookEdit 的现有实现需要完整的 notebook 渲染读取记录，Grep 的部分读取不能替代；它保留 stable/fallback cell IDs、插入/替换/删除语义、输出清理、BOM/encoding/lineEnding、忽略规则、团队记忆 secret guard、diff 审批、修改后的完整 notebook、用户修改标记、原始提案、父历史备份和写后缓存策略。迁移必须继续使用该原生实现。

目前 Managed 文本编辑辅助函数只会把完整文件内容映射为 Write/Edit 参数。Notebook 的用户修改内容可能涉及多个单元格，不能把整份 JSON 塞进 new_source，也不能新增模型参数绕过原生验证。现有 v2 confirm 会拒绝携带 newContent 的旧引用，要求先取消排空再 prepare，这一约束保留。

## 实现设计

抽取 NotebookEdit 的纯公共声明供原生工具与 Gateway proxy 共用，保留原 schema、说明、Kind.Edit、空 AUTO classifier 与输出策略。普通和 bare 注册继续原行为；Managed 注册使用纯 proxy。Runtime 按已有原生 registry 准入 NotebookEdit，并以同一绑定 Config 视图构造，因此 Read、NotebookEdit 和父文件历史保持相同作用域。

在已有私有 v2 prepare 增加可选 content modification 元数据，包含先前 invocation 的完整引用和用户修改后的完整内容；它位于工具 input 之外，不能来自模型工具参数。旧请求省略字段保持原形状；未知字段/错误引用仍严格拒绝。Gateway 只有在展示过 edit confirmation 后才能生成此元数据，原引用必须取消并排空。新的准备继续相同 call identity，但生成不同 invocationId，摘要包含修改元数据，幂等重试不重复消费原生修改状态。

Runtime 核对修改来源正是当前 call slot 的旧引用、工具和参数，旧执行尚未派发、取消已结算，且已有 edit confirmation。随后使用该原生工具的 getModifyContext/createUpdatedParams，将 worker 保存的 originalContent 与用户新内容交给原生 NotebookEdit；立即用返回的同一参数对象构造下一 invocation，以保留 WeakMap 元数据。Gateway 不读取 notebook，不复写其解析/格式化算法，不在确认 payload 中发送 approved 标记。重新准备后仍走权限、PreToolUse、最终 guard 与执行；未发生内容变化时保留原引用，重复修改以最新确认内容为基准。

Gateway 调度器只在 NotebookEdit 的内容修改路径传递新增元数据；现有 Write/Edit 的公开参数和改参行为保留。沿原 prepare 通道贯穿 managed binding、provider、HTTP v2、Bridge 和 ACP dispatcher；每层都需设置并消费新增字段，不能出现只声明不转发的开关。修改后的物理结果、diff、用户修改说明与备份继续走原结果/历史协议。直接更新 cell 参数的 updatedInput 仍使用原取消再准备路径。

取消与释放沿既有 invocation 生命周期等待所有准备、备份及写入结束，不以 Promise race 提前宣告资源释放。真实基线已复现读取或备份期间取消后仍写入，因此原生 NotebookEdit 在执行入口、准备完成后、最终读取检查后且写入之前检查取消；等待中的文件操作仍须真正结束。写入已经完成则继续生成原生成功结果，不在写入后的等待返回处改判取消。不得以临时禁用历史、先读缓存伪造或忽略审批通过验收。

真实基线还发现 Session release 会提前中止客户端等待 execute 回执的 HTTP，而 worker 实际仍在排空。Remote provider 保留 release 后拒绝新 execute/prepare 的准入检查，但已接纳的 v2 execute 响应等待不再受 Session release controller 中止；provider 终止和请求超时仍有效。status/cancel/history 继续原 drain 规则，v1 不变，不允许用放开新执行准入的方式修复回执丢失。

## 验证计划

在独立 HOME、QWEN_HOME、runtime、workspace 和本地模型夹具下验证。先运行全局 qwen 入口 dry-run，再记录现有完整 host 的 Read→NotebookEdit 缓存分离基线。修改后验证正式模型 final、原生 Runtime 执行、零 Gateway 本地构造/执行与终结释放。

覆盖原生声明一致、普通 NotebookEdit 回归、完整读取要求、Read/Grep/父子缓存隔离、三种 cell 操作、旧 cell ID、文件漂移、审批拒绝与批准、修改完整 notebook 后重新审批、空/无效修改内容、错误来源引用/重复准备/执行后修改拒绝、真实 worktree 子任务和父历史备份。复核所有新增参数的实际消费者，并运行 build/bundle/typecheck、相关包定向测试、隔离 E2E、两次自审和代码复审。当前独立 Agent 因账户额度不可用时使用主任务执行并注明手工复审，不能称为独立审查通过。

## 多媒体后续工作

ZoomImage 在 worker 中解码和裁剪，但使用 Gateway 解析后的有效模型输入能力；不能由无模型的 Tool-only Config 猜测。DisplayImage 同时依赖主/子 Agent 作用域与用户终端能力，需保留原 fork 执行禁止及客户端展示语义。Read 内已有 PDF/image Vision Bridge 模型调用，默认替换之前必须把模型侧留在 Gateway、解码和文件访问留在 Runtime。此调查不将文本 Read 的成功扩大为多媒体已经兼容，也不通过删除现有工具完成默认替换。

## 本阶段验证结果

全局 `qwen 0.22.3 --version/--help` 在隔离 HOME 中通过，属于安装入口基线。原完整 host 的三次模型请求复现 Read 在 Runtime 成功、NotebookEdit 在 Gateway 缺少完整读取记录而失败；文件保持原样。修复后，同样的真实 host/Bridge/HTTP/worker 完成 Read、NotebookEdit 和正式最终回复，Gateway 无原生 NotebookEdit 构造或执行。

随后经同一真实私有客户端验证两轮整本内容修改，保留原 cell 参数，更新另一个用户新增单元格；每轮取消并排空旧引用，再生成新 invocationId，相同修改重试返回相同准备结果。重新审批之前文件不变，旧确认被拒绝，最终保存内容与用户提案一致并返回原生用户修改说明。父 Session 的实体备份仍保留最初 notebook 内容。此修改组是完整 host 之后的可信私有客户端调用，不能当作 Web Shell 的编辑器交互已端到端验收；Core 调度器交互由定向测试覆盖。

本阶段去重通过 Core 604 项、CLI 80 项、Bridge 5 项，共 689 项测试，含 32 项原生 NotebookEdit 回归、完整 422 项 CoreToolScheduler 回归、10 项新 Runtime/proxy 测试。根 build/bundle/typecheck、lint 通过。所有隔离 cohort 均在继续编辑/构建前退出并清理；失败记录保留。初次测试中的同步抛错断言和类型夹具已修正。首次额外 wire 探针在重复修改中执行失效引用，触发既有 provider retiring；将这项破坏性检查放在最后后通过，未修改生产保护语义。

尚未将 notebook 的所有故障/平台组合分别重跑为真实 host E2E；原生三种 cell 操作及格式规则由现有回归提供证据。下述专项取消时序已复验，额外 worktree/故障组合及用户端编辑器仍需继续验证。普通默认入口、全客户端和多媒体均未由本阶段验收。

### 2026-09-09 取消与执行回执复验

基于 `291a4750e4` 的实际 worker 基线复现了两个问题：读取/备份期间取消后仍写入；写入完成但原生方法尚未返回时关闭会话，客户端提前报 Session released，丢失真实成功回执。修复后，在相同隔离完整 host/Bridge/HTTP/ACP worker 中完成三组受控延迟验收：read、backup 期间取消均保留原文件字节并返回 cancelled；written 期间取消并关闭 Session，execute 和 close 在延迟屏障处均未结束，恢复后依次取得原生成功、客户端成功及终结 release 确认。每组先完成模型驱动的 Read→NotebookEdit→正式 final，再经可信私有客户端执行取消场景；此结果不等于用户界面 Cancel turn 已端到端验收。

三组共 9 次本地模型请求，56 个构建产物摘要在组内、组间及最终回读一致；无超时、备用强杀、残留进程或监听端口，临时根全部删除。去重 Core 103 项、CLI 48 项共 151 项定向测试通过，包含已取消的原生入口、最终 freshness check 中取消、真实文件操作等待、保留已写成功结果，以及 release 后新 execute/prepare 拒绝而已接纳 execute 回执保留。完整 build/bundle/typecheck、变更文件 lint/格式、两轮自审及独立源码审查通过。首次构建的测试包装器返回类型已修正；失败基线与错误记录均保留。当前 4170 仍由原进程监听，未访问、重启或修改用户数据。
