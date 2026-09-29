# Managed Agent：完整工具、内容资源与会话历史

[English](managed-agent-tools-history.md) | [简体中文](managed-agent-tools-history.zh-CN.md)

更新日期：2026-09-23。本稿覆盖[全量设计](managed-agent-full-design.md)的 C04/C06/C13/C14。原 2026-09-11 核实记录使用生产源码 `a836081466` 与方案 `2ec07afb727464ac2306282c9be2c086697f7768`，当时两者之间仅有文档变化；第 2 节的行号和事实仍归该历史基线，不冒充本轮重新验证。补充设计基线为 `code_agent@1478e7b632eb237bc3f40ea574ce90782e1cf4c3`，集成参考 draft `bad721f22fcd8cfad9ec22e98f69fec75b20b6f0`，本地 `f5088d2e`。第 3～8 节的完整契约及本轮补充均为待实现、未产品验收；不改变原有实现记录。

本稿复用[存储规范](managed-agent-session-storage.zh-CN.md)的唯一 Session 事实、[私有协议](managed-agent-control-protocol.zh-CN.md)的资格和回执，以及[完整 Harness](managed-agent-harness.md)的模型循环与 checkpoint。首阶段只启用已实际验收的范围，完整工具/内容与历史转换分别在 R5.F2、R5.F7 实施；延期的是实施，不是这些能力的设计。

## 1. 职责、授权与唯一提交载体

Session 保存身份、授权决定、领域操作状态和资源引用；Harness 执行原模型调用、调度、编排、交互与结果转换；Runtime 操作所属工作区的文件、进程、LSP 和网络传输。分段工具仍只有一个模型可见调用，内部阶段不变成另一套工具名或精简模型循环。完整注册清单见第 3 节；动态 MCP、Skills、Hooks 的细节从[配置与扩展](managed-agent-config-extensions.md)取得，不在此建立第二份注册事实。

所有 Session 领域变化使用 `domain.committed {domain, version, operationId, recordRef}`，`recordRef` 指向已持久化的封闭领域 payload。本文不新增 `rewind.committed`、`session_conversion` 等顶层事件或另一份 Session journal。原 `tool.intent/tool.receipt/checkpoint.committed/lifecycle.changed` 分别表达调用、结算、检查点和生命周期，领域 payload 通过引用关联它们，不复制一份可独立变更的事实。Runtime 的物理意图、逐阶段/逐文件结果和恢复日志独立保存在 [RuntimeReceiptStore](managed-agent-recovery-operations.zh-CN.md)，其结果必须被 Session 接收才能驱动模型或正式历史。

沿用 `SessionKey/CommandMeta/DurableRef/InvocationBinding/ToolOutcomeRef/CommitReceipt`；字段编码、摘要、限额和引用闭包以存储规范为准。`DurableRef` 固定为 `resourceId/kind/schemaVersion/byteLength/digest`，MIME、来源、保留目的和文件属性放入各自资源描述正文，不另造不兼容的 ContentRef。不得在已有 owned Tool v2 或 InvocationContextV1 中原地添加字段：新增执行阶段与资格放在协商后的 control envelope，内部原 invocation reference 保持完整、不可变。

模型产生的新工具意图必须来自当前 activation；已受理领域操作的后续维护、发布、释放可使用 authority 签发的 `OperationGrant`，无需启动一个模型。grant 绑定原 SessionKey、operationId/domain/revision、owner、workspaceGeneration、resourceScope 和 lease，Runtime 按 per-operation 单调 gate 只准入原计划阶段。维护先取得对应 barrier；新资格不能使撤销过的阶段重新执行。原回执查询/收件凭原 binding 或 operation 证明，不要求制造新的 activation。用户取消、撤权或 transport EOF 不能删除已完成效果；unknown 保留 `recovery_blocked`，不借重领 grant 自动重跑。

### 1.1 本专项的领域注册表

以下 domain 用于 Managed Session，event `version=1`；对应 `recordRef.kind='managed-<domain>'`、`schemaVersion=1`。每条正文包含 operationId、operationRevision、前一记录引用、明确 operation/phase、输入及结果引用；服务端按表中的 producer、合法状态转换、作用域和引用闭包校验。新名字必须新增显式 schema/producer/consumer，不开放任意 JSON append。legacy 原格式不追加这些事件；转换到 legacy 的创建控制见第 7.2 节。

本表七个 domain 纳入[存储 §3.1](managed-agent-session-storage.zh-CN.md#31-domain-注册索引)的唯一名称索引；具体阶段未实现时不因名称已注册就获得能力，history_operation 不是替代本表三种历史 domain 的别名。

| domain              | 封闭正文与生产者                                                                                                                                                                       | 与原事实的关系                                                                                                                                                 |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| tool_stage          | `ToolStageRecord`：可信 stage plan、原 executionCallId、stageId/ordinal、输入摘要、planned/running/settled/unknown/cancelled、原 Runtime/model/domain outcome refs；注册工具编排适配   | 单工具的阶段协调；原生结果只引用原 receipt，模型请求引用原 attempt；不能用它宣称文件已写                                                                       |
| resource            | `ResourceRecord`：admit/commit/pin/unpin/release/retire/collect，资源 manifest、访问 owner、持有者与 revision、保留配额证明；Session 资源适配                                          | 登记引用及保留状态；不重复保存 tool result，不以 metadata 代替实际内容                                                                                         |
| publication         | `PublicationRecord`：prepare/publish/inspect/unpublish，sourceRef/destinationId/稳定发布 ID/授权摘要、原 provider 或 Runtime 回执、known/unknown 结论；发布适配                        | 工具阶段只引用该操作；取消请求与已发布事实独立                                                                                                                 |
| workspace_operation | `WorkspaceOperationRecord`：Session 所属 worktree_create/worktree_remove/context_change，repo/worktree owner、HEAD/status proof、原物理阶段及目标 context revision；Session 工作区适配 | Shell Git 仍有原 tool.receipt；无 Session 的工作区路由按第 4.3 节独立归属，不伪造 Session 事件                                                                 |
| history_rewind      | `RewindRecord`：prepare/apply/rollback/commit，原/目标历史 proof、planRef、物理回执、结果 projection refs、prepared/applying/rolled_back/committed/recovery_blocked；历史适配          | `commit` 是领域正文状态，唯一 event 仍是 domain.committed；新模型投影仅消费已 committed 的目标                                                                 |
| history_copy        | `SessionCopyRecord`：fork/convert/import，源一致快照、目标身份/格式、ID 映射与资源 manifest、reserved/staged/published/aborted/recovery_blocked；复制适配                              | 目标 provenance 从该记录投影，不追加另一 owner；源 target 接收用稳定 ID 去重                                                                                   |
| history_maintenance | `HistoryMaintenanceRecord`：title/archive/unarchive/delete/export/format_upgrade，目标 scope、原文件 proof、资源引用变更与物理阶段；维护适配                                           | lifecycle.changed 与必要领域记录同事务；title 引用 session_metadata 结果，format_upgrade 的 committed proof 引用原/新格式及源前缀；批量不承诺跨 Session 原子性 |

`domain.committed` 表示该条领域事实已经可靠提交，不表示正文中的业务操作必然成功。例如 applying/unknown 是正式状态，不能映射为 rewind 或发布成功。内容先持久化，事件和 commit marker 再由同一 authority writer 条件提交；详情错误使用控制协议的有界错误与 recoveryRef。

<a id="hosted-initial-scope"></a>

### 1.2 Hosted 首版与通用兼容边界

选定部署为 Linux/Kubernetes、Java 控制面加 qwen serve sidecar、Session 独占 Runtime Pod、CSI 独占 Workspace 卷。Hosted 首版只以 Read/Write/Edit/foregroundShell 为工具验收范围；第 3 节的 47 项是全工具归位目标，不代表首版全部开放。未验收的 Hooks、MCP、后台任务、client callback 等在 Hosted 明确拒绝，不 auto-local，也不 Legacy fallback。普通通用入口仍保留第 3.1 节原有的 Legacy 兼容选择；这不是全局禁用 Legacy。

Harness 不挂 Workspace；启动配置来自不可变 Bundle，自有 Session 状态通过既定存储接口读取。compaction 的附件及路径内容只能来自已提交且仍获授权的结果资源，或正式 Runtime 读取；后者同样取得第 4.4 节占用。相同路径在 Harness 本地存在不构成可用输入。new/spawn/restore、派生 Config、child/workflow 与恢复/压缩均不能绕过 profile 检查和真实 Runtime 路由；未启用路径明确拒绝，不因另一个入口可构造对象而放行。

本轮不做新增配额/计费方案；第 5 节原有限额与资源保留规范不变。租户信任分级和强隔离运行时选型暂缓，不据此宣称生产多租户安全已完成。通用凭据、撤权及原调用窄资格遵从[私有协议](managed-agent-control-protocol.zh-CN.md)和[恢复操作](managed-agent-recovery-operations.zh-CN.md)，不另建执行 authority。

## 2. 当前源码事实与实现接缝

路径相对仓库根，行号使用上述源码基线。下表是当前事实，不能据此宣称后文新增能力已经存在。

| 来源                                                                                                                                     | 已核实事实与迁移接缝                                                                                                                                                                                                                    |
| ---------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/core/src/config/config.ts:9386`、`:9430`、`:9473`～`:9842`                                                                     | 注册先保留 permission/coreTools/eager 等条件；Managed 仅在 createManagedBuiltinTool 返回代理时替换 factory，其他 factory 仍可在 Harness 执行。bare/SDK/subagent/交互/功能开关影响注册                                                   |
| `packages/core/src/config/config.ts:9374`、`:9712`                                                                                       | ImageGen 使用独立 registerImageGenerationTool，不能只改 registerLazy 分支                                                                                                                                                               |
| `packages/core/src/tools/managed-tool-session.ts:60`                                                                                     | 只有 NotebookEdit/Grep/Glob/LS/Read/Zoom/Write/Edit/Shell 九类代理                                                                                                                                                                      |
| `packages/core/src/tools/managed-tool-protocol.ts:33`、`packages/core/src/tools/managed-tool-runtime.ts:50`                              | 原 v2 identity 含 sessionId/promptId/callId/capabilityDigest/policyRevision，reference 再加 invocationId/argsDigest；prepare/confirmation/confirm/preflight/execute/status/cancel 有真实身份及 not_started/success/error/cancelled 回执 |
| `packages/core/src/core/coreToolScheduler.ts:541`                                                                                        | FS_PATH_TOOL_NAMES 仍为手工清单；条件权限、路径 Skill 激活、结果路径消费者不会随代理自动补齐                                                                                                                                            |
| `packages/core/src/tools/web-fetch.ts:209`、`:537`、`:606`                                                                               | url/prompt/format 输入经过 fetch、二进制落盘/缓存，再调用 runSideQuery；模型处理失败可返回实际 raw 内容                                                                                                                                 |
| `packages/core/src/tools/web-search.ts:635`、`packages/core/src/tools/image-gen.ts:69`                                                   | WebSearch 实际使用 DashScope gate、环境 key 与 OpenAI Responses；ImageGen 的 provider 与 mkdir/atomicWriteFile 在同一 execute，不能整体送入 Tool-only worker                                                                            |
| `packages/core/src/tools/lsp.ts:147`、`:732`、`packages/core/src/lsp/types.ts:277`                                                       | 十二个查询操作；codeActions 不执行 workspace edit；当前 execute 未消费 \_signal，LspClient 查询无共同取消参数                                                                                                                           |
| `packages/core/src/tools/monitor.ts:298`                                                                                                 | detached shell、独立 AbortController、ownerAgentId/PID/事件/超时；已开始 Monitor 刻意不随当前 turn Ctrl+C 结束                                                                                                                          |
| `packages/core/src/tools/workflow/workflow.ts:77`、`packages/core/src/agents/runtime/workflow-runner.ts:162`、`:213`、`:430`             | script/scriptPath、args、resumeFromRunId、background 使用 journal、真实 production dispatch 和 drain，不是纯文件执行                                                                                                                    |
| `packages/core/src/tools/enter-worktree.ts:70`、`:173`～`:218`                                                                           | Git 创建后写 owner marker 和 sidecar，后两者失败目前可警告；返回新路径，不自动 process.chdir                                                                                                                                            |
| `packages/core/src/tools/artifact/artifact-tool.ts:137`、`packages/core/src/tools/artifact/publisher.ts:16`                              | 读取/包装 HTML、发布、可选 openUrl；local/host/oss publisher 输入 id/title/html，输出 id/url/filePath?                                                                                                                                  |
| `packages/core/src/tools/artifact/local-publisher.ts:35`、`packages/core/src/tools/artifact/host-publisher.ts:28`                        | local 直接 writeFile 并返回 file://；host 使用命令执行，现有 signal 不单独证明后代组排空                                                                                                                                                |
| `packages/core/src/tools/record-artifact.ts:90`、`:932`、`packages/core/src/tools/tools.ts:472`～`:552`                                  | 实际 realpath/regular file/目录展开；ToolResult 保留 llmContent/returnDisplay/resultFilePaths/artifacts；metadata 不拥有物理生命周期                                                                                                    |
| `packages/core/src/services/session-artifact-persistence.ts:14`、`:76`、`packages/acp-bridge/src/sessionArtifacts.ts:3231`               | v2 持久类型已有 contentRef/retention；live store 仅支持 ephemeral/restorable，明确拒绝 pinned；workspace status 仍读 Gateway 所在文件系统                                                                                               |
| `packages/cli/src/serve/routes/session.ts:4998`～`:5097`、`:5355`                                                                        | artifact 列表/登记/删除走所属 owner；没有 opaque artifact 内容流接口；attachments 是输入附件接口，不等于产物内容服务                                                                                                                    |
| `packages/cli/src/acp-integration/managed-tool-media.ts:10`、`:45`、`packages/acp-bridge/src/spawnChannel.ts:45`                         | execute/status/cancel 媒体校验允许合法空 base64；media frame 为 64 MiB 减 64 KiB，ACP frame 和总 queued bytes 各 64 MiB、队列最多 256 项                                                                                                |
| `packages/core/src/tools/read-file.ts:222`、`:350`                                                                                       | PDF vision candidate 会触发模型转写；全部候选页成功且无 inline/fileData 才替换 fallback，不能把模型段放进 Runtime                                                                                                                       |
| `packages/core/src/tools/managed-tool-file-history-protocol.ts:76`、`packages/core/src/tools/managed-tool-file-history.ts:65`            | 历史只有 bind/checkpoint/snapshot，owner/revision/snapshots 和备份校验，不存在物理 rewind RPC                                                                                                                                           |
| `packages/cli/src/acp-integration/session/Session.ts:4218`、`packages/cli/src/acp-integration/acpAgent.ts:12609`                         | 现有 ACP rewind 先改模型历史、快照和 recording，再调用本地 FHS；ACP success:true 仍可能附 filesFailed                                                                                                                                   |
| `packages/core/src/services/chatRecordingService.ts:2483`、`packages/core/src/services/fileHistoryService.ts:828`、`:1226`               | rewindRecording 是 void 且内部 catch；FHS 逐文件恢复/删除，失败进 filesFailed，全成功才截断其历史，不具备跨文件原子性                                                                                                                   |
| `packages/acp-bridge/src/bridgeTypes.ts:141`、`packages/acp-bridge/src/bridge.ts:13354`                                                  | 公开 RewindResponse 为 rewound/targetTurnIndex/filesChanged/filesFailed/warnings?；Bridge 在 busy 时同步准入拒绝，已派发后等真实回复/断线，现有 rewound 取决于 filesFailed 是否为空                                                     |
| `packages/core/src/services/sessionService.ts:3400`、`:3424`、`:3470`、`:3650`                                                           | fork 当前显式要求 legacy；筛 active chain、处理 side artifacts/检查点/备份、staging+sync、目标 no-clobber，不能直接移除 Managed 拒绝就宣称可用                                                                                          |
| `packages/core/src/services/session-execution-engine.ts:11`、`:58`、`:140`、`packages/core/src/services/sessionService.ts:2960`、`:3102` | 完整有效无 owner 历史推导 legacy，冲突/损坏拒绝；archive/unarchive 有文件身份和可变性检查，批量保留逐项 errors                                                                                                                          |

## 3. C04：全部 47 项注册能力归位

createToolRegistry 中有 46 个不同 registerLazy 名称，加独立 ImageGen 共 47 项；下表数量合计 47，不代表每个模式同时暴露全部工具。保留原 allowlist、permission、eager/deferred、aliases、bare、SDK、subagent 与功能开关。`save_memory` 仅为兼容名称，当前此注册路径无 factory；没有独立 `git` 工具，Git 还须覆盖 Shell 和第 4.3 节的非工具路由。

| 工具完整清单                                                                                                 | 数量 | 最终分工与保留语义                                                                                                                                         |
| ------------------------------------------------------------------------------------------------------------ | ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| read_file、zoom_image、write_file、edit、notebook_edit、run_shell_command、glob、grep_search、list_directory | 9    | Runtime 执行原生操作；Harness 处理模型内容/媒体。保留原 prepare/permission/Hook/execute/status/cancel/历史及搜索 fallback、输出限制，不落回 Harness native |
| tool_search、structured_output、report_findings                                                              | 3    | Harness 查询同一 catalog、处理结构化结果和终止。structured_output 保留主循环终止及 subagent 限制，不启动另一 loop                                          |
| get_goal、update_goal、todo_write、ask_user_question、enter_plan_mode、exit_plan_mode                        | 6    | Session 的 Goal/Todo/action/模式领域与 Harness 交互；最终决定持久后才推进，参数与 revision 绑定，不给纯交互伪造 Runtime 引用                               |
| agent、list_agents、task_stop、send_message、create_sub_session                                              | 5    | Session 子作用域/信箱；独立 Harness 模型执行和所属 Runtime。create_sub_session 需真实 spawner，stop 等所选执行树物理结算，消息受理去重                     |
| team_create、team_delete、team_plan_approval、request_shutdown、task_create、task_update、task_list          | 7    | Session 团队/任务/信箱，Harness 调度；保留功能开关与 leader-only request_shutdown，worker 不自报 leader 获权                                               |
| cron_create、cron_list、cron_delete、loop_wakeup                                                             | 4    | Session 调度；持久计划与 one-shot 分开，固定所属 workspace/配置，当前 turn 取消不自动删除已提交计划                                                        |
| skill、read_mcp_resource                                                                                     | 2    | Harness 展开 Skill/模型约束，Runtime 读取内容及所属 MCP 连接；配置领域提交动态能力，不能在 Harness 再开第二套 MCP 进程                                     |
| enter_worktree、exit_worktree                                                                                | 2    | Runtime Git/文件，Session owner/context；保留明确授权、dirty/owner 校验和返回路径语义                                                                      |
| web_fetch                                                                                                    | 1    | Runtime fetch/解析/缓存/二进制存储，Harness 原 runSideQuery；传输与模型处理分阶段，原 raw fallback 保留                                                    |
| web_search                                                                                                   | 1    | Harness 模型服务；保留真实 provider gate/key/env/usage/取消，不误称 Runtime 浏览器                                                                         |
| image_gen                                                                                                    | 1    | Harness 图像 provider，Runtime 原子落 workspace 文件；保存 provider 与文件阶段回执，结果未知不重复计费生成                                                 |
| display_image                                                                                                | 1    | Runtime PNG 校验/读取，Harness 与客户端展示；保留主 agent/终端 capability 条件和 display-only 语义，不额外送图给模型                                       |
| artifact                                                                                                     | 1    | Runtime HTML 来源及 local/host 发布执行；受控发布适配处理目的地凭据，Session 登记回执，客户端执行 autoOpen                                                 |
| record_artifact                                                                                              | 1    | Runtime 检验文件/有界目录展开，Session 登记真实内容身份；外链只登记 locator，不自动访问                                                                    |
| lsp                                                                                                          | 1    | Runtime 工作区 LSP 连接，Harness 保留原格式；十二种 query schema 不变，codeActions 不暗中执行返回动作                                                      |
| workflow                                                                                                     | 1    | Session 运行/派发状态，Harness 原受限 JS 编排与子 Harness dispatch，Runtime 读取 script/Git；恢复先查原子执行                                              |
| monitor                                                                                                      | 1    | Session 长期运行登记/通知，Runtime detached 命令/流；start 回执与长期终态分开，按原生命周期跨 turn 存活                                                    |

### 3.1 一个 catalog，三种结果来源

完整 registry 是唯一模型目录；可信内部执行计划为每个实际注册工具给出 `executionOwner=session|harness|runtime|staged`、planVersion 与定义摘要。eager/deferred/alwaysLoad/aliases/maxOutput/truncate/ToolSearch 取同一份注册结果；Runtime manifest 仅包含其实际能力，不要求 Session 工具伪装成 Runtime descriptor。ImageGen 的独立 factory、派生 Config 与 child/workflow 注册都必须接入。

初始化发现已启用工具没有执行计划时不能静默删工具、使用 Harness 原生 fallback 或创建后再改变 owner：新会话兼容选择仍走原 legacy 范围；已固定 Managed 的会话准确拒绝该新配置。全量准入要求所有实际项已有对应实现/验收。FS_PATH_TOOL_NAMES、路径条件权限、Skill 触发和 resultFilePaths 逐一使用真实作用域，不能只扩大九类代理表。

直接物理工具使用 `ToolOutcomeRef.source=runtime`；纯领域工具使用 domain；Harness 结构化结果和已注册分段编排使用 orchestration。分段结果引用每个真实 Runtime/domain/model outcome，经固定 plan 合成一个原 ToolResult。orchestration 不是 Harness 自报物理成功的旁路。调用 ID、batch ordinal、结果消费位置沿 HarnessCheckpoint v1 保存，不再定义另一套模型 checkpoint。

## 4. 分段工具与工作区操作的具体契约

### 4.1 Stage 与文件证明

新增 `ToolStageEnvelope` 的字段为原 CommandMeta、原 InvocationBinding（只有物理工具阶段需要）、planRef、stageId、ordinal、effectId/effectRevision、inputRef 和调用资格。资格按控制协议分为原 activation fence 或已受理 operation 的 OperationGrant；原 v2 payload 原样嵌入，不将 stage 字段拼进旧 reference。混合阶段是原 execute 下已注册的 segment，模型桥接不变成 Runtime 模型执行；每个 segment 的 effectId/effectRevision 固定实际输入与前置证明，phaseOperationId 遵从恢复专项，重领 grant 的 operationRevision 仅改变门禁/CAS，不改变原效果 ID。改参必须受理显式新效果，不能用它覆盖 unknown。Runtime 还要验证 plan 中声明的阶段、前置 receipt、args/policy/media/Hook 版本和本次实际资源范围。

文件身份使用显式 union：`FileProof = absent | file{digest,byteLength,mode,identityRef}`；identityRef 是 Runtime 生成的 dev/ino 或平台等价身份，不是模型输入。缺失、未检查和原来不存在分别表达，不能把可选字段缺省当作 absent。工作区路径只在经过验证的范围内规范化，拒绝 symlink/祖先替换逃逸。大批文件使用 manifest ref 加分页，不突破存储限额。

物理阶段复用 RuntimeReceiptStore 的 intent→dispatch_started→phase_settled→accepted→released/tombstone。正文区分 `not_started_proven/running_attached/settled/unknown/corrupt`，native status 仍保留原 not_started/success/error/cancelled。分段成功要满足原工具整体契约，但先前阶段的真实成功不能被后续模型失败覆盖为“未执行”。

### 4.2 每个跨域工具的阶段与恢复

| 工具/内部方法                                                       | 输入、输出和执行 owner                                                                                                                                                                                    | 恢复、取消及授权                                                                                                                                                                                                                           |
| ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| WebFetch `fetchResource` → `processFetchedContent`                  | Runtime 接收原 url/format 和网络策略，返回 `FetchReceipt{sourceUrl,finalUrl,httpStatus,selectedHeaders,normalizedTextRef?,binaryRef?,cache}`；Harness 消费完整内容并执行原 prompt 的 runSideQuery         | headers 仅留非秘密白名单；缓存按 URL、影响内容的请求配置、凭据 broker revision、workspace/network generation 隔离。redirect 继续原目标授权；副模型失败用原 raw fallback，重试模型不重新 fetch；传输已完成后取消保留回执                    |
| WebSearch                                                           | Harness 保留原 Responses/provider 能力和 gate，使用实际模型 route/认证，返回原 ToolResult 并记录 attempt/usage                                                                                            | 不下发模型 key 到 Runtime，不把超时当未计费；查询结果恢复自原受理 attempt，unknown 不自行重新请求                                                                                                                                          |
| ImageGen `generateImage` → `writeGeneratedFile`                     | Harness 以稳定 providerAttemptId 请求生成，成功 bytes 先存 DurableRef；Runtime 接收 outputRef/规范 workspacePath/expectedPrevious，no-follow 检查后 staging+sync+rename，返回前后 FileProof 及原 artifact | provider receipt 和文件 receipt 分别提交；lost ACK 先查原阶段。provider 不支持幂等查询且结果未知时 blocked；再次生成是显式新调用，不冒充恢复。落盘失败不得触发第二次生成                                                                   |
| Artifact `prepareArtifact` → `publishArtifact` → `inspectPublished` | Runtime 读取/校验/包裹 HTML，返回 sourceRef；受控发布计划固定 destinationId/稳定 publicationId/expectedRevision。local 用原子文件发布，host 用原进程 owner，OSS 用拥有该目的地凭据的发布适配              | publicationId 使用 workspace/session 命名空间及稳定操作身份；目的地凭据通过 broker 窄授权，不给整个模型环境。inspect 校验发布内容 digest；无法核验的 host/远端 unknown 不盲目上传。unpublish 是独立用户授权操作；autoOpen 是客户端展示事件 |
| RecordArtifact / DisplayImage                                       | Runtime 检查/读取实际文件和目录后给资源 manifest；Session 登记 artifact，客户端消费授权内容 ref，旧 ToolResult 格式适配保留                                                                               | 不让 Gateway 按 Runtime 绝对路径访问本机文件；DisplayImage 仍仅展示；外链 metadata 不下载，不据字符串存在声明 available                                                                                                                    |
| LSP `request/cancel/releaseOwner`                                   | 原 LspToolParams、server/config digest、稳定 requestId；Runtime 连接 pending-map 关联请求。server 池按 workspace/root/env/server/trust revision 隔离                                                      | 单请求发 `$/cancelRequest` 并结算本请求，不能取消一个请求就杀 sibling server；最后 owner 释放时 shutdown/exit/TERM/KILL，按平台核验所属进程终态。codeActions 查询无 apply 副作用                                                           |
| Monitor `start/status/stop/events`                                  | Runtime start 接收 command/directory/limits，返回 monitorId/processOwnerRef/start receipt；Session 固定 owner/scope，分页事件带稳定 seq                                                                   | start 前取消阻止创建；已 started 后保留原跨 turn 生命周期。Session close/明确 stop/workspace drain 取消并等所属组终态。事件有界背压，后台终态与 start 的工具终态分开，旧 owner 失联保持可查询未知                                          |
| Workflow `readWorkflowSource/run/resume`                            | Runtime 返回规范路径/sourceRef；Harness 运行现有受限编排器和真实 child dispatch；Session 固定 runId/source digest/args digest/预算、dispatch/child refs 和已完成 prefix                                   | resumeFromRunId 只复用匹配的已提交 prefix；started 无结果先查原 child，不因 journal 缺 result 再派发。background 工具返回不结束 workflow；stop/drain 沿子作用域。执行脚本不在 Tool-only worker 内启动 AgentHeadless                        |

plan 中不得使用任意方法名动态执行；每个上述方法有封闭 schema 和注册消费者。模型与工具 Hook 都保留原触发次数，正常恢复查询不重复 pre/post Hook。model 处理仍由原 Harness 的 request/usage/停止预算规则约束；stage 不是绕过预算的新调用通道。

### 4.3 Git/worktree 与非工具入口

除 enter/exit 工具，还覆盖 `packages/cli/src/serve/routes/workspace-git*.ts`、`workspace-github-prs.ts`、`packages/cli/src/serve/server/git-branch-ops.ts`、Shell Git 与 Agent/Workflow 的 worktree 创建。所属 runtime 的 cwd/env/trust/文件系统必须一致，unknown/removed/draining 不能回 primary。

Runtime 的只读操作固定为 git status/diff/log/branches、GitHub PR list/default-branch；变更固定为 checkout/branch-create/push/pull（含 fetchOnly/rebase）/commit、PR-create、worktree prepareCreate/commitCreate/inspect/remove。参数复用原路由 DTO，并绑定可信 repoId/worktreeId、expectedHead、expectedStatusDigest、owner 和 generation；路径由 Runtime 解析。PR/Git 网络凭据只交对应 provider，不交模型密钥。Shell 仍执行原命令与权限，不借新 API 绕过对 push、清理 dirty tree 等授权。

Session 所属 worktree 操作使用本专项 workspace_operation 与 OperationGrant。没有 Session 的工作区路由使用 `WorkspaceOperationGrant`：WorkspaceKey（tenantId/workspaceId）、generation、operationId/domain/operationRevision、ownerId/resourceScope/lease。所属 workspace 控制 owner 保存维护操作记录，RuntimeReceiptStore 保存对应物理结果；不虚构 SessionKey、临时启动 Harness 或挂到现存 Session 的事实日志。其物理 key 为 `(WorkspaceKey,generation,effectId,phase,effectRevision)`，与 Session 操作分型隔离；同样受 per-operation gate、workspace 维护 barrier、物理 owner 和共享容量约束，重命名/checkout 不能与其他 Session 写入并行破坏 context。

创建 worktree 顺序为受理计划/固定 ref 与目标 path→实际 git 创建→写 owner marker 与 sidecar→核验真实对象→登记可用 handle。marker/sidecar 失败不能作为完整拥有成功回执；按原计划恢复补写，或在确认仍属于本操作且无用户变更时清理。移除前检查 owner、HEAD、dirty digest、活 child/下载/文件请求，禁止删除他人的工作树。Git 多步操作不是数据库事务，已完成步骤明确记录；push/PR-create 已发生而 ACK 丢失时查原远端 ref/PR identity，不自动重复网络副作用。

enter_worktree 保留返回路径语义。只有明确 cwd 切换才提交 context_change：先暂停新工作、等旧 generation 在途调用/后台文件 owner 进入安全边界，再绑定新的 read cache/fileHistory/ignore/LSP/permissions/Runtime capability；新 generation 提交后才准入。无法停止共享写者则 busy/recovery_blocked，不让新旧 cwd 混跑。

<a id="csi-volume-serialization"></a>

### 4.4 CSI 同卷串行：从首次访问到模型消费提交

本节是 Hosted 首版的补充安全门槛，待实现、未验收。物理 fencing 与停止/卸载证明的完整契约规范性引用 [Endpoint 恢复设计](2026-09-21-managed-runtime-endpoint-recovery.zh-CN.md)第 17 节；本节固定工具/history 与该屏障的连接点，不另造锁服务。

- 一个 Workspace 首版使用一个可写 CSI 卷，要求 ReadWriteOncePod（RWOP）。ReadWriteOnce（RWO）只限制节点，不保证单 Pod，不可替代 RWOP。
- 可信 Registry 解析物理冲突键 `storage backend 域 + CSI driver + opaque volumeHandle`，并保存 cluster、PV UID、PVC UID 及绑定关系作为解析证据。客户端不得自报键；无法可靠识别的重复 PV alias 拒绝注册。tenant、Session、generation、Workspace alias、子目录、挂载路径和同卷 worktree 都不能拆锁。不同真实物理卷可以并行，首版不做目录级并发，也不新增 worktree 创建功能；第 4.3 节仍是既有全量目标。
- 占用由 Java 既有 Workspace/Broker 存储持久化，短事务 CAS；不持数据库事务跨 RPC。阶段为 `reserved → active → draining → released`，另有 `blockedReason`；阻塞不清 holder。记录原 Session/turn、operation、binding、revision，以及 history/停止/卸载证明引用。qwen 仍是 Session history/checkpoint 的权威，Runtime 仍提供物理证据。
- 占用 lease 仅授予协调责任，不是自动解卷锁计时器。控制者失联后接管的是调查责任，不是新执行权；新的 DB epoch、grant 到期或人工接受 UNKNOWN 风险均不释放物理占用。新增记录和 envelope 必须封闭 schema、版本/能力协商，不能向 strict Tool v2/attestation v2 或 InvocationContextV1 偷加字段。

执行与交接必须保持以下顺序：

1. 模型先行，无工具推理不取卷、不等卷。qwen 提交原工具意图后 Java 核验持久 Workspace binding 并预留占用；不访问 Workspace 的环境预热可并行。初始化若先于工具意图发生且可能访问 Workspace，必须先通过原受理初始化 operation 取得同一占用，不能假装预热而先挂卷。
2. 在首次可能访问 Workspace 的初始化、history bind、prepare、快照或读取之前取得占用。Broker 核验真实 Runtime、挂载和 ContextBinding，并安装既有 gate 后才开放访问；restore 也没有先读卷再补锁的例外。
3. 同一占用连续覆盖首次初始化/快照、history bind、prepare、读取、审批等待、最终派发和执行。审批等待不得先释放占用，再拿旧快照/批准继续。若原操作被取消并安全退场，后续只能走新的合法受理与重新校验，不能复用旧 prepare 状态。
4. 轮末封新派发、排空所属进程及后代和输出，持久收件原结果、必要媒体/备份；qwen 提交对应 history/checkpoint，包括实际模型消费的结果与消费位置。单独 execute 成功、回执 ACK 或展示卡片完成都不足以释放；模型消费/history 提交未知则保持 `draining` 并记录 `blockedReason`。取消/关闭后禁止唤醒模型，改由原窄资格持久结算结果与明确不再消费的状态，不为释放伪造模型消费。
5. 同 Session 可以保留 idlePod，但仍持有该卷占用；另一 Session 请求时必须先取得原 Pod/所属进程的可信停止、正常 CSI 卸载及必要存储交接证明，并核验 history 结算，再 CAS 转授。不得让不同 Session 的 Runtime 同时保持同卷热挂载；空闲、无当前工具、lease 到期均不豁免。
6. Pod NotReady、force-delete、API 删除成功、VolumeAttachment 消失或观测超时不能单独证明停止。分区按 Endpoint 第 17 节保留屏障，只有可信节点物理 fencing 或后端撤销旧写通道的可靠证明后，才继续核验卷/history；停止证明仍不证明外部副作用未发生，原 UNKNOWN 继续对账。

等待卷的其他 Session 处于准入等待，不制造假的执行 UNKNOWN；H 阶段共享写 child 首版不开放，既不借父锁，也不允许父持锁等待同卷 child。复用原调用 status/cancel/收件，不为了查询创建新 Runtime、重新 prepare 或 execute。不能证明安全交接的 CSI/profile 关闭自动接管，不改集群 force-detach 来绕过。

## 5. C06：完整内容访问、媒体与保留

### 5.1 内容身份和访问

资源 registry 按存储 §2.1 把 DurableRef 绑定 session_owned 或 workspace_owned、生产者 invocation/operation、原 Runtime generation、用途、访问策略、实际后端和持有引用。Session 资源表保存自身私有资源及已获授权的 workspace 引用；workspace 配置和显式 pin 不从属于来源 Session 的生命周期。resourceId 不携带路径；digest 只证明 bytes，不是授权。不可猜测 ID 不代替权限检查，也不能以全局内容 hash 提供跨租户存在性查询。

内部 `resource.read` 接收 ref、offset、length、purpose；从可信连接验证 owner/用途和当前保留状态。每片至多 1 MiB，manifest 每页最多 256 项/1 MiB，分片有摘要，完整读取校验总长度与 digest；range 不能错误声称已核验整个内容。旧小 inlineData 保留；大媒体/备份走已协商资源协议，不把原工具参数上限悄悄变成任意文件读取能力。

新增普通 owner-routed `GET /session/:id/artifacts/:artifactId/content`，沿现有 client/Session 读授权与资源下载能力检查，参数不接受任意 path/URL。返回安全 MIME、Content-Disposition、range/总长；无法证明可读的 metadata 不返回下载成功。独立 HTML 预览 origin 与 sandbox CSP 防止生成脚本获得 daemon 受信 origin；不以 file:// 或 Runtime 路径代替浏览器内容 URL。新接口纳入[客户端适配](managed-agent-client-surfaces.md)，旧 artifact 列表/登记/删除及输入 attachments 接口不变。

workspace/external_url/managed/published 四类仍有不同语义：workspace 表示当前文件身份，读取发现身份变化返回 changed，丢失返回 missing；managed 内容是不可变受控副本；external_url 只登记，不自动抓取；published 引用实际发布回执。metadata-only 恢复为 unverified，不能显示已可下载。文件 symlink、祖先目录和读中替换检查在真实 Runtime；同内容给另一 Session 使用时，私有内容建立目标独立副本，workspace_owned 内容建立目标独立授权持有项，不能仅转发裸 ID。这里的资源内容类型与 registry 的生命周期 owner 是不同维度。

### 5.2 媒体处理和预算

Runtime 负责 Read/Zoom 的物理校验、PDF info/text/render 和图像变换；Harness 根据真实模型 modalities 处理媒体与调用模型。新增 `PdfReadCandidate` 正文包含 sourceRef/sourceDigest、页码与页图资源 manifest、fallbackTextRef、原转换参数/能力 revision。完整候选可以分页传输，但 Harness 必须等全部选定页转写成功、结果不含 inline/fileData 后才替换文本 fallback，不能以首个成功页代表整份 PDF。

合法空 base64 是 0 字节，image/audio/video/native PDF 均保持原 native 结果语义。DisplayImage 仅消费展示内容，不能在恢复时把 display-only 图像加进模型。HarnessCheckpoint 引用完整模型内容和资源集合；现有内存图片标记/短 hash 不是可恢复、可授权存储。

限额唯一来源为存储规范：原 Runtime input 256 KiB/depth 64、普通结果 8 MiB、媒体 64 MiB 减 64 KiB、ACP frame/queued 总 bytes 64 MiB 与 256 项均不提高。分别计量 decoded bytes、wire bytes、queued bytes、模型 in-flight bytes、持久资源配额；小 inline 也须预留并发容量，大合法结果转 refs，窗口背压不能丢已完成回执。存储沿有效 workspace 磁盘预算并共用 64 MiB 结算预留，不按每个 Session 重复预留或无限接收。

原生执行成功后封装/传输超限仍保留原 physical status 和资源副本，通过 status/reconcile 交付引用；不能反复 execute/status/cancel 抛错却丢掉释放依据。对于可恢复模型历史，provider 适配记录 modelInvocationId→resourceId 与实际转换后的 bytes/digest；重启、压缩和再次引用从受控资源重建，不在每一条事件重复整段 base64。Runtime、Session 资源、provider payload 三层分别验收，不能拿某一次 >8 MiB 成功当完整上界/并发证明。

### 5.3 生命周期、pin 与回收

资源状态为 staged→committed→retired→collected。staged 必须有 producer owner；Session 提交结果前先保全唯一内容。Runtime 在 Session 接收完整结果/必要媒体与备份、提交关联 checkpoint 且没有其他 child/等待引用前不得 release 唯一副本。release 解绑执行 lease，不删除用户 workspace 文件或已发布页面。

全量目标明确实现有配额的 `pin/unpin`：ephemeral 随原 ephemeral owner；restorable 随可恢复 Session/分支；pinned 使用显式用户保留引用。pin 先由 workspace 内容 owner 校验并持久化不可变受控副本和用户保留项，再在 Session 的 resource domain 引用其 receipt；跨 owner 登记/ACK 丢失沿原 operationId 对账，不存在 Session 先 ACK 后资源尚未保全的窗口。按实际长度计入所属 workspace 有效存储预算，无法预留则 resource_limit，不退化为空 metadata pin。外链不自动下载，无法取得实际内容的对象不可 pin 为“可恢复内容”。现有 capability 未启用时继续明确拒绝 pinned，不能仅放开旧 validator。

Session 关闭保留 restorable/pinned；archive 不削减引用。删除 Session 释放普通历史引用；pinned 只有显式 unpin 或用户明确选择连同已固定内容一起删除才释放。pin 的持有者从一开始就是所属 workspace 内容服务的用户保留项，Session domain 仅引用其 receipt；删除来源 Session 不删除该保留项。该内容服务提供受权的 list/read/unpin handle，模型外操作用 WorkspaceOperationGrant，不复制 Session 历史。取消、fork 或源 Session 删除不默默 unpin。下载/模型正在消费时先 retire、停止新读取，已有授权流排空后再回收；已撤销读取授权的流立即终止，其句柄实际退出后扣账。

GC 仅针对零持有引用、零 in-flight、无未决物理操作/恢复依赖的托管内容，执行前再次核验 revision；每个 fork 有独立引用，源删除不能破坏目标。用户 workspace 文件和远端 published 内容不随引用 GC 删除，远端 unpublish 需独立授权和实际回执。无自动用户历史 TTL；日志引用和原调用摘要不能因 Runtime 缓存过期消失。

发布 hold、fork/export pin、在途 reader 及调查/legal hold 都是回收前必须核对的保留依据；跨 owner 发布成功但引用 ACK 未结算时不清唯一副本。删除来源 Session 不消除这些依据。UNKNOWN 不能成为无限期保留敏感数据的法律依据，应进入受权调查/保留策略处理，但不能以超时 GC 伪造已结算。备份、快照、对象版本、key 撤销与供应商清除遵从[存储规范](managed-agent-session-storage.zh-CN.md)第 2.3、2.4 节。

## 6. C13：checkpoint、diff 与物理 rewind

### 6.1 可核验计划

文件历史 backup manifest 必需 backupId、原 owner/workspace、规范相对路径、前像存在性、digest/byteLength/mode/identity proof 和内容 DurableRef。Session 保存 manifest/revision，恢复 bind 先校验实际 bytes；缺失备份不能静默选更旧版本。Shell/Git/外部进程产生的任意工作区变化不当然可追踪，diff/rewind 明确列出实际纳入文件和未覆盖范围，不能宣称整个 workspace 自动可撤销。

内部命令固定为 `prepareRewind`、`commitRewind`、`readRewindStatus`。prepare 返回 `RewindPlan{operationId,sourceHistoryRevision,sourceProofRef,targetPromptId,targetRecordId,mode,filesManifestRef,artifactPlanRef,planDigest}`；mode 为 conversation 或 conversation_and_files。文件项含 path、current/target FileProof、targetBackupRef、restore/delete/unchanged；资源清单有完整缺失/冲突结果。prepare 只读历史和工作区，可在受控资源中保存计划，不截断聊天、不恢复文件。

执行资格为原 history operation 的 OperationGrant，授权绑定 planDigest/target/mode/resourceScope。history gate 保持现有 busy 同步准入语义，默认拒绝在途 turn，不偷偷取消其他人的任务；物理改文件还必须对该 workspace 所有受控写者取得维护 barrier。其他 Session/Monitor/child 仍可能写入而无法排空时拒绝。外部编辑器不受 gate 控制，应用及补偿时逐文件再次校验身份和 digest。

### 6.2 提交、取消与恢复

1. 取得维护资格，核验唯一 writer、完整 source revision、目标 active boundary、Runtime history 和备份闭包；不能凭 turnIndex 猜压缩后的目标。conversation-only 同样固定原 revision，但不改工作区文件。
2. 提交 history_rewind 的 prepared/applying 事实；Runtime 在每个效果前同步 intent、undo 副本和目标 staging。物理账本保存明确 phaseOperationId 与每个文件步骤，不以 Session 事件缺失推导未执行。
3. 每个文件在相同文件系统内原子替换/删除并保存前后证明，目录变更同步；跨文件不是瞬时物理事务，外部程序可以看到中间状态。运行平台须满足恢复专项的身份/同步 profile，跨卷不能假装 rename 原子。
4. 全部目标文件及必要 artifact/backup refs 核验完成后，authority 在同一 history_rewind 事务提交 committed 正文与目标 projection 绑定。仅可引用覆盖目标且不含已撤销状态的既有 checkpointRef；找不到且满足存储 §2.2 的已验证、无待续执行条件时，使用 checkpointRef=null、restoreBasis=history_rewind、restoreProofRef=该已提交操作 proof，提供完整目标 active 历史/恢复基础。不能把资源缺失或 checkpoint 读取损坏作为 null 的理由。维护 OperationGrant 无权制造 checkpoint.committed，也不能重写旧 checkpoint 的 coveredSequence。旧聊天原始事实不物理截短；新分支只投影目标链，旧 continuation、待消费结果和被撤销 child/预算引用不得混入。下一合法 Harness 切换模型 history、录制父链、文件历史和 artifact timeline 后，先提交 before_model checkpoint 再执行；原维护 barrier 在目标闭包已提交、现存视图已确认或已隔离后释放，不为生成 checkpoint 伪造模型 activation。
5. 若物理阶段失败，聊天投影不先切换。Runtime 按 undo 补偿已更改文件；先比较当前文件是否仍等于本操作后像，发现外部新写就停止，保留 affected files 和 recovery_blocked，不覆盖用户后来内容。回滚全部完成仍是本次 rewind 失败，不是成功到达目标。
6. prepared 尚未改文件时可结算取消；applying 中取消先持久请求，等原操作在安全阶段收敛为 committed、rolled_back 或 recovery_blocked。客户端 deadline 不释放 barrier/原物理 owner。确认已完成仍保留成功，而非把晚回执改成 cancelled。
7. 崩溃恢复核验原 RuntimeReceiptStore、文件当前前后像、Session commit marker。物理已完成且未有 Session 提交时，只在目标仍完全匹配且 source revision 未改变时幂等补提交；否则阻塞，不重新覆盖文件。Session 已提交则恢复其投影；丢 ACK 按同 operationId 返回原结论，禁止新 restore。未知 owner 保持关闭/删除屏障。

只读 snapshot/diff 也从所属 Runtime 和不可变备份资源取得，不能用 Gateway 本地磁盘模拟远端。备份/undo 在恢复操作及 fork 引用结算前保留；成功后的后台 GC 沿资源协议，不成为返回成功的必要同步清理。

### 6.3 268 项映射和旧公开返回

保留[268 项公开成员映射](managed-agent-session-method-map.md)中的两个原方法：getRewindSnapshots 返回 `{snapshots: RewindSnapshotInfo[]}`，rewindSession 返回现有 `Promise<RewindResponse>`。现有 request 的 promptId/rewindFiles、同步 busy/closing 准入和已派发等待真实回复的队列语义都保持；不把内部 RewindRecord/CommitReceipt 直接替换到 REST/ACP/SDK。

```ts
interface RewindResponse {
  rewound: boolean;
  targetTurnIndex: number;
  filesChanged: string[];
  filesFailed: string[];
  warnings?: string[];
}
```

legacy 继续原 best-effort 适配，既有 void rewindRecording 不被全局改成强提交 Promise。Managed 的 `rewound:true` 只来自上述 committed、目标投影和必要物理/资源闭包都完整的结果；不能沿用“ACP success:true 或 filesFailed 为空”作为新能力成功证明。确定的逐文件失败可适配成 rewound:false、实际 filesChanged/filesFailed 和有界 warnings；filesChanged 表示该次操作实际涉及的改动，回滚结果/未恢复范围在 warnings 说明，不伪造文件名来表达存储错误。

存储提交不明、缺失必要 artifact/backup、owner 未隔离等无法形成确定旧结果时，旧 Promise 用既有错误通道拒绝并保留内部 recoveryRef；不返回形状正确却含义虚假的成功。结果已 committed 而仅有非关键展示警告时可保留 warnings。客户端只在真实 committed 后发布成功的 session_rewound 及切换投影；明确失败/blocked 不能以旧 success:true 冒充新完成能力。

## 7. C14：fork、转换和旧会话维护

### 7.1 四种动作分开

| 动作               | 原数据与目标 owner                                                         | 工作区副作用                                                |
| ------------------ | -------------------------------------------------------------------------- | ----------------------------------------------------------- |
| load/resume        | 原 Session，只能用严格持久 owner；无 owner 的完整旧历史按原规则推导 legacy | 不重放旧工具，不隐式换 engine                               |
| 同引擎 fork/branch | 源只读、新 Session ID、保持源 engine                                       | 复制历史与资源/备份引用，默认不恢复工作区文件               |
| rewind             | 原 owner 不变，提交目标分支投影                                            | 只有显式 conversation_and_files 才物理恢复                  |
| convert/import     | 新目标 ID，显式选定 targetEngine 并重新验证能力                            | 不迁移活进程/票据，不重放源工具；内容复制与文件恢复分别授权 |

同引擎 fork、跨 engine convert 共用内部 `planSessionCopy`/`commitSessionCopy`/`readSessionCopyStatus`，kind 为 fork/convert/import。原 resume/fork 公开签名不增加隐式 engine 切换；转换是单独明确请求。sourceId、atRecordId/已提交 sequence、targetEngine、copyMode（complete 或 history_only）固定到计划；targetSessionId 从第一次 reserve 起稳定，重复命令返回同目标。

### 7.2 一致快照到目标发布

1. 源由所属 authority/legacy 存储适配取得一次一致只读快照，包含文件身份/完整摘要或 committed revision、严格 owner、active branch、资源清单。owner 验证与内容读取必须使用同一 snapshot；活 writer 在安全边界提供 sealed proof，不能先校验再二次读取另一个时刻。只接受工具调用/结果完整的已完成边界，未决调用不能用合成结果补齐。
2. CopyPlan 包含 sourceProofRef、源/目标 engine/format、目标 config/definition 兼容摘要、分支边界、history/schema/ID 映射与完整资源 manifest。坏 owner、冲突 owner、未知格式或损坏中段只能只读诊断，不能以转换修复为可执行会话。完整无 owner 的合法旧历史仍是 legacy。
3. 复用 SessionService 的 active-chain/side-artifact/checkpoint/forkedFrom 逻辑，显式映射 session/prompt/call/child/artifact/backup owner 和父 UUID。历史原调用 ID 作为 provenance 保留，目标后续新执行使用新身份；provider resume/cache ID、pending permission、活 Monitor/cron/agent/workflow 不复制为可运行状态，完成记录只作为历史投影。源定时任务的迁移是单独调度域操作，不附带在 fork 中。
4. 资源 complete 模式要求所有承诺的媒体/产物/备份可访问且 hash 一致，任何缺失拒绝发布完整目标；history_only 是显式选项，保留缺失 manifest 并标相应 artifact/rewind unavailable，不宣称可恢复闭包。Session 私有内容按目标独立副本重写 refs，workspace_owned 内容先登记目标独立授权持有项再引用；不得留下随来源 Session 删除的裸 ref，也不能靠原临时路径。
5. 目标 reserve/no-clobber 后 staging 目标内容、sidecars 和资源，先同步内容与目录，再发布可用 transcript/marker。Managed 目标使用存储规范的 header、单 writer、schema 3 和 initial history_copy commit；legacy 目标使用严格 legacy 格式/目标 owner，新增 provenance 只通过已有可兼容字段投影。目标 owner 只出现一种；不得直接复制源 owner 记录造成双 engine。
6. Managed 目标的 copy 正式状态由预留目标 authority 的 history_copy domain 投影；它在发布前持有同一目标日志，发布后继续该唯一日志，不另建 copy Session journal。legacy 目标不写 Managed event，其创建控制归属 workspace 维护 owner，以 WorkspaceOperationGrant/同 operation ID 和目标 proof 保存创建回执，Session 仍只含原 legacy 格式。Runtime 的跨文件复制/发布 journal 只记录物理步骤。源 Managed/legacy 均保持只读，不向源历史追加 copy outbox；需要跨 owner 取得内容引用时由资源服务按稳定目标 operation ID 授权/去重。目标的创建/资源接收不承诺跨存储原子事务，目标提交 ACK 丢失先按 reserved target ID/proof 查询，不能新建第二目标。恢复清理只删除本次未提交 staging，绝不覆盖已有目标或源。
7. 目标发布前实际配置/能力做无执行校验，不运行 Hook/MCP/模型或旧工具；失败保留源不变。目标首次 bootstrap 重新验证绑定快照及真实初始化，漂移则明确 blocked，不回退引擎。Managed 目标无兼容 checkpoint 时，只有满足存储 §2.2 的完整可执行基础才返回 restoreBasis=history_copy、restoreProofRef=已提交 copy proof、checkpointRef=null；history_only 的缺失项不能被此路径洗成完整恢复能力。下一有效 Harness 先提交 before_model checkpoint 才执行新 prompt，不续源 provider 请求；legacy 目标沿原恢复协议。

history_copy provenance 固定为 source Session/engine/revision/boundary/proof、target engine/format、copyMode、resource manifest 与 ID 映射引用，不新增 `session_conversion` ChatRecord subtype。历史可复用旧 sealed 前缀的情况遵从存储规范；若新 Session ID/owner 需要重编码，保留原 sourceProof 与不可变源副本引用，不声称目标每一行与源字节相同。既有 Managed 的容器升级可在原 owner 下保留字节前缀，属于存储格式升级，不能借此原地切换 engine。

回退方式是继续原 Session 或再明确创建转换目标。Managed→legacy 也完整执行本管线；legacy 配置不能接管原 Managed。转换不会授予源工具的旧权限，也不继承不可转授的客户端或发布凭据。

### 7.3 目录、归档、删除、导入与导出

列表/标题/历史从所属逻辑 Session 的持久目录投影；Tool-only Runtime 内部 Session 不作为普通会话重复出现。cold 查看不创建模型 loop；live 修改继续按 owner bridge/workspace 路由。title 的唯一值由 session_metadata 提交并投影为原标题；若伴随物理维护，history_maintenance 与它在同事务关联结果，不保存第二份可变标题权威。

archive/unarchive 保留 owner、全部资源持有引用和必要 sidecars；按存储 lifecycle 的 closed↔archived，不自动跑模型。批量逐项保留成功/errors 形状。活 Session 的 archive/delete 先 drain 其原工作并核验实际物理 owner；unknown 不能提前 closed/deleted。文件移动仍使用当前文件快照、assertCanMutate/assertCleanupOwned 与平台 no-clobber/身份检查，不能为新日志绕过这些保护。

删除请求先在原 authority 持久受理维护计划并封新输入、派发和普通读取；ACK 与在线撤读都不等于 deleted。严格保持 `idle/active/recovery_blocked → closing → closed`，再 `closed/archived → deleting → deleted`；原工作取消并可信停止后才 closed，不从活动态直接跳 deleting/deleted。核对结果交付、reader/pin/fork/export、发布 hold 和 legal hold 后，持久注销本 Session 引用及删除 tombstone，再由真实 owner 条件清理可回收资源、transcript/sidecars。系统原 binding/operation 的迟到收件、查询和清理保留窄资格，不恢复用户读取或唤醒模型；UNKNOWN 不清唯一证据。

tombstone 是同一 Session authority 的终态存储，不建立可继续执行的另一份历史；受控元数据和幂等证明保留到必要关联/恢复操作结算。崩溃按原 operation/proof 恢复，没有 tombstone 提交证明不能因文件缺失宣称删除完成。Session 只释放自身引用，不删除共享 Workspace/PVC；整体 Workspace/tenant 删除需独立权限和全引用核对。用户文件、pin、远端发布仍按第 5 节处理。在线撤读、执行停止、在线清理、备份待清理、hold/供应商待确认和完全完成分开投影，不悄悄重定义原 deleted；详细完成度和灾备防复活契约见[存储规范](managed-agent-session-storage.zh-CN.md)第 2.3、2.4 节。

export 明确区分可读文本和可恢复包。文本仅投影选定分支，不能把已遮蔽内容重新送模型；包 manifest 包含 owner/格式、源 proof、活动边界、内容/备份 digest/length、缺失项和 copyMode，去除凭据、连接状态及不可转授授权。import 验证条目名称/路径穿越/symlink、条数、大小、hash、版本和资源配额，再以新 Session ID 执行复制管线；禁止执行归档内脚本或信任包自报绝对工作区路径。legacy 原导出错误/返回经适配保留，新可恢复包只在能力协商后开放。

## 8. 实施与验收 T01～T07

下表全为待实现验收，不能累加已有九类工具、媒体或只读备份测试后填写“全部通过”。先实现 storage/authority 与 Harness/gate，再在 F2 接全工具/内容、F7 接物理历史与复制。自动任务、MCP/Hooks 等工具实现使用各自专项的领域事实，本文 T01 负责检查注册和结果归属不遗漏，不重复宣称其专项行为已通过。

| 编号                   | 操作与通过条件                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T01 完整工具目录       | 对照真实 global legacy 与实际 Managed host 的 47 项注册，覆盖主/child/workflow、bare/SDK、allowlist/eager/deferred/aliases/feature/交互条件和 ImageGen 独立 factory；所有原 schema/权限/结果/终止条件一致。每项明确 Session/Harness/Runtime producer，未知执行计划不能悄删或在 Harness 原生执行                                                                                                                                                                                        |
| T02 分段与长期工具     | 真实 WebFetch HTML/二进制/redirect/cache/raw fallback、WebSearch provider gate/usage、ImageGen provider bytes→Runtime 文件、Artifact local/host/OSS 回执/丢 ACK；LSP 全部十二查询/单请求 cancel/sibling 保活/最后 owner 退出；Monitor 跨 turn/stop/close；Workflow 子执行/worktree/已提交 prefix 恢复。观测 Gateway/Harness 无错位 fs/spawn、Runtime 无模型请求/模型凭据，阶段恢复不重复模型计费、Hook、发布或子派发                                                                   |
| T03 完整媒体           | image/audio/video/native PDF/扫描 PDF/Zoom/DisplayImage，空媒体与所有页失败回退；核对 Runtime→Session→真实模型 payload 的完整 bytes/hash 和模型 final，不能仅验证请求成功。覆盖 Read/PDF 原生取消、ToolResult/显示/模型内容分别保持、源 worker 消失后已接收资源恢复                                                                                                                                                                                                                    |
| T04 内容访问和释放     | 1 MiB chunk/manifest、8 MiB 控制及普通结果、64 MiB frame/队列、base64/UTF-8/并发/slow consumer 边界；原结果超限仍有可收件 physical outcome。跨 workspace/client/Session 越权、range/full hash、symlink/读中替换、HTML origin、changed/missing/unverified；pin quota/unpin、fork 后源删除、下载中 delete/撤权、GC/CAS/唯一资源和所有 lease 清理                                                                                                                                         |
| T05 rewind 公开兼容    | 真实 write/edit/delete/notebook、conversation-only 与 files、当前/历史边界；旧 snapshots/RewindResponse/busy/closing/等待/错误时机保持，Managed 完整 committed 才 rewound:true。验证目标 projection 与兼容旧 checkpointRef/null 的完整恢复基础，OperationGrant 不产新 checkpoint，下一合法 Harness 不带入撤销 continuation/结果/child。备份缺失、artifact 不可恢复、并行 Session/Monitor 写者 busy、部分文件失败与回滚都不提前切聊天或发成功事件；legacy 原 best-effort 不被冒充强提交 |
| T06 物理恢复和 Git     | 每个 rewind/undo 的 sync/rename/Session marker 及投影视图 ACK 前后故障与取消；结果为核验完整目标、完整回滚或明确 blocked，外部新写不被补偿覆盖；无 Harness 维护完成后冷恢复不需要伪 checkpoint。同仓 Git/PR/worktree 的创建、marker/sidecar 失败、dirty/remove/context generation、远端 ACK 丢失、无 Session 路由归属与各平台 process owner；实际旧 PID/组/目录/资源未结算时不得放开 gate，不能把 wrapper 日志或 deadline 当真实终态                                                   |
| T07 fork/转换/生命周期 | 真实 legacy/Managed 各多轮历史，在当前和历史安全边界 same-engine fork，再双向 convert、完整包 export/import；源 bytes/owner 不变、目标唯一/正确格式与 owner、call/result 配对、资源/备份/ID 映射可恢复、冷 resume 新 Read 成功。坏 owner、未决 call、资源缺失、unsupported config、target 冲突、每个 copy 提交窗口故障均保留原数据且重试不重复目标/工具；title/archive/unarchive/delete/pin、旧格式前缀和 schema 3 认证关闭分别核验                                                    |

实现时定向单测验证封闭 DTO、合法转换、ID/CAS 和旧适配；真实 E2E 使用自有 root/端口/模型端点与明确授权的发布目的地。每组保留源码/实际 dist/依赖/夹具指纹、exact exec 到终态、实际 PID/startIdentity/PGID、输入/输出与原 transcript 证明、全部资源 bytes/hash、模型 final、目录/端口/lock 原文及清理。sealed schema 3 凭据按存储契约验证，不以锁文件存在判断泄漏；物理效果未知保留失败，不因观察超时重启或清除证据。本轮只完成文档整理，没有执行上述测试、构建或产品操作。

<a id="supplemental-acceptance"></a>

### 8.1 补充设计阶段与正反验收矩阵

C/E＋W0＋必要 F 先交付同卷占用、正常交接、原执行查询、丢 ACK/失联阻塞和 Hosted 边界；任何 ACL 入口开放时同时满足撤权门槛，不等待 UI。D 只承接对账、撤权/删除完成度的公共投影与旧客户端兼容，不推迟内部证据/authority 门槛。G/W1/O4 交付完整恢复集、安全水位及备份删除，详见存储规范和[存储事件架构](2026-09-20-managed-agent-storage-event-architecture.zh-CN.md)第 9.1～9.4 节；未验收前关闭相应恢复/GC。H 的共享写 child 后置。上述阶段标签与原 F2/F7 全工具/历史目标并存，不把后者提前标成首版验收。

| 用例                 | 正向通过条件                                                 | 反向拒绝条件                                                                |
| -------------------- | ------------------------------------------------------------ | --------------------------------------------------------------------------- |
| V01 物理身份与 CAS   | 同卷 alias/目录/generation 收敛一个 holder；独立卷并行       | tenant/Session/worktree 拆锁、未识别 PV alias、RWO 替代 RWOP 均拒绝         |
| V02 惰性访问与审批   | 无工具不取卷；首次初始化/bind/prepare/读取前占用并跨审批保留 | 先访问后补锁、审批放锁后旧快照继续、spawn/restore 旁路均拒绝                |
| V03 收件与 history   | 原结果/资源及实际模型消费位置持久提交后安全退场              | ACK/卡片成功但 history 未提交、UNKNOWN、迟到冲突不得释放或重放              |
| V04 idlePod 交接     | 原进程/后代停止、卸载与 history 证明齐全后 CAS 转授          | 跨 Session 热挂同卷、lease 超时/force-delete/Attachment 消失代替停止均阻塞  |
| V05 Hosted 与 Legacy | 四工具闭环只读所属 Runtime；普通 Legacy 兼容选择仍有效       | Harness 同路径旁读、compaction 读本地 Workspace、未验收工具 fallback 均拒绝 |
| V06 child/worktree   | 首版明确拒绝共享写 child，保留既有全量目标                   | 借父锁、父持锁等同卷 child、同卷 worktree 并发不开放                        |
| V07 删除与保留       | 合法 close/delete、独立引用、窄收件与分项完成度可核验        | ACK 直接 deleted、源删除破坏 fork/pin/发布 hold、共享 PVC 被删均失败        |

每项必须同时证明成功路径与拒绝路径，不以全部 blocked 冒充通过；V06 的正向是 profile 准确拒绝未开放功能，不宣称 child 执行成功。后续定向 Java/TS 与真实 MySQL/Kubernetes/CSI 验证保留真实进程、挂载、结果 bytes/digest、模型消费和 history 提交证据，H2/fake Kubernetes 不替代平台语义。本轮仅文档校验，矩阵未执行、能力未验收。
