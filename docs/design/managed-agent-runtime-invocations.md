# Managed Agent：Runtime invocation v2

状态更新：2026-09-10，源码复核基线 `a836081466`。阶段 1 的本地 macOS 验收与阶段 2 已记录的 Core/ACP 调度、独立子作用域、父文件历史结果保留；当前注册九种工具代理（Read/Write/Edit/Shell、Glob/可选 LS、Grep、NotebookEdit、Zoom），各自证据见[总方案能力表](managed-agent-daemon-default.md)及专项文档，不能将注册等同全部语义验收。四处普通默认入口与共同兼容 selector 尚未接线；当前先实施[首阶段计划](../plans/2026-09-09-managed-daemon-default.md)，MCP/Hooks/Channels 迁移及完整初始化/媒体/后台/历史能力后置。下文按切片保留当时结果，“四类工具”等指历史注册切片，不是当前总能力清单。

目标是让普通 daemon 复用完整 Agent，由 Harness 推进模型、Session 服务持有会话权威状态，独立 Tool-only Runtime 执行工作区工具。保留现有权限、调度、客户端事件和结果语义；不能用只读工具集作为最终替换验收。

## 责任边界

| Session 服务与控制层                                                                  | Harness                                                                 | 独立 Runtime worker                                                    |
| ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| 输入、正式历史、领域决策、等待/终态与恢复依据；coordinator 管 activation 与原 binding | 完整模型循环、工具编排、L4/L5 权限交互和最终授权请求                    | 原生 build、参数规范化、工具固有权限 L3、确认数据与真实 onConfirm      |
| Goal/Todo/问答领域提交、父子血缘及结算引用                                            | task/subagent、Goal/计划、ask-user、结构化输出、ToolSearch 的模型侧编排 | 文件/Shell/Git/worktree、文件检查点、子进程；MCP/Hook 按原后置范围迁移 |
| 正式结果与受控资源持久引用、客户端投影                                                | 模型输出转换、图片模型处理、客户端能力适配                              | 原始工具输出、进度、产物与受控资源读取                                 |

Skill 文件和脚本在 Runtime，模型展开及模型覆盖在 Harness；TaskStop 区分 Agent 与后台 Shell 的 owner。不能仅按工具 Kind 决定归属。Session/Prompt Hook 的工作区脚本也须按作用域迁移，模型决策仍在 Harness；只迁移 Pre/PostToolUse 不构成完整 Hook 兼容，首阶段不新增完整 Hook/MCP 接入。

本表是目标责任，尚未完成独立 Session/Harness 拆分。下文历史切片中的 Gateway 指当时合并承载状态和模型的 host，不是未来模型与历史的共同权威。普通接入及可恢复 Harness 采用[Harness 契约](managed-agent-harness.md)、[私有控制协议](managed-agent-control-protocol.md)和[coordinator](managed-agent-coordinator.md)：原 v2 payload 保持兼容，activation 门禁须覆盖所有副作用入口；恢复使用原 invocation，detach 不 terminal release。当前 Map 幂等不证明跨 worker 重启恢复。

## 已验证的实际入口

下表行号来自阶段 1 开始时的代码基线 `824e92d84f41fc9ab19d1130385b491a8f37c466`，后续实现会移动行号；审查当前实现应按符号定位。

| 源码锚点                                                                                                                                       | 当前约束与改动位置                                                                                                            |
| ---------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| [Config.createToolRegistry](../../packages/core/src/config/config.ts#L9078)                                                                    | 两处执行器共用 DeclarativeTool 注册表；在此替换工作区工具工厂，不能先本地 build 再替换 execute。                              |
| [ToolInvocation](../../packages/core/src/tools/tools.ts#L20)                                                                                   | DeclarativeTool.build 产生 invocation，再调用 getDefaultPermission、getConfirmationDetails、execute；确认回调不能直接序列化。 |
| [CoreToolScheduler](../../packages/core/src/core/coreToolScheduler.ts#L2078)                                                                   | build 后进入权限/确认；setArgsInternal（1749）会重建 invocation，执行前 guard 在 4648，execute 在 4853。                      |
| [Session.runTool](../../packages/cli/src/acp-integration/session/Session.ts#L10989)                                                            | 独立的完整执行路径：build（11380）、权限（11439）、确认（12158）、guard（12344）、execute（12505），必须同时接线。            |
| [现有 Runtime 执行](../../packages/cli/src/acp-integration/acpAgent.ts#L11698)                                                                 | 当前 manifest（845）限制只读，execute（11791）复用完整非交互调度器；不能直接作为 v2 的执行内核。                              |
| [非交互执行器](../../packages/core/src/core/nonInteractiveToolExecutor.ts#L30)                                                                 | 会再次运行 CoreToolScheduler；非交互 ask 被拒绝，且其结果处理可能调用图片模型。                                               |
| [ToolResult](../../packages/core/src/tools/tools.ts#L486) / [v1 返回值](../../packages/acp-bridge/src/bridgeTypes.ts#L127)                     | v1 responseParts/status/error 不能完整表达原始 ToolResult、产物和输出文件。                                                   |
| [Config 初始化](../../packages/core/src/config/config.ts#L3038) / [子 Agent 配置](../../packages/core/src/subagents/subagent-manager.ts#L1024) | 初始化及派生 Config 会建立本地服务/重建注册表；远端工具边界必须由真实 host producer 传入并继承。                              |

文件校验和确认本身已有工作区访问，例如 [ReadFile 参数校验](../../packages/core/src/tools/read-file.ts#L573) 和 [Edit 确认/diff](../../packages/core/src/tools/edit.ts#L408)。因此远端边界从真实 build 开始。

## v2 最小协议

沿用现有私有传输与 worker lease，不新增产品配置或通用授权框架。现有会话 `/prepare` 仍表示会话准备；以下 `prepareInvocation` 专指一次工具调用。通过独立 v2 方法/路由与能力协商扩展，v1 路由、严格请求字段及只读语义保持兼容；v2 能力不足时明确失败，写入/确认不得降级到 v1。

所有操作由服务器已解析的 tenant、workspaceId、canonical cwd、sessionId、worker generation/lease epoch 绑定，再校验 promptId、callId、capabilityDigest、policyRevision；不得从模型参数或任意客户端字段接受执行授权。固定 URL 模式继续使用原有认证，不伪造 owned-worker lease；两种模式都需要 v2 调用身份绑定。

| 操作                          | 最小语义                                                                                                                                                  |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| manifest                      | 返回工具声明、displayName、kind、permissionAliases、MCP server/tool 身份、defer/search 元数据及输出策略；所有影响权限/执行的元数据纳入 capabilityDigest。 |
| prepareInvocation             | Runtime 真实 build，返回随机 invocationId、normalizedArgs、argsDigest、描述/位置、L3、交互要求和分类器所需数据；此时不 execute。                          |
| getConfirmation               | 按 invocationId/digest 返回现有确认 union 的可序列化 DTO；真实回调留在 Runtime。                                                                          |
| confirmInvocation             | 校验绑定并调用真实 onConfirm；传递 outcome 及现有 payload，不能顺带 execute。取消释放尚未执行的 invocation。                                              |
| preflightInvocation           | 权限完成后，在原 PreToolUse 位置执行 Runtime Hook；保存 toolUseId/结果，返回 allow/ask/deny/stop。先于 Gateway 最终 guard，ask 重入不重复触发。           |
| executeInvocation             | 接受同一调用的 Gateway 执行授权，检查已完成 preflight、lease、版本、参数摘要及状态，只启动一次；重复请求返回同一次执行状态/结果。                         |
| cancelInvocation              | 返回 cancelRequested/当前状态；取消 ACK 不表示执行已结束。                                                                                                |
| watch/getResult、readResource | 按 invocationId 读取有序进度、终态及产物；断线后继续同一调用，不创建新调用重试执行。                                                                      |

准备记录保存规范化参数及真实 invocation，绑定上述身份与摘要；已准备记录在取消、到期、会话关闭或 generation 失效时释放。有效状态为 prepared → authorized → executing → settled；另有执行前 cancelled/not_started、needs_reprepare/needs_confirmation 和非终态 cancel_requested。过期的会话、lease、manifest 或授权必须拒绝。

授权只证明 Gateway 对该 invocation/digest 已完成现有权限与执行前 guard，使用现有认证私有通道传递即可，不引入签名体系。自动允许不会调用 onConfirm，因此授权不能等同于 confirmInvocation 成功；两处执行器按 Runtime preflight → Gateway 原 guard → 授权/执行的顺序接线，只调用一次既有 Bridge/provider 策略链。Tool-only worker 没有 Gateway 的活跃模型 Prompt，不能把它自身 Bridge 的反向 guard 当成 Gateway guard；v2 Runtime 不重复安装同一个 managed guard，仍检查执行身份、lease 和摘要。未授权的代理 buildAndExecute 必须失败。

## 注册表与两处调度器接线

1. Gateway host 按 workspace generation 创建远端工具注册表，注册 RuntimeBackedTool；proxy build 只做纯参数结构处理，不构造本地工作区工具。模型侧工具显式保留，子 Agent 派生 Config/重建注册表继承相同边界，额外 MCP 配置交给 Runtime 发现。
2. 给 ToolInvocation 增加可选异步 `prepare(signal, { callId, promptId })` 或等价窄接口；CoreToolScheduler 和 Session.runTool 在 build 后、读取有效参数/描述/位置/权限之前 await。旧工具行为不变，Session 补齐 promptId 传递；不能把网络准备偷偷放进无 AbortSignal 的 getDefaultPermission。
3. Gateway 用远端 L3/确认 DTO 继续现有 PermissionManager、交互确认、权限持久化和 guard。Runtime onConfirm 的必要效果按现有 outcome 显式同步，例如 ProceedAlways 对审批模式的影响；不提供任意远端 Config 修改能力。
4. Core 的 setArgsInternal、编辑器修改、权限 Hook updatedInput，以及 Session 的直接参数更新，都使旧 invocation/digest/授权失效并重新 prepare。编辑器可操作建议内容缓冲区，真实文件读取/diff 由 Runtime 完成，不能复用 Gateway 本地 EditTool 文件访问。
5. 保留当前 Hook 时序。现有 PreToolUse 返回 allow/ask/deny/stop 及上下文，不支持 updatedInput；参数重写来自 PermissionRequest Hook，按上一项重新 prepare/授权。PreToolUse 要求 ask 时，Runtime 返回 needs_confirmation 并保留 toolUseId，由 Gateway 按调用者现有策略处理：Core 以同一 callId 进入确认后继续，不能重复触发该 PreToolUse；Session 当前仍把 ask 视为阻断，不在本次迁移中悄悄改成自动允许或新增交互。迁移不额外新增 PreToolUse 改参能力，也不能为省一次 RPC 提前执行 Hook。
6. 从当前执行器抽取窄的“已准备 invocation 执行阶段”，包含 Runtime preflight/工具 Hook、执行绑定校验、execute 和进度；不把整个非交互 CoreToolScheduler 放回 Runtime。文件检查点保留真实 Edit/Write execute 内部的 FileHistoryService.trackEdit，并把 Session 的 turn makeSnapshot 接入 Runtime；不在内核外额外重复记一次 edit。Gateway 不重复运行这些 Hook，也不在 proxy 内调用本地 invocation.execute。

Gateway 既有 built-in guard 仍含本地文件检查，完整迁移需把这些检查放到 Runtime 并以绑定当前调用的结果接回原策略链，不能两端重复运行整个 guard，也不能在默认验收中豁免这些本地访问。

MCP 当前存在 `instanceof DiscoveredMCPTool` 消费者；proxy 需要可验证的 MCP 元数据/窄判定辅助，保留权限分类、显示、发现与输出行为，不能通过在 Gateway 构造 MCP client 满足类型分支。

## 输出、取消与资源生命周期

v2 返回独立 executionStatus（not_started/success/error/cancelled）及原始 ToolResult 投影：llmContent、returnDisplay、error、resultFilePaths、artifacts、persistedOutputFiles 和必要 Hook 上下文。字段按现有 union 校验，不传函数。Gateway 只包装一次 functionResponse，保留模型图片处理及规范历史记录；两处调度器不能因为调用过 proxy.execute 就把远端 not_started 误记成执行失败。

文件 diff、ANSI/Shell/MCP 进度、MCP App、终端图片等显示类型需要各自 DTO。工作区工具不得任意返回模型控制字段；Skill 的 modelOverride/终止语义按上述职责拆分。大输出遵守一次截断和现有预算，不能把截断后的字符串冒充完整产物。

Runtime 绝对路径不是 Gateway 本地路径。产物使用绑定当前 invocation 的资源标识及 MIME/size/digest，经授权读取并落入 Gateway 持久化存储后才能释放唯一副本；资源读取限制在该调用登记的输出中。后台 Shell 拥有独立活动占用及停止入口，prompt 完成不代表 worker 空闲。

进度使用单调 seq，支持重连/终态查询并标识缺口，终态只提交一次。取消继续沿真实 AbortSignal/子进程取消链传递；结果不确定时保留占用并按 generation 生命周期进入 retiring，禁止新 use，已有其他 use 可完成。只有执行终态或确认 worker 进程树退出才能释放不确定占用。丢失执行响应不得自动重新执行可能产生副作用的调用。

## 初始化与生产接入约束

Gateway Config 不能只设置 skipMcpDiscovery/skipHooks/skipSkillManager/skipFileCheckpointing 后仍初始化本地工具。需要在已有 host profile 下避免 FileService、extensions.refreshCache、ripgrep 探测、warmAll、过期 Agent worktree 清理及本地 MCP 文件读取；对应功能由 Runtime 接管，不能静默删去。目标 Harness 保留模型鉴权，通过 Session client 提交会话历史，Session authority 持有物理 writer；不允许 LocalManagedRuntimeProvider 退回 Harness 注册表执行。

配置由已解析 workspace/generation、信任状态及显式环境快照产生。Runtime 自行加载该工作区获准的工具配置；Gateway 不读其他 workspace 的 .env/MCP/Skill 文件补缺。信任撤销、配置 revision 变化及关闭应先封住新调用，再按现有 generation drain 规则取消/回收。普通 create/prompt 必须通过真实 Bridge/ChannelFactory 使用此注册表，接口单测或未被生产调用的 host option 不算接入完成。

## 分阶段实现与退出条件

| 阶段                      | 必须可验证的退出条件                                                                                                                                                                           |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. v2 协议与 Runtime 内核 | 独立 worker 完成真实 read/write/Shell 的 build、确认和执行；prepare 不写目标文件；错误 tenant/session/lease/digest 被拒绝；同 id execute 不重复产生副作用；v1 回归通过。                       |
| 2. 注册表及两处执行器     | 真实内存 ACP 使用完整 Agent，正常读写与 Shell 批准/拒绝均通过代理；Core 调度路径及子 Agent 工具同样接入；观测证明 Gateway 不 build/execute 工作区工具。                                        |
| 3. 完整语义               | 实测批准后改参重新确认、Hook 恰好一次、编辑 diff、MCP/Skill、图片/大输出/产物、后台 Shell 停止；两处执行器保留 not_started、取消及客户端显示语义。                                             |
| 4. 普通 daemon 接入       | 真实普通 create/prompt 经过 Bridge → 完整 Gateway Agent → 独立 Runtime；跨 workspace 隔离、撤销信任、配置轮换、断线重连、worker 死亡和 shutdown await 均验证，持久化产物在 worker 回收后可读。 |

每阶段补充对应源码测试及真实进程验收；阶段 1–3 不宣称普通 daemon 默认替换完成。第 4 阶段还需原有消费者回归，模型只在 Gateway、工作区副作用只在 Runtime 的观测证据作为最终退出条件。

实现前需按现有确认/显示 union 列全序列化字段，并核对全部 MCP 类型判定消费者；这些是协议实现清单，不增加产品配置。具体路由命名及内部授权接口随最小接线确定，以上身份、参数摘要、单次执行和结果语义不可省略。

2026-09-09 阶段 1 实现前的基线使用隔离的真实 worker/ACP 进程验证：当时只声明 v1，已有 v1 路径拒绝 protocolVersion 2 及额外 invocation 字段，真实 read 成功，manifest 不包含 write/Shell，错误 lease/epoch/tenant 被拒绝。重复 release 曾返回 500，另一轮返回 released:true；不据此声明响应幂等或资源清理语义已达到 v2 要求。当时 v2 准备、确认、执行及结果查询尚未实现，此基线不是阶段 1 验收通过。

## 阶段 2 调度接线细化（实施中）

两处调度器通过 invocation 上的可选 `managed` 生命周期准备和取消远端调用。准备必须发生在向 UI 发布 invocation 之前；准备结果中的规范化参数、描述、L3、确认及稳定 toolUseId 属于同一引用。现有本地工具保持同步 build。Gateway 完成原权限流程、Runtime preflight 和最终 guard 后，显式授权代理执行；绕过调度器直接 buildAndExecute 没有授权，必须失败。

所有改参入口先等待旧引用取消排空，再准备新引用并重做权限；不能把 newContent 或 updatedInput 送入旧确认回调。执行前拒绝、确认取消、超时和全局取消均等待远端终态，批次完成不能先释放引用。运行结果保留物理 executionStatus；Runtime 的 Pre/Post/Failure Hook 回执在原位置消费，Gateway 不重跑这些工具 Hook。PermissionRequest 目前仍属于 Gateway 权限流程，其工作区执行迁移尚未完成，不能通过关闭 Hook 冒充兼容。

完整生产接入仍有明确前置条件：注册表声明必须在不等待 Runtime 启动的情况下可用；不能为拿 schema 构造本地工作区工具。历史 AUTO 分类投影需要复用原工具的纯函数。父子 Agent 的执行作用域必须由真实 Config producer 分配；当前 FileHistoryService.trackEdit 写入最近快照，直接放开多个 prompt 并发会把编辑归错轮次，因此不能仅删除 Runtime 单轮限制。不同工作目录必须绑定对应 Runtime。以上生产边界、Session/子 Agent 验收及普通入口切换完成前，不宣称阶段 2 或默认替换通过。

当前实施已新增纯 `RuntimeBackedTool`，注册时接收可信声明和分类器纯投影。代理自身在第一次工具准备时取得 Runtime client；已有文件历史的父 checkpoint 可以先行获取 client。代理不调用本地工作区工具的 build/execute。manifest 的输出预算、defer/search 元数据纳入摘要，Infinity 使用可序列化的 unlimited 表示；prepare 返回稳定 toolUseId。Core 与 Session 在原权限和最终 guard 流程中实际读取 managed 生命周期，Session 的工具展示直接接收已准备描述/位置，不再另行 build。Edit/Write 的用户编辑参数转换复用同一纯函数，编辑器只操作确认 DTO 中的内容缓冲。

断线处理包含两种尚未得到引用的情况：beginTurn 响应丢失时，清理幂等等待同轮快照结束；prepare 响应丢失时，重取同一调用仅用于取消。execute 不重复发送，进度和终态通过原引用查询；不能证明排空时拒绝清理，不能把不确定结果写成 not_started。测试探针显式组装双 Config、真实工具和代理；这种组装不能替代生产 Config/factory 的注册，也不能证明旧会话、Channels/SDK、定时任务或子 Agent 已经迁移。

### 调度接线的本地验收（2026-09-09）

Core 与 ACP Session 各 11 组真实工具探针通过，覆盖 Read/Write/Edit/前台 Shell、确认拒绝、最终 guard 拒绝、PermissionRequest 改参后重做准备、PreToolUse ask、执行中取消及未授权直接调用。Runtime 运行真实工作区工具及命令 Hook；Gateway 不重复执行 Pre/Post/Failure Hook。文件检查点观察调用原始 FileHistoryService，验证 Write/Edit 的 trackEdit 归属。取消探针检查自有 Shell 退出后才完成批次，并确认没有延迟写入。

真实验收发现并修复两处单测此前未覆盖的差异：远端物理取消不能沿用“工具已完成、输出被丢弃”的提示；Session 普通批准没有 answers 时不能传入含 undefined 字段的确认 payload。后者由严格摘要校验复现，修复 producer，没有放宽协议或在测试中增加 JSON 序列化兜底。执行已成功后才收到取消时，仍保留成功的物理状态与实际 Hook 回执。

最终定向单测 1,586 项通过（Core 703、CLI 883），全仓 build、bundle、完整 typecheck（含 integration）及变更文件 lint/格式检查通过。真实探针使用相同的 10 个构建 hash，各轮前后不变；全部自有进程、端口、临时目录已清理，没有依赖兜底强杀。证据目录为 `.qwen/e2e-tests/managed-agent-scheduler-v2-evidence/core-1788895026267/` 和 `session-1788895077760/`，详细报告见 `.qwen/e2e-tests/managed-agent-scheduler-v2.md`。用户 4170 进程未重启、未发送请求。

上述 Session 探针实际进入 runToolCalls，但 ACP 端使用记录与选择真实确认选项的适配器，并非完整 SDK 传输验收；已初始化真实 Chat，模型请求为零。双 Config、注册表和 Runtime client 由测试显式组装，不能证明生产初始化不构造本地工具，也不证明完整 Agent 模型循环、跨进程租约或父子 Agent 的作用域已接通。完整 L4 矩阵、真实编辑器交互、扩展工具和产物搬运仍待后续验收；本切片通过不等于阶段 2 的全部退出条件满足。

## 阶段 1 实现与本地验收（2026-09-09）

已新增 Runtime 持有的真实 invocation、严格 JSON/确认 DTO 和参数摘要。每个调用保存一次 build 的结果、真实确认回调、稳定 toolUseId、preflight 结果和执行 Promise；相同调用重试返回原引用/结果，冲突参数不能覆盖记录。权限确认与 PreToolUse ask 后的确认分开记录；修改参数取消旧引用，再以新参数 prepare。取消 ACK 与实际 settled 分开，关闭等待准备、确认、Hook 和实际执行结束。

实际链路为 owned worker 私有 HTTP → Local provider 保存的 Runtime client → 所属 Bridge → 可信父进程握手的 ACP Tool-only Session → 当前 Config 实例持有的 Runtime。ACP 所有权以 Config 实例保存，不能同名 Session 换实例后沿用。普通 daemon/fixed URL v1 listener 不开放 v2；v2 不接受模型传入的 approved/authorized 字段，也不降级调用 v1 execute。该阶段验收当时，完整 Gateway 调度器的权限和最终 guard 尚未接入，真实进程脚本仅模拟有权限的私有 Gateway 调用者；后续调度接线验收见上文。

私有 HTTP 路径为 `/internal/managed-runtime/v2/{manifest,begin-turn,prepare,confirmation,confirm,preflight,execute,status,cancel}`，每个请求严格携带 version 2 及原有 tenant/workspace/cwd/session/turnKind；沿用 owned lease ID/epoch 校验。begin-turn/prepare 另带 identity，之后操作带 reference；reference 必须匹配外层 Session、prompt/call、capability/policy/args 摘要和随机 invocationId。响应为 `{protocolVersion:2,result}`，begin-turn/confirm 的 result 为 null。底层沿用既有 Session warmup 身份表示不等于 v1 工具降级。

owned 标记在 CLI 启动加载工作区配置之前捕获并删除，重启时仅转发捕获值，再通过显式 host options 传入。工作区 .env 不能把普通 ACP 子进程改成 owned Runtime。活动占用新增真实 tool 类别；准备/确认/执行中阻止空闲关闭，显式关闭先 seal，等待所有 Runtime 排空，再关闭 writer/Config；一项失败不能让另一项未结束的执行提前失去 Config。最终 ACP/helper/CLI 入口、活动占用和 provider 五个文件共 726 项定向测试通过。

Local provider 每次 v2 调用重新核对绑定、workspace 实例和生命周期。release 合并同会话的并发请求，并等待真实 close；失败保留 retiring，禁止 prepare/执行，只允许仍归属原绑定的 status/cancel。warmup 或恢复失败后的清理保存原 client，重试不再 attach。已知绑定关闭失败后的 session_not_found 不是排空证据，仍需 generation 回收；provider.dispose 仅使能力引用失效，不能替代 worker 资源清理。provider 20 项定向测试通过。

当前内核要求显式 begin-turn 完成一次文件快照后才 prepare；真实 Edit/Write/Shell 的 execute 自己执行 trackEdit，内核不重复备份。内核保留完整工具结果与独立物理 executionStatus，省略工作区工具的模型控制字段；进度环有单调 seq、firstAvailableSeq 和缺口标记。记录目前保存在会话进程内，最多 1024 个 invocation、每次调用保留最多 1 MiB 进度；这是阶段 1 的边界，不能作为普通 daemon 长会话最终兼容承诺。持久化重放、资源搬运、MCP/Skill/图片、后台 Shell 及两处调度器的完整元数据仍属后续阶段。

ReadFile 内部的 PDF 视觉转换也属于模型调用。Tool-only Session 的 Config 不再选择视觉模型，即使工作区显式设置了 visionModel；普通 Agent 的选择行为保留。对应红测先复现了 Runtime 仍能选到模型，修复后 core 五个定向文件共 1137 项通过。图片/PDF 的完整模型转换由阶段 3 接回 Gateway，当前不以停止 Runtime 推理替代最终媒体兼容。

诊断已观察到真实 read/write/Edit，以及前台 Shell 同一 invocation 并发/完成后重试只追加一次；丢失已完成 HTTP 响应后查询/重试没有重复写入。prepare、confirm、preflight 都没有目标写入；逐项改动 lease/身份/摘要被拒绝。此前诊断暴露的缺口已修复，最终验证结果如下：

- Shell 的实际取消结果可能不带 error，新内核曾误报 success。已在源码为 ToolResult 增加显式物理结果、由 Shell 生产并由 Runtime 消费，保留取消后 Write 实际完成仍为 success；单测及新构建的真实 worker 均验证为 cancelled；取消后已完成的实际写入仍保持 success。
- 前台 Shell 包装器先退出后，忽略 TERM/HUP 的同组子进程仍然存活。实测 status 已 settled，取消约 4 秒后子进程仍写出文件；单纯 await invocation.execute 不构成进程树排空证明。已补充 POSIX 所属进程组的结束等待，取消在 leader 退出后继续升级到 SIGKILL，并等待实际组退出。相同复现的新构建验收中，首个 settled 样本约在取消后 536 ms，父子进程均已不存在，5.2 秒内没有迟到写入；不能用取消 ACK 或固定延时视为结束。其证据范围是已观测组成员，未观测的 detached/setsid 逃逸和 Windows 等效所有权仍未完成，不能将此局部修复声明为所有平台的完整进程树保证。
- sed 的备份操作曾被 AbortSignal 的 Promise race 提前抛开。红测确认备份未结束时 Shell 已返回；源码改为等待不可取消的读取/备份后再处理取消，目标文件写入原有等待语义保留。定向 Shell 与内核测试、最终构建及独立审查已通过。

最终 `npm run build`、`npm run bundle` 和完整 `npm run typecheck`（含 integration）通过；core 1137、ACP Bridge 987、CLI 726，共 2850 项定向测试通过，变更文件 lint/格式与独立审查通过。此前四项 integration 类型错误通过 IPC 回调类型注解和 ProcessRegistry 的源码路径映射修复。

真实验收包含独立取消子进程用例和完整九组调用链。完整用例的 v1 回归使用未读文件验证原生成功结果；首轮同文件命中 Read 缓存导致的测试断言失败已保留并更正。执行中 release 的用例中，子进程已收到 TERM 但仍存活时 release 保持 pending；约 313 ms 时进程已退出，约 380 ms 才收到 released:true，execute 返回 cancelled，4.2 秒内无迟到写入。两轮共 14 个构建文件 hash 相同且前后未变。

证据目录为 `.qwen/e2e-tests/managed-runtime-invocations-evidence/v2-descendant-1788888641067/` 和 `v2-1788888737422/`，详细报告见 `.qwen/e2e-tests/managed-runtime-invocations.md`。全部测试使用隔离 HOME/工作区/端口，检查确认自有 worker、ACP、Shell、端口和临时目录已清理，没有依赖兜底强杀通过验收。当前用户 4170 预览未重启、未发送请求。此结果证明阶段 1 的 macOS 本地链路，不覆盖生产 Gateway 权限/guard 接线、完整工具与客户端兼容、Windows/Linux 实测或默认 daemon 切换；阶段 2–4 继续实施。

## 阶段 2 生产注册与远端绑定细化（实施中）

离线声明从 Read/Write/Edit/Shell 的真实定义提取，普通工具和代理共享 schema、描述、输出预算及 AUTO 纯投影。声明构造不能加载真实工具或获取 Runtime client；Shell 的平台与配置由可信 host 明确提供。注册仍经过原 PermissionManager 的 disabled/deferred/eager 判定。不能把仅共享 schema 的近似声明送入严格 manifest 摘要校验。

完整 ACP channel 持有由已解析 workspace generation 创建的 Runtime provider。每个实际 Session Config 在初始化前取得独立的惰性 binding：Runtime Session 使用与 Gateway Session 不同的独立 UUID，并绑定 Config 的实际 cwd 与 host 的 workspace/generation；新建且无已跟踪文件历史的会话在第一次 prepare 时启动独立 owned worker 并取得 v2 client；已有文件历史的父 checkpoint 可以提前启动 worker，模型仍可并行开始。bootstrap 与只读 replay 不取得执行 client。绑定关闭进入 Config 的严格异步资源清理，不能依赖 ToolRegistry.stop 不等待的工具 dispose。初始化失败、关闭及 generation 退出共用该清理路径，不能把 HTTP 失败、AbortSignal 或删除 map 项当作排空。

Remote provider 复用已认证 endpoint/lease，在 owned worker 的工具调用、文件历史和终结释放 v2 路由上保持同一 Session 身份。execute 只发送一次，丢失响应由代理通过原引用 status/cancel 恢复，不重发或降级 v1。AutoLocal 每 Session 保存一次 use/client；释放先封住新调用，等待远端 Session 关闭，再释放 use。若 worker 已丢失，则必须等待 activator 提供的真实进程退出结果；失败保留 retiring binding，阻止复用而允许清理重试。单个 Session 释放不应提前停止同 generation 的其他 Session。

这一切片首先接通四种内置工具及完整 ACP host，不能据此声明默认迁移或完整初始化边界已经达成。该注册切片当时尚未接通子作用域；其后实现与验收见下文。Gateway 的文件/Skill/MCP/Hook 初始化、其他工具迁移及物理撤销仍需继续实现。父子 Agent 不能共享当前只允许单 prompt 的 Runtime client，也不能仅放开并发而破坏 FileHistory 快照。当前先按[全局架构](managed-agent-session-harness-runtime.md)完成 Session 独立权威、完整 Harness 与恢复接缝，再完成兼容配置与四处默认 factory 接线，在已验收范围有限启用并逐项扩展；真实验收必须通过 create/prompt 模型循环，禁止测试手工替换注册表冒充生产接线。

### 完整 host 与默认记忆验收（2026-09-09）

注册组合验收已通过显式关闭自动记忆时的 root Session 三组：无工具轮次零 acquire、真实模型经独立 worker Read/Write/Shell 后返回正式 final、实际 close/release 和全部 Config 关闭。这只证明注册与远端调用主链；默认自动记忆配置的另一轮实际进程曾在 no-tool 结束后退出，不能把隔离结果替代默认行为验收。

失败有两层实际原因。ACP Session 直接使用 Chat 模型循环，绕过 LlmClient 唯一保存 cache-safe params 的分支，但默认 memory extraction 仍从进程共享单槽读取该数据。共享 Gateway 下另一 Session 也可能覆盖该槽。MemoryManager 又对失败任务调用无人等待的 promise.finally，并且启动 queued extraction 时不处理拒绝，导致已有调用者 catch 无法阻止额外的未处理拒绝。

修复让两个真实 extraction producer 在调度时捕获本轮 40 条 curated/slim 历史，并以必填 extractionHistory 随队列任务传递；完整 history 继续用于 cursor。planner 消费这个 Session 自己的快照，不回读 live chat 或全局槽；sessionId 与 Config 的身份检查继续保留。任务跟踪使用同时处理成功/失败的清理分支，排队任务失败保留任务错误记录并被观察，不再产生额外未处理拒绝。验收分别记录主会话、独立记忆模型请求和任务终态；即使记忆任务无需写文件即可正常结束，仍不能据此声明子 Agent 工作区工具作用域已经迁移。

修复后的隔离真实进程验收 `registry-default-memory-1788899037951` 四组通过：省略 memory 设置并确认默认 extraction/dream 均启用；两个主轮次均返回正式 end_turn；两个真实记忆 Agent 完成独立模型请求，真实 MemoryManager 的 extraction 任务完成且 drain 成功。共观察到 5 次主 Agent 和 2 次记忆 Agent 模型请求。无工具轮次零 acquire；工具轮次实际 Read/Write/Shell 三次执行成功，Gateway 对这四类工作区工具的本地 build 为零。三个实际 Config 均完成关闭；worker、ACP、Shell 进程及两个测试端口退出，无超时或备用清理。验收前后及回读时 37 项构建摘要一致。记忆 Agent 本次返回“本次无持久记忆变化”，此结果只证明提取调用与任务结束，不证明记忆文件写入、子 Agent 工具迁移或普通 daemon 默认接入。

### 子 Agent 的独立执行与共享文件历史（实现与限定验收通过）

完整设计、入口和证据见 [Managed 子任务执行与持久文件历史](managed-agent-child-scopes.md)。每个实际 Agent 启动创建一次独立执行作用域；权限和模型配置 overlay 继承它。AgentTool 前台/后台/fork、cold resume、InProcessBackend、工具型 runForkedAgent（包括 Memory）及 Manager 直接调用已接入。热继续保留作用域，冷恢复或 respawn 等待旧资源清理后使用新 UUID。

同一逻辑父会话只持有一个真实 FileHistoryService owner，使用持久父 Session ID 保存备份。子 Runtime 的 cwd、读取缓存、调用状态独立；子 prompt 不增加父快照。文件编辑沿用最近父快照的既有行为：P1 启动的后台 child 在 P2 开始后编辑，归属 P2，不固定在子启动轮次。当前所有实际工具和 checkpoint 经过共享队列，长 Shell 造成的并发限制仍待解决。

ACP/Core 的真实父轮次 producer 推进 checkpoint；无 Runtime 且无跟踪文件时只在 Gateway 持久记录空快照。首次子工具先绑定父 owner，再绑定独立子 Session。私有 v2 增加 bind-history/checkpoint/history 并贯通实际 HTTP 白名单；历史保持原 lease、身份和可信父校验，限额为 8 MiB。索引经 revision 回到原 Gateway writer，严格批写 ACK 后才更新镜像。关闭先封锁和排空子作用域，同步历史、终结释放 Runtime，再完成 Gateway 清理，失败保留重试。

macOS 五组真实完整 host 验收通过：A 父未用文件工具而子 Read/Write 成功；B 父 Read 不授予子 prior-read；C 后台跨 P1/P2 两次写入同属 P2 并保留 V0；D 默认 Memory extractor 经子 Runtime 写原 Gateway trusted 根中的项目记忆和索引，真实任务完成；E 旧 worker 退出后实际 loadSession，同一父 Session 的新 Runtime 恢复 JSONL 快照并实读 V0 备份及当前 V1。各组均核对 terminal v2 release、真实进程退出和临时目录清理，共同 42 项及补充后联合 57 项构建摘要不变。

完整 build/bundle/typecheck、变更 lint/格式和人工审查通过，本阶段去重 23 文件 2,191 项定向测试通过，两个筛选文件另有 1,203 项未运行。external-v1 隐藏子 Agent 缺少 invocation context 的既有拒绝保留为未兼容范围；五组采用 builtin guard。E 不证明 Gateway 物理 rewind/diff/branch/delete 已迁移，D 不证明 Memory scaffold/index rebuild 等本地操作已经移出 Gateway。其余工具、初始化、不同 cwd/故障组合、长历史与 Windows/Linux 验收继续实施，阶段 2 和默认替换整体仍未完成。

### 审查发现的迟到 HTTP 请求与终结释放（已修复并验证）

真实 HTTP 反例连续三次复现：首条 v2 manifest 已被 Express 解析但延后派发，Remote release 返回 released:true、Local 关闭 Session 后，再放行该请求，Local.getToolV2Client 会隐式 prepare 并重新创建相同 Session。客户端的 AbortSignal 只让 fetch 失败，并未阻止服务器派发。反例使用实际 Remote/Local provider 和 worker routes；Bridge 仅记录 Session 生命周期及测试文件标记，不冒充真实 SessionWriterLease。该失败使原有正常关闭验收不足以证明 HTTP 乱序下所有权已经终结，必须先修复再交付。

新增 owned v2 Session 终结释放 `/internal/managed-runtime/v2/release`，该路由属于 owned worker 内已解析 workspace/live Session owner，沿用认证、lease、epoch、tenant、workspace/cwd 与 Session 身份校验。固定 URL 或没有 owned lease 的服务不能启用它。普通 v1 release 保留释放后再次使用同一 Session ID 的既有语义。

实际 ManagedToolSession producer 关闭时显式传 terminal 意图，AutoLocal/Remote 同时从已分配的 v2 client 推断该意图，覆盖首条 v2 请求还没有到达以及首次 acquire 失败的情况。Local 在任何 await 前封住该 Session；只有真实 cleanup 成功，才将活动引用替换为只含身份和 completed 的轻量终态记录。记录存活到 provider/generation 结束，同身份重复终结成功、冲突身份拒绝，迟到 v1 prepare 和 v2 调用不得重建 Session。清理失败继续保留实际资源与重试入口。

若普通 release 正在执行时升级为 terminal，Local 在原记录上提升关闭意图；Remote/AutoLocal 也必须等待匹配 v2 协议的终结 ACK，已经收到的 v1 ACK 不能代替它。终态记录不保留 Config、Runtime use、client Promise、warmup 或 cleanup 闭包。worker 丢失时仍须等待真实进程退出，不能为了完成释放重新激活 worker。

修复验收包含迟到首条 v2 请求、迟到 v1 prepare、初次 acquire 失败、普通 release pending 升级、同身份幂等与冲突拒绝、v1 正常复用，以及完整 Agent 的默认记忆和真实工具回归。完整 server 的 owned HTTP 白名单也必须放行 v2 release；新增真实 server 回归先观察到 404，再修正白名单，整文件 372 项通过。Provider/AutoLocal/helper 三文件 53 项通过。

新构建的 `fixed-1788901760083` 实际 HTTP 验收连续三次通过：每次都收到带正确 lease 的 v2 终结回执，再放行已解析的首条 manifest；等待生产路由处理结束后确认没有重建，合计 spawn=3、close=3、manifest=0，测试 Session 均不存在。此探针仍使用计数 Bridge，不把测试标记当作实际 ACP writer 证明。

完整 host 的 `registry-default-memory-1788901782552` 四组再次通过，实际 worker 入口收到并返回 v2 release 200/released:true；主模型执行 Read/Write/Shell 后正常结束，两个真实记忆提取 Agent 也完成。worker、ACP、Shell、自有端口和临时目录全部回收，没有超时或备用强杀。37 个构建摘要前后及回读一致；迟到 HTTP 探针的 5 个摘要同样一致。完整 build/bundle/typecheck、变更文件 lint/格式通过；本切片实施期间去重累计 29 文件 3227 项测试通过（非全仓套件，Core client 的记忆/关闭筛选另有 372 项未运行）。上述终结释放切片当时未验证记忆实际写入与子作用域；后续五组结果见前一节。完整初始化和普通 daemon 默认切换继续实施。

## Glob 与可选 LS 后续接线

[搜索工具方案](managed-agent-search-tools.md)在同一 v2 invocation 链加入 Glob/LS，共享原生声明且不在 Gateway 构造或执行这两个本地工具。已有 bind-history DTO 增加可选执行上下文，实际新 producer 总是携带父子各自的目录、过滤、记忆根和 LS opt-in；Runtime 派生视图执行并保持原权限与共享父历史。macOS 四组真实搜索验收和既有子任务 prior-read 回归通过。没有新增公共路由或宽松 fallback；未识别上下文的旧 worker 明确报错。后续 Grep、NotebookEdit、媒体 M1/PDF 物理取消已有各自限定验收；配置热更新、其余工具、本地初始化和物理历史仍须补齐。三处 workspace factory 加自有嵌入入口共四处，当前按首阶段计划接入，不将后置能力作为有限启用的无条件前置。
