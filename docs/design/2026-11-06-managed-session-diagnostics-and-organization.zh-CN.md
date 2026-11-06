# Managed 会话诊断

[English](2026-11-06-managed-session-diagnostics-and-organization.md) | [简体中文](2026-11-06-managed-session-diagnostics-and-organization.zh-CN.md)

状态：已在本地实现并完成定向验证；完整 CI 验收仍待完成。日期：2026-11-06。调研基线：`1bac51b7d9`。本设计及[实施计划](../plans/2026-11-06-managed-session-diagnostics-and-organization.zh-CN.md)取代这些路径下此前范围更广的提案。为保持已有链接，文件名不变。实际验证与剩余缺口记录在实施计划中；本文不代表已部署。

## 1. 范围与现状缺口

本次工作分为三部分：（1）请求 context 与累计模型统计，（2）Skills/MCP 资源清单，（3）直接子代理调用关系。Managed 已有基本模型 context、持久化旧模型用量、任务分页和子会话历史。本次沿用现有 Session 权威，通过 Managed Public API 和 WebShell 补齐这些诊断视图。

第一部分包含两个不同视图：最近已提交主模型请求的 context，以及累计模型调用。资源清单描述已配置 Skills/MCP 和持久化发现结果，不是 Runtime CPU/RSS 或 blob 浏览器。Agent trace 描述已有调用关系，不是 OpenTelemetry，也不新增递归执行图。

不在范围内：会话组织、Sources/`record_source`、PR metadata、任意 metadata 更新、工具/文件/Skill 调用统计、新子代理执行能力、Runtime 预热，以及新增数据库表或 DDL。不得为交付诊断而扩大已有 CSI profile 的执行能力。

## 2. 所属代码与复用边界

| 领域           | 现有所属代码与复用边界                                                                                                                                                                                                                                                                                             |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 实际模型请求   | [Hosted 模型循环](../../packages/cli/src/serve/hosted-harness-model.ts)、Hook/压缩调用方和 ContentGenerator 边界；不使用进程全局用量                                                                                                                                                                               |
| Context 估算   | [contextCommand](../../packages/cli/src/ui/commands/contextCommand.ts)；仅提取 Hosted 所需的纯测量输入/逻辑                                                                                                                                                                                                        |
| 模型用量持久化 | [Managed hook activation](../../packages/core/src/managed-runtime/managed-hook-activation.ts)、main/hook usage 资源与现有 native commit 边界                                                                                                                                                                       |
| SQL 投影       | [ManagedExtensionRecordStore](../../packages/managed-agent-server/persistence/src/main/java/com/alibaba/qwen/code/managedagent/persistence/ManagedExtensionRecordStore.java)；沿用 `hosted_context_usage/latest` 模式                                                                                              |
| 基础 Skills    | [ManagedSessionSkills](../../packages/managed-agent-server/persistence/src/main/java/com/alibaba/qwen/code/managedagent/persistence/ManagedSessionSkills.java)；创建快照或固定 definition                                                                                                                          |
| Extensions     | [HostedExtensionSession](../../packages/cli/src/serve/hosted-extension-session.ts)、`config_install` 与不可变 bundle/contributions 资源                                                                                                                                                                            |
| MCP 观察       | [ManagedMcpCatalogService](../../packages/managed-agent-server/control-plane/src/main/java/com/alibaba/qwen/code/managedagent/catalog/ManagedMcpCatalogService.java)；复用安全展示投影，不复用无界历史查询或实时管理路径                                                                                           |
| 子代理关系     | [ManagedTaskService](../../packages/managed-agent-server/control-plane/src/main/java/com/alibaba/qwen/code/managedagent/session/ManagedTaskService.java)、任务投影和持久化 Session 谱系                                                                                                                            |
| WebShell       | [Managed provider](../../packages/web-shell/client/components/managed/managed-agent-provider.ts)、[ManagedSessionsPage](../../packages/web-shell/client/components/managed/ManagedSessionsPage.tsx) 与 [ManagedChildSessionView](../../packages/web-shell/client/components/managed/ManagedChildSessionView.tsx)   |
| 公开契约       | [OpenAPI](../../packages/managed-agent-server/contracts/src/main/resources/openapi/managed-agent-public-api.openapi.json)、[SurfaceRegistry](../../packages/managed-agent-server/verification/src/test/java/com/alibaba/qwen/code/managedagent/api/SurfaceRegistry.java)、生成的 WebShell 类型和 capability parity |

现有斜杠命令 Skill 查询会遗漏仅模型可调用的 Skills 和动态 extension contributions。现有 MCP catalog 在新尝试尚无 catalog 时可能保留旧的已发布 catalog。二者单独都不能描述完整配置清单。旧的累计 `models` 快照不能连续求和，也不能作为无界字典复制到新诊断资源。

## 3. 读取契约、权威与可用性

两种传输共用相同的授权应用服务：

| Public GET                               | WebShell POST                                         | 返回语义                            |
| ---------------------------------------- | ----------------------------------------------------- | ----------------------------------- |
| `/v1/agents/sessions/{id}/context-usage` | `/api/agent/web-shell/v1/session-context-usage/query` | 最近已提交主请求的 context          |
| `/v1/agents/sessions/{id}/stats`         | `/api/agent/web-shell/v1/session-stats/query`         | 归属当前 Session 的累计模型统计     |
| `/v1/agents/sessions/{id}/resources`     | `/api/agent/web-shell/v1/session-resources/query`     | Skills/MCP 配置与有界持久化发现结果 |
| `/v1/agents/sessions/{id}/agent-trace`   | `/api/agent/web-shell/v1/session-agent-trace/query`   | 直接子代理调用分页                  |

使用 `requireReadableSession` 与现有已认证 actor/Workspace 授权。跨范围、已删除或无权访问的 Session 保持不泄露存在性的 404。进入子会话还须验证持久化关系及子会话自己的读取权限。响应为私有且不可缓存；不返回私有资源引用、writer 凭据、命令/环境/密钥、原始 prompt/error 或宿主路径。

所有读取保持被动，适用于仍有读权限的 idle、closed、archived、recovery-blocked 和离线 Session。不获取、预热、attach、恢复或 resume Harness/Runtime，不调用 MCP 管理或重新发现。已删除 Session 不可读。尚无观察、已知零值、部分覆盖、旧证据和不支持的采集必须区分。

返回 Session 身份、schema/观察 revision 与明确可用性/覆盖信息。可能超出安全整数范围的 journal/snapshot 数值使用十进制字符串。一次请求的持久事实在同一个短 `managedAgentTransactionManager` 只读 `REPEATABLE_READ` 事务中通过普通 SELECT 读取。journal head 和引用的行/资源处于同一视图；`readRevision` 是持久化读取边界，不是 Runtime 实时观察时间。区分 `readRevision`、`snapshotRevision` 和已激活配置 revision。

## 4. 最近已提交请求的 context

在模型/工具选择和 context 安装之后，采集实际 prepared 主模型请求。仅随对应的持久主输出发布诊断快照；Hook 或压缩请求不替换主请求 context。更新请求失败或尚未提交时，不能让旧快照显得仍是当前值。快照绑定请求/attempt、所选模型、配置/context 和压缩事实；fallback、模型切换、压缩与恢复之后保留明确 stale/partial 原因。

当前持久化 context 指针记录失效状态，不保存详细原因历史。这些失效统一返回 `context_changed` stale 原因；本切片不宣称能在恢复后区分模型、配置和压缩导致的失效。

提供且仅提供以下独立本地估算分类：

- `systemPrompt`
- `builtinTools`
- `mcpTools`
- `instructionFiles`
- `memoryFiles`
- `skills`
- `startupContext`
- `messages`

Provider 报告的总量与本地估算分开。Cached tokens 与 input 重叠，不再加到分类中；reasoning/output 重叠沿用既有 provider 规范化语义。不缩放分类来强行匹配 provider 总量。缺少 provider usage 时保持不可用。使用实际所选模型/窗口和 Hosted 压缩策略；该视图不是下一次请求预览。

测量输入来自显式 prepared-request 组成和所属方提供的有界归因。在私有渲染丢失归因前保留必要标签，但不保存正文。不返回原始 prompt、文件内容、工具参数、Skill 正文或绝对路径。本切片保存有界的八类概要，不添加无界逐文件/工具明细、第二份请求 journal，也不加载 daemon 本地 Config。

## 5. 累计模型统计

一次 call 指一次 ContentGenerator invocation，不是一次用户 Turn，也不是每一次内部物理重试。记录 calls、provider 规范化 tokens、终态、已观察 timing/TTFT 与 backoff-retry 次数。终态为 `success`、`error`、`cancelled` 和 `interrupted`。缺失的 usage/timing 保持缺失；持久终态前中断的请求形成覆盖缺口，不能伪造 provider 账单。

来源分为 `main`、`hook` 和 `compression` 三类。辅助模型工作归属其拥有方来源。计入 profile 原本已支持的手动和自动压缩。父子 Session 各自拥有统计；不将子总量并入父总量，也不聚合无权读取的子会话。工具/文件/Skill 执行测量不在本切片内。

最多保留 16 个具名模型桶及一个显式 overflow 桶。整个 Session 最多保留 20 条近期样本，而不是每个模型/来源各 20 条。计数是累计值；近期样本是有界证据，不能再作为第二套计数来源。流式/非流式成功、错误、取消、Hook、压缩和重试退避共用同一采集语义。

Java 与 TypeScript 均使用饱和整数加法核对终态计数之和，包括 overflow 桶。已提交的畸形诊断按失败关闭处理：跳过损坏资源会丢失累计 revision 和费用预算基线，因此恢复不能清零累计后继续。

恢复时以最多八项的小批次读取 maintenance carrier 和统计，再按原引用顺序折叠。仍校验全部历史 carrier，保留同 revision 冲突检测和最高 revision 选择；限制的是并发数，不是总历史量。恢复生成的 Turn 结算仅在预算的 Session 和 Turn 身份均匹配时携带预算，否则该 carrier 的预算为 null，累计统计和原始输出计数保持不变。

采集同步写入内存。在现有 native `runSerial` commit 边界冻结待提交增量，从最新已提交 baseline 折叠，并分配 `snapshotRevision`。重试复用完全相同的冻结 bytes，不重新计算同一增量。后续排队 commit 必须从最新 baseline 折叠，防止嵌套 Hook/压缩工作丢失或重复计数。恢复时先还原已提交总量再接收增量；未闭合 native owner 留下 sticky coverage-gap 标记。终态重放与重复 commit 不再次递增计数。

## 6. 资源预算与持久化兼容

诊断 usage 资源保持在现有 UTF-8 64 KiB inline 上限内。分配如下：统计 40 KiB、context 8 KiB、envelope 加 budget state 12 KiB、预留 4 KiB。发布前按字节落实限制，覆盖 Unicode。Overflow/截断必须显式表达。不保存原始 prompt/error 或旧 `models` 字典。Budget 的原始输出总量作为独立标量 `rawOutputTokensTotal` 保留；规范化诊断 output 不能静默替代其语义。

填入实际 attempt 身份和 provider usage 后，再次落实 context 大小限制。仅用于诊断的 prepared-request observer 使用已有零 snapshot budget，同步测量临时借用的输入，不复制请求。模型窗口仅在正的安全整数时才视为已知；观察时间缺失时，UI 保持未知。

使用 main/hook usage v2 资源。自动压缩随 main terminal output 或 `turn.settled` 的 usage 引用提交。新的 maintenance v2 record 携带 `modelStatsRef`；candidate 在 `PostCompact` 之前发布，让后续 Hook 从正确 baseline 继续。已有活动 v1 maintenance 链允许以部分覆盖兼容收尾。保持 `context.compacted.tokenCountsRef` 不变。不新增 native domain、Stage H 家族或请求 journal。

复用 `ma_session_record` 保存派生 `hosted_context_usage/latest` 与 `hosted_session_statistics/latest` 投影。投影和资源引用随源 commit 原子更新。统一采用最高 `snapshotRevision` 规则阻止回退：main r1 引用、随后 Hook r2、再到旧 r1 引用，统计必须保持 r2。仅 Hook 快照不能以 Hook context 替换主 context。保持适用的资源闭包、保留与恢复检查；不需要 DDL。

先部署可读取 storage 1/2/3 的控制面，再启用 writer。首次写入 v2 诊断时，将持久 reader floor 推进为 storage 3；旧 worker 返回 409，不静默丢弃诊断。保留已有 CSI 行为与 `csi-files-retirement/1`。新增独立 manifest/proof 的 `csi-files-retirement/2`，用于理解诊断的转移，但不让原本不支持的手动压缩或其他执行路径变为可用。旧/v1 Session 保持明确的部分 legacy 可用性。

两个 CSI profile 仍只允许主模型 attempt 与 file-history 推进；Hook 和手动 maintenance 执行继续不可用。SQL inventory 识别共享诊断 carrier kind，而 context 投影仅使用 main carrier。依据固定的不可变 definition 和已启用 collector 选择 `/2`，不放宽 native activation proof 来推断版本。

## 7. Skills 与 MCP 清单

通过不可变创建快照或固定 definition 解析基础 Skills，再合并最近已激活 extension bundle 的 Skills。复用现有经过校验的 contributions manifest/parts reader。包含名称、描述、模型/用户可调用性和已知 base/extension 来源。共用 Skill loader 的 commands 保持独立类型。不虚构逐 Skill 的实时启用或已加载标记，也不重建从未导入的本地禁用 Skills。

直接读取当前 `config_install/hosted-mcp-settings`。旧 settings 给出所选 enabled/disabled/removed servers。对于 package 配置，当前为 active 时使用其 `bundleRef`；否则沿 predecessor 链查找最后 active，包含当前记录在内最多读取 64 条配置记录。只有确实到达 package 历史边界，才可使用首条 package 记录的 previous bundle 基线。检测断裂引用/环。超过预算时标记配置 partial/unknown，不能静默用看似完整的 base 清单替换未解析 extension 状态。

Active bundle 的 `independentMcpSelections` 保留独立服务器 disabled/removed 条目；`mcpServers` 是包含 extension servers 的最终启用合成集。保留两种含义。仅投影公开展示字段。Extension 归属来自实际 package contribution 映射，不猜测标识前缀。

最多扫描 256 条 `mcp_configuration` 历史记录，再取一条 sentinel 判断覆盖。使用已有 `(session_scope_key, domain, delivery_state, gmt_create, record_key)` 索引，限制 `domain='mcp_configuration'` 与 `delivery_state IS NULL`；MCP 记录没有 delivery。全部资源读取总量限制为 8 MiB，公开结果限制为 1 MiB。触及任一限制都显式标记部分覆盖，不静默省略。本切片不新增 MCP 派生索引。

配置选择、最新 attempt、已发布 catalog 与实时健康是不同事实。历史完整时按记录的 `configRevision` 选择，并保留 pin/revision 身份；历史部分覆盖时只表达有界历史观察，latest/missing 保持未知。旧成功 catalog 不能掩盖更新的失败 attempt。即便 `active` 加 `settled`，也不能证明连接当前在线。Release/disabled 状态保持可见，tools/resources/prompts 各有独立发现覆盖。`gmt_create` 是 operation 创建时间，不是最近观察；不以查询时间虚构 `observedAt`。

`serverRevision` 表示所选 pin，`attemptRevision` 加 `attemptServerRevision` 表示最新已记录尝试，`catalogRevision` 加 `catalogServerRevision` 表示已发布发现结果。`lastAttemptState` 是逻辑 run 状态，`lastExecutionState` 是物理执行状态；即使失败请求的执行已经确定结束，这两者也不同。历史不完整时，attempt 字段及 `releaseState` 均为 null；保留已观察到的 catalog，标记 `historical`，发现状态为 stale/unknown。可空字段仍出现在响应中。

输出限额优先移除 Skills，再缩减 MCP 历史，并在能力截断后归一历史完整性。仅移除 Skills 不得使完整的 MCP attempt 证据失效。输出截断、部分发现结果和逐项 coverage 原因分别展示。

## 8. 直接子代理调用 trace

仅返回属于请求 parent Session 的直接 `child_agent` task 记录。当前 public child admission 要求 depth 1，Hosted Agent 工具要求 parent depth 0。恢复 parser 接受最多 8 层旧深度，不代表支持嵌套 public 执行。不构建递归树，不接收 daemon 风格 `rootAgentId` 过滤。

在 SQL 分页之前过滤 `task_kind='child_agent'`。采用 `(gmt_create DESC, record_key DESC)`、limit 1–100，cursor 绑定 tenant/actor、parent Session 和 query version。调用 `taskId` 与可选 `childSessionId` 是不同身份。仅返回已记录的描述、状态、时间和关系事实；同类 agent 的重复调用仍是独立调用。若展示 predecessor 关系，必须来自实际记录，不递归重建。

复用 task details/events 与 `ManagedChildSessionView` 查看明细。子会话链接要求已记录 parent/run 关系及独立子会话授权；`childTaskDetails` 自身不提供 actor 级授权。子明细缺失、已删除或不可访问，不应抹掉父调用。事件超出保留期与没有调用是不同状态。Trace 查询不恢复子会话，不返回私有 checkpoint/input 引用。

## 9. WebShell 集成

增加可选且有类型的 `diagnostics` provider surface，使用生成的 OpenAPI 类型。一个 Managed 诊断面板含四个页签：Context、模型统计、资源和 agent trace。Home 与非 home header 都可打开。可用性依据读取能力，不依赖 send/interactive 或 MCP 管理权限，因此关闭/离线历史仍可查看。

复用现有 context/token/MCP 视图的纯展示组件。不伪造完整 `DaemonSessionActions` adapter，也不复用 daemon 的 polling/action hook。Trace 页签采用分页直接调用列表及既有 child viewer，不暗示这是完整 daemon 图。

Session active 且页签可见时，统计和 trace 每 5 秒刷新。Context/resources 按需读取，在相关配置变化后显式刷新。隐藏/关闭后停止轮询。Session/provider/actor 变化或权限丢失时清空旧数据并忽略迟到响应。区分 estimate、overflow、gap、partial 与 stale；未知值不是零。仅为实际实现并接通的行为宣告 capability parity。

## 10. 交付与验收

分五阶段实施：资源；直接 trace；模型统计及协议/恢复；context；跨层验收。[计划](../plans/2026-11-06-managed-session-diagnostics-and-organization.zh-CN.md)与 `.qwen/e2e-tests/managed-session-diagnostics.md` 定义检查。实施决定明确后同步两种语言。

验收需要：离线被动读取、授权和子会话隔离、有界资源/历史、真实 invocation policy、累计模型仅一次折叠/恢复、全部模型来源/终态、实际 prepared 输入的八类 context、stale/partial 处理、storage floor 兼容、仅增加诊断的 CSI 转移和真实 WebShell 消费者。Context cached input 与规范化 output 不得重复计数。父子总量保持分离。

遵循根目录及 [Managed 模块指令](../../packages/managed-agent-server/AGENTS.md)。运行受影响 API/SurfaceRegistry 测试并重新生成 WebShell 类型。跨语言变更需要根目录 build/typecheck 与定向消费者测试；事务行为需要真实 MySQL，producer/恢复变更需要对应真实进程路径。所有 agent 共享模块十分钟本地 Java 预算。必需完整门禁留在 CI；fixture/H2 不能证明 MySQL、进程恢复、部署或完整验收。记录通过、失败、缺失前置条件和待完成门禁，不编造证据。
