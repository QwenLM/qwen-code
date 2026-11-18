# Managed GitHub PR Watch + 绑定会话主动投递

[English](2026-11-17-managed-github-pr-watch-bound-session.md) | [简体中文](2026-11-17-managed-github-pr-watch-bound-session.zh-CN.md)

状态：范围已确认；已在 #17665 实现，评审中。基于已合入的 managed GitHub adapter（#17511，`2c23f72bef`）。

已确认决策（2026-11-17）：首切片 = private-only 绑定注入（公开回帖、角色模板、Web Shell UI 延后）；**D1 = 新 `pr_event` input source**；**D3 = adapter 侧检测**。D2（专用 PR-watch 绑定表）按下文建议采纳。**D5 定为 internal channel-adapter 面**（租户头 + 可信 adapter + 启用门，`RuleClass.INTERNAL_CHANNEL_ADAPTER`），与已合入的 channel register/inbound 路由同一信任边界——不是 OPERATOR 公共路由，也不是每请求 writer 凭据。见下文绑定路由契约；早先 OPERATOR/Session-owner 措辞已被取代。

## 问题

managed GitHub channel 今天是 **@mention 入站 / reply-only**：mention bot 的评论把 input 准入进 channel route 自己的 Session，settle 的回复发回线程。adapter 范围边界明确延后了两项能力，正是本设计的主题：

1. **PR watch 事件**——pull request 的 CI 失败、合并冲突、head 变化、状态变化应能触发工作，而不只是显式 @mention。
2. **绑定会话主动投递**——这类事件应到达**绑定到该 PR 的既有 managed Session**（操作者已在用来跟进该 PR 的那个 Session），而非 channel 自己的 route Session，且无需 inbound channel 消息。

期望结果：操作者把 PR 绑到 managed Session；被 watch 的 PR CI 变红 / 冲突 / head 移动时，描述该 transition 的 prompt 注入那个绑定 Session（dormant 则唤醒），让 agent 能响应。首切片 **private-only**：事件注入 Session，不自动发公开评论（对齐 Legacy 维护者决策，`2026-11-02-github-channel-bound-session-events.md` Key decision 8）。

## 现状（在 `c6913d17ac` 核实）

### 已存在、可复用

- **input + wake 单事务，Session 通用。** `packages/core/src/managed-runtime/managed-session-authority.ts` `submitInput`（约 L958）一次 commit 落 `input.accepted` + `wake.requested`（`inputEvents` 约 L4587）。`commitExtensionRecord`（约 L1836）可同事务提交域记录修订 + input。这里没有任何东西把目标限制在「本 funnel 创建的 Session」。
- **dormant 唤醒无需新机制。** 三条消费路 + 操作即附着已能在 input 落入 journal 且 source 在白名单时唤醒 dormant Session：进程内 wake pump（`hosted-harness-session.ts` `isWakeInputSource` 约 L1575）、事件驱动 `TransportWakeActivator`、SQL 扫描 `JdbcWakeRecoveryStore`（Java `SOURCES` 约 L29）。channel/automation submit 操作本身就会附着 dormant Session。
- **route rebind 到另一 Session 已契约合法。** `managed-channel-record.ts` `REBIND_KEYS`（约 L124）含 `sessionId`；`isChannelRouteSuccessor`（约 L421）允许 bump `routeRevision` 并换 `sessionId` 的 rebind。**今天没有 producer 这么做。**
- **delivery 记录/状态机与来源无关。** `ChannelDelivery` 要求 `sourceTurnId` 是稳定 id，并非必须是 channel turn（`managed-channel-record.ts`；Java `ManagedChannelRecords.requireDelivery`）。reply-only 约束在 **producer**（`hosted-channel-session.ts` `planReplyUnserialized` 约 L454 只从 `source==='channel'` 的 settled turn 计划；`channelDeliveryId(inputId)=`${inputId}:reply``），不在契约。若新增 producer，claim/receipt/resend/lease 全链可复用。
- **预留事件槽位。** `managed-automation-record.ts` `occurrenceKey`（约 L100）预留 `webhook:<eventId>`「直到 webhook ingress 切片落地」；校验器当前拒绝（只收 `schedule:`/`manual:`）。PR 事件是该槽位的自然未来租户。
- **绑定存储形状。** `ma_channel_binding`（V1 约 L1194）是 `(tenant, channel, route) → session`，仅由 `bindRoute`（`ManagedChannelService.java` 约 L700）创建，且总是创建自己的 Session。`ma_delivery` 已为 `SESSION_MESSAGE`/`CHILD_RESULT` 携带 `source_session_id`/`target_session_id`——「投递给另一 Session」的 SQL 形状已存在。
- **「目标即绑定 Session」的授权模板。** `ManagedAutomationSessionService.java`（约 L44）强制绑定 Session 为目标，经 writer-token `authorizeOrdinary` 鉴权，以 Session creator actor 行事。这是内部主动注入路由要照抄的模型。

### 缺失（必须新建）

- **PR → 既有 Session 绑定**：没有存储条目或写入路径把外部 PR 绑到调用方指定的既有 Session。`bindRoute` 只创建自己的 Session。
- **向绑定既有 Session 提交 input 的控制面 producer 路由**（channel `submitInbound` 永远打自己 route 的 `binding.sessionId()`）。
- **不系于 inbound channel turn 的 delivery producer**（仅当结果需发回 GitHub 时需要；private-only 首切片延后）。
- **绑定写入面的授权**（新路由族；须进 `SurfaceRegistry`，并按 actor-roles 矩阵选角色）。
- **managed adapter 的 PR 状态检测**：`ManagedGithubClient` 无 `pulls.get`/checks/combined-status；`managed-state.ts` 无 watch 基线 / fired-ring / pending。

### 必须解决的架构张力

Legacy 世界**刚把 channel 侧 PR watch 退役、检测收敛进 daemon**（`serve.sessionPrWatch`，#17214，2026-11-14；`2026-11-04-daemon-pr-state-transitions.md`），正是为避免「同一 PR 被两个 poller、两套凭据、两套 CI 定义各查一遍」。在 managed channel 重新引入检测不得重造该重复：

- managed Session **不在** daemon sidecar 体系，managed adapter 用 **token** 而非 `gh` 认证；daemon 的 `sessionPrWatch` 无法原样覆盖 managed Session。所以 managed 需要自己的检测路或显式桥接——并非字面「重建被迁走的东西」，但 one-source-of-truth 顾虑对任何被两个世界同时 watch 的 PR 仍成立。
- 设计必须 (a) 复用 daemon 的 **transition 语义**（每 head 一次 CI fire、边沿触发冲突、private-only），而非发明第二套 CI 定义；(b) 让 managed-watch 与 daemon-watch 作用域不相交或可调和，避免一个 PR 被两套分歧的 CI 聚合重复 watch。

## 拟议架构

三层，镜像 Legacy bound-session-events 设计但落在 managed 控制面：

1. **绑定层（控制面）。** PR-watch 绑定记录 `(tenant, channelInstance, owner/repo#pr) → targetSessionId + 事件过滤 + 角色/动作模板`。新 record body + 表（或扩展 `ma_channel_binding` 增加外部指定 `session_id` 的写入路径）。register/list/retire 路由族，鉴权照 automation-session 内部面（writer binding + creator actor）或 OPERATOR 公共路由。
2. **检测层（managed adapter）。** adapter tick 里的 PR-watch pass，复用既有 Octokit deps、限流分类、poll-floor。观察绑定 PR（`pulls.get` head/mergeable/state + 条件 checks/status），按 daemon 语义推导 transition，持久 durable pending + fired-ring 于新 watch state 段。**不**公开发帖。
3. **注入层（控制面）。** 新内部路由向**绑定** Session 提交 PR-event input + wake（目标由绑定强制，绝非调用方指定），复用 `submitInput`。事件携带 durable envelope（PR 身份、transition、head SHA、证据）在提交前钉住，派生幂等 `inputId` 使崩溃重放到同一 admission。

### 关键设计决策（待确认）

- **D1 — 注入 source。** (a) 新 `pr_event` input source（语义干净；须同时加进 TS `isWakeInputSource` 与 Java `JdbcWakeRecoveryStore.SOURCES` 双白名单及其钉死测试），或 (b) 复用既有白名单 source（经预留 webhook 槽的 `automation`，或 `channel`）以免改白名单但继承该域门。倾向：新 `pr_event` source 最贴切；复用 `automation` 会把 PR 事件耦合进 automation 域门。
- **D2 — 绑定存储。** 专用 PR-watch 绑定表 vs 扩展 `ma_channel_binding` vs route-rebind。route-rebind 契约就绪但 rebind 整个 channel route（也影响 @mention 投递），对 per-PR watch 目标多半不对。倾向：专用 PR-watch 绑定，不动 channel route。
- **D3 — 检测归属。** adapter 侧 watch（adapter 持 token）调控制面注入路由，vs 控制面侧 watch。倾向：adapter 侧检测（持凭据与 poll loop），控制面持绑定 + 注入 + 授权。须与 daemon `sessionPrWatch` 作用域调和避免重复 watch。
- **D4 — private-only 首切片。** watch 事件注入绑定 Session，不自动发公开回复。公开回复 delivery producer 是后续。对齐 Legacy 决策，避免切片 1 的 delivery-producer 工作。
- **D5 — 授权角色（已定）。** 四个路由（`pr-watch:create`、`pr-watch:list`、`pr-watch:retire`、`pr-watch:inject`）都走既有 internal channel-adapter 面：租户头 + 可信 adapter + 启用门，在 `SurfaceRegistry` 注册为 `RuleClass.INTERNAL_CHANNEL_ADAPTER`。没有每请求 actor 或 writer 凭据；信任边界是内部监听器，与已合入的 channel register/inbound 路由完全一致。注入强制绑定 Session 为目标（绝非调用方指定）。slice 1 考虑过 OPERATOR 公共路由并否决：在接口仍属内部时，它会在 adapter token 之外再加一套凭据系统，无收益。

## 有界首切片（拟议）

交付「把 PR 绑到 managed Session；CI 失败 / 合并冲突 / head 变化向该 Session 注入 private prompt，dormant 则唤醒」：

- PR-watch 绑定 record + 表 + register/list/retire 路由（授权按 D5）。
- 内部 PR-event 注入路由（目标由绑定强制；input+wake；派生幂等 inputId；durable envelope）。
- managed adapter PR-watch pass（检测、daemon transition 语义、durable pending + fired-ring）+ client `pulls.get`/checks 扩展。
- wake-source 处理按 D1。
- 测试：契约 fixtures（TS/Java 一致）、绑定授权、注入幂等/崩溃重放、watch transition 边沿、dormant 唤醒、private-only（不公开发帖）。

切片 1 之外延后：公开回复 delivery producer；`state_change`/角色动作模板（若不在最小事件集）；per_run 目标；daemon/managed watch 作用域调和（超出保持不相交）；Web Shell 绑定 UI。

## 涉及文件（按层，示意）

- Core：`managed-session-authority.ts`（input source）、`managed-session-records.ts`（wake/source 钉死、启用门）、新 PR-watch 绑定 record + fixtures；若 D2=专用绑定则 `managed-channel-record.ts` 不变。
- Java：新绑定表（V1 schema）、绑定 repository/service、注入路由 + controller、`SurfaceRegistry`、`JdbcWakeRecoveryStore.SOURCES`（若 D1=新 source）、契约镜像 + fixtures。
- CLI/Harness：`hosted-harness-session.ts` wake 白名单（若 D1）、PR-event input funnel（类比 `hosted-channel-session.ts`）、input envelope。
- Adapter：`managed-github-adapter.ts`（watch pass）、`managed-github-deps.ts`（`pulls.get`/checks）、`managed-state.ts`（watch 段 + 校验器）。
- 设计文档 EN/zh；E2E 测试计划。

## 具体契约（slice 1，协调目标）

- **Input source。** `PR_EVENT_INPUT_SOURCE = 'pr_event'`，定义于新 core 模块
  `managed-pr-watch-operations.ts`（照 `managed-channel-operations.ts` 模式）。加入 TS wake
  白名单 `isWakeInputSource`（`hosted-harness-session.ts`）与 Java
  `JdbcWakeRecoveryStore.SOURCES` 及其钉死测试。`input.accepted` 事件 schema 本就接受任意
  text `source`，故 core 事件 schema 无需改。
- **Workspace lifecycle 对 `pr_event` 刻意 fail-safe。** `JdbcWorkspaceLifecycleStore`
  的 v2 source 白名单（`monitor`、`child_agent`、`automation`、`session_message`、
  `channel`、`loop`）刻意不加 `pr_event`。已接受的 `pr_event` input 因此落入 lifecycle
  扫描的 `pending` 集，阻塞 Workspace close/delete，直到其 `turn.settled` 将其移除。这是
  保守选择：`pr_event` input 在绑定 Session 驱动真实模型轮，lifecycle 必须等其结算，而非
  当作不阻塞的背景 input。该处无需改码；省略是有意的。
- **绑定存储（D2）。** 普通 SQL 表 `ma_pr_watch_binding`（照 `ma_channel_binding`，非
  extension-record 域）：`(tenant_id, channel_id, binding_id, owner, repo, pr_number,
session_id, events_json, gmt_create)`，UNIQUE`(tenant_id, channel_id, owner, repo,
pr_number)`。不带 session 维度索引：slice 1 没有按 session 的读取（retire 按 PR 业务键），
  故不留无读取方的索引。`events_json` 为启用的 transition 集。绑定写入须校验目标 Session
  存在、ACTIVE、属实例 Workspace，并按 D5 授权。
- **绑定路由。** 既有 internal channel 前缀
  `/internal/managed-channels/v1/channels/{channelId}` 下：`pr-watch:create`、
  `pr-watch:list`、`pr-watch:retire`。鉴权照 channel adapter internal 面（租户头 + 可信
  adapter + 启用门）；create/retire 写入面注册进 `SurfaceRegistry`。
- **注入路由。** 同前缀 `pr-watch:inject`。目标 Session 由绑定强制（绝非调用方指定），照
  `ManagedAutomationSessionService`。经既有 connector 路径
  （`QwenHostedHarnessConnector.runChannelOperation` → `POST /session/:id/channels/operations`）
  以新 operation kind `submit_pr_event_input` 提交 input+wake（source `pr_event`）。
- **幂等身份。** `inputId = "prw-" + sha256(tenant ∥ channelId ∥ owner ∥ repo ∥ prNumber ∥
transition ∥ headSha ∥ episode) + ":input"`；`turnId = inputId`。`episode` 是 adapter 的
  持久 per-PR 发生计数，随每条 pending 落盘：合法复发（同 head 的 merge_conflict
  dirty→clean→dirty，或 head_change A→B→A）是新 episode、派生新 inputId；同一 pending 重投
  复用 episode、派生同一 id。缺 episode 控制面会把合法复发误 dedupe 成首次 admission。
  Harness 提交与 SQL 台账间崩溃重放到同一 admission（派生 id），沿用 channel 崩溃安全纪律。
  durable envelope 提交前钉住绑定 + PR + transition + headSha。
- **Envelope。** `managed-input` 资源携 `{ text, prWatch: { owner, repo, prNumber,
transition, headSha, evidence } }`；wake pump 读 `text` 作 prompt。private-only：不从
  `pr_event` input plan 任何 `channel_delivery`。
- **检测（D3）。** adapter 侧 watch pass 复用 daemon transition 语义（每 head 一次 CI fire、
  边沿触发冲突、head 变化）。最小事件集 ci_failure/merge_conflict/head_change（state_change
  延后）。adapter 经 `pr-watch:list` 得知绑定 PR。watch state（baseline + fired-ring +
  pending）存于 `managed-state.ts` 新段。

## 评审加固（#17665 第 1 轮）

首轮评审闭环了这些缺口；每项都由「移除守卫即转红」的测试钉死：

- **轮转观测窗口。** 每 tick 观测上限截断顺序稳定的绑定列表；持久 `sweepStart` 偏移轮转窗口，使每个绑定在后续 tick 都被观测，而非只有前 cap 个。
- **episode 水位跨剪枝/改绑存活。** 准入台账永久且不含绑定维度，故 per-PR 发生计数存于持久 `episodes` 映射、跨 baseline 剪枝保留；改绑续用计数，而非重派生已准入的 inputId。该映射独立于可剪枝的 baseline 限界（超 cap 逐出最旧水位）。
- **终态 PR。** merged/closed 为终态：不驱动 transition，其绑定被退订（幂等、终态期间重驱），释放观测名额并允许改绑。
- **所有权迁移守卫统计两类绑定。** channel 重注册在存在遗留绑定时拒绝 actor/Workspace/cwd 迁移；预检查与同语句守卫现在同时统计 `ma_pr_watch_binding` 与 `ma_channel_binding`，且 `inject` 每次复核绑定 Session 的 Workspace（fail-closed，Session 已消失则惰性退订绑定）。
- **wake pump 是准入前置。** Session 无进程内 wake pump（如 external-files profile）时拒绝 `submit_pr_event_input`（409），绝不把 input 确认进一个无法执行它的 Session。
- **入口对包装后信封限界。** 路由在 staging 前拒绝包装后 prompt 超 Harness 字符/字节上限的负载，使被接受的请求即可准入（不留永久 staged、不可注入的行）。线上上限保持 `text ≤ 32000`、`evidence ≤ 4000`。
- **按条目隔离 drain。** 瞬时注入失败隔离到该 PR 的队列；一个不健康 Session 不饿死其他绑定。被 fired 环抑制的 `ci_failure` 仍钉住该 head，CI 读取不会每 tick 重发。
- **已提交的真实进程见证。** adapter↔控制面 E2E 为永久脚本 `scripts/run-managed-pr-watch-e2e.mjs`（`npm run test:e2e:managed-pr-watch`），接入 Hosted failover E2E job 并由 `scripts/tests/hosted-process-ci.test.js` 钉死。它跑 bundled CLI + 真实 Octokit 对可变 fake GitHub 与 recording fake 控制面（用真实 core `prWatchInputId` 派生 id）；其 private-only、per-ref CI、once-per-head 检查读取记录计数器，故可失败。

第 2 轮另闭环：CLOSED 绑定 Session 现也被惰性退订（不只 DELETED/跨 Workspace）；冷加载文件历史豁免覆盖 `pr_event` 停泊的工具回合；关闭路径结算挂起的 `pr_event` input；watch pass 移到回复通道之后且仅在变化时持久化；终态退订带 ownership 守卫；pump-less 绑定在首次 `pr_event_wake_unavailable` 时退订；失败检查列表带不完整标记；parity fixture 双向化（TS 测试读取它）并钉死信封上限；`channels.enabled` 说明列出四个 `pr-watch:*` 路由。

## 开放问题

1. ~~D1–D5~~ 已确认（见状态）；D5 定为 internal channel-adapter 面（无进一步角色决策待定）。
2. 与 daemon `sessionPrWatch` 的重复 watch：slice 1 将 managed-watch 限定于 managed 绑定 PR；
   超出「不相交」的调和延后。
3. `state_change` 与角色/动作模板延后到 slice 1 之外。
