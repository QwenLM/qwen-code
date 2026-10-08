# Managed Channels（H5）

[English](2026-10-04-managed-channels.md) | [简体中文](2026-10-04-managed-channels.zh-CN.md)

状态：H5a 切片（两个 domain 的记录契约）已实现；H5b 与 H5c 切片仍为设计提案，文中提到的 domain 均未开放提交。本文是 [#12827](https://github.com/QwenLM/qwen-code/issues/12827) 的 H5 切片设计，属于 Managed Agent 提案 [#12380](https://github.com/QwenLM/qwen-code/issues/12380) 的 H 阶段。它建立在 H0a 的任务契约（[设计](2026-09-27-managed-agent-task-contract.zh-CN.md)）、H0b 的记录契约（[设计](2026-09-27-managed-extension-record-contract.zh-CN.md)）和 H0c 的 authority（[设计](2026-09-27-managed-extension-authority.zh-CN.md)）之上。下文的“参考设计”指该提案[扩展运行时设计](https://github.com/doudouOUC/code_agent/blob/689121646cc25ca08a34508a5f5555ae15308833/qwen-code/feature/managed-agents/managed-agent-extension-runtime.md)的第 1、3、6、11、12、13、14 节；其序言把 Channels 的字段级契约留给[自动化设计](https://github.com/doudouOUC/code_agent/blob/689121646cc25ca08a34508a5f5555ae15308833/qwen-code/feature/managed-agents/managed-agent-automation.md)，均以 #12827 固定的提交为准。

## 问题

Channel 是输入/输出适配器，不是 Session owner（参考设计第 6 节）。它必须遵循的 Managed 流水线是：

```text
平台事件 → 验签/认证实例 → ingress 去重身份 → route binding
  → 附件转存 Artifact
  → input + reply intent + 唤醒 → Harness 计算正式结果
  → channel_delivery outbox → adapter → provider receipt
```

Legacy channel（`packages/channels/*`）的适配器运行在 daemon 或 CLI 进程中。路由（`SessionRouter`）、发送者与群组门禁、配对、去重和在途跟踪都保存在进程内存或 channel 私有文件中（见下文的 email 状态存储），这些都经不起控制面节点替换，其他节点也无法不靠猜地对账。参考设计第 1 节要求所有异步能力都是“持久资源 + 触发意图”，并禁止对未知副作用盲目重试。H5 必须回答：用什么标识一个入站事件，才能做到重投只形成一个 input、而两条内容相同的真实消息仍是两个 input；附件字节如何在不绕过 Artifact 规则的前提下到达模型；以及外发回复如何（可能分段）送达，并带有让恢复后的派发器确切知道 provider 已经收到什么的回执。

## 现状

以下事实基于 `main` 的 `5ddfacc9d4`。

- **Domain 索引。** `channel_route` 与 `channel_delivery` 已在 `packages/core/src/managed-runtime/managed-session-records.ts` 的封闭 v1 domain 索引中注册。注册不等于开放：两者在 `MANAGED_EXTENSION_RECORD_BODIES`（`managed-extension-projection.ts`）中没有记录正文，也不在 `MANAGED_SESSION_ENABLED_DOMAINS` 中，`commitExtensionRecord` 会拒绝它们。
- **交付状态线。** H0b 的运行块已经带有 channel 交付所需的状态：目标 `channel`，状态为 `planned`、`sending`、`partial`、`delivered`、`unknown`、`rejected` 与 `cancelled`。H0c 从它导出 outbox；Java 存储在提交事务的同一 SQL 事务中把它物化到 Flyway V18 表，并由 fixture 固定 `isExtensionDeliveryPending`。目前还没有组件读取 outbox；H0c 把派发器划给了 H4 和 H5。
- **唤醒。** H0c 决策 2：没有 `WakeIntent` 记录。修订可以在同一事务中提交通知输入，authority 为它生成 `input.accepted` 加 `wake.requested`。Session inbox 是用户消息队列，不是唤醒的载体。
- **公开契约。** H0a 在 v1.16 把 Channel 资源（`GET /v1/agent-channels`、`GET /v1/agent-channels/{channelId}/deliveries`）以 `planned` 命名，并把它们的响应形状划给 H5。普通 channel 聊天继续复用 Session 的 prompt/event API（参考设计第 11 节）。
- **Java 正文。** Java 存储只物化它认识的正文；H5 新增的正文必须先于任何写入者提交该 domain 之前送达服务器（H0c 未决问题 7）。
- **Artifact 基础设施。** O2 Hosted 结果存储（#12894）与 O3 公开 Artifact 元数据、区间和下载路由（V26，契约 v1.27）均已合入，暂存的附件字节有持久、受控的存放处。
- **Legacy 适配器清单。** `packages/channels` 包含 `base` 以及 `dingtalk`、`dws`、`email`、`feishu`、`github`、`gitlab`、`plugin-example`、`qqbot`、`telegram`、`wecom`、`weixin` 适配器，共用 `@qwen-code/channel-base` 的 `ChannelBase` 与 `PollingChannelBase`。
- **email 适配器（参考垂直切片）。** `packages/channels/email` 用 `imapflow` 轮询 IMAP，用 `mailparser` 解析，用 `nodemailer` 发送（SMTP，强制 TLS）。其 `EmailStateStore`（`state.ts`）在一个带锁的 JSON 文件中保存：`uidValidity`（IMAP 邮箱代数——变化会重置游标）、`lastUid`、至多 33 条在途 `pending` UID、至多 64 条 `outboundPending` Message-ID、1,024 项的 `recent` SHA-256 摘要去重窗口，以及至多 256 条回复路由。带不确定在途状态启动会拒绝启动并要求人工确认。入站去重是 `sha256(sender, NUL, messageId)`，当邮件没有 Message-ID 时退化为 `uidValidity:uid`；准入后的 `messageId` 是 `uidValidity:uid`。附件（每封至多 16 个）落在按邮件划分的临时目录中，启动时清空、回合后清理。存储目录以实例名、IMAP 主机、端口、用户、文件夹与地址的哈希键控，因此凭据绝不参与身份定义。
- **已合入的前置。** 已在该基线上核实：H0a–H0c（#12855）；H1 MCP 与 H2 Hook 正文（V23、V27/V28），均已开放提交；D4 持久生命周期（#12881）；显式私有 profile 之后的 Hosted 前台 Shell 工具回合；W0 Workspace 绑定及代数门禁，以及默认开启、可用开关退出的持久本地进程供给（专属 Linux 重启验收仍在进行，见 [W0e](2026-09-27-managed-workspace-recovery.zh-CN.md)）。

## 目标

- 在 H0b 运行块之上定义 `channel_route` 与 `channel_delivery` 记录正文。
- 固定入站去重身份：channel instance、账号 generation、平台 event ID 与语义 revision——使一次重投仍是一个 input，而两条文本相同的真实消息保留为两个 input。
- 在准入 input 之前把附件转存为受控 Artifact，并定义准入不确定时的行为。
- 经 `channel_delivery` outbox 外发回复，带回执按段（`segmentId`/`ordinal`）记录，并定义 partial 与 unknown 交付的恢复规则，绝不重发 provider 可能已持有的段。
- 以 email 适配器作为这些契约的参考垂直切片落地。
- 补齐 H0a 为 H5 保留的 `planned` Channel 资源形状。

## 非目标

- **第二个模型驱动者。** Channel 只提交输入与领域结果；参考设计（第 1 节）禁止它启动第二套主 Agent loop、调用 Harness 内部方法，或用当前选中的 UI Session 覆盖原 reply target。
- **其他适配器。** DingTalk、Feishu、Telegram、WeCom、Weixin、QQ、GitHub、GitLab、DWS 与示例适配器在这批切片中保持 Legacy 路径。它们的交互卡片与流式分段界面各自属于后续适配器切片。
- **Channel 拥有的 Session 或共享 channel 上下文。** Session 归属、跨 channel 上下文与 channel 记忆不变。
- **入站授权重设计。** 路由依据认证后的 instance/account/sender/chat/thread，这是参考设计的要求；发送者显示名、群聊标题与模型文本不授予任何权限。Legacy 的配对/门禁配置是适配来源，不是新的授权模型。
- **H6 自动化交付。** 创建 Channel outbox 条目的自动化交付 policy 属于 H6；H5 定义它们使用的交付契约。

## 决策

1. **两个 domain。** `channel_route` 是持久路由绑定：哪个认证后的（instance、account、sender、chat、thread）映射到哪个 Session，及其修订。`channel_delivery` 是一份正式结果的一次交付，以 `deliveryId` 为链身份，在其修订中携带分段计划与逐段回执。两者都不是 Session 任务，因此在 `MANAGED_EXTENSION_RECORD_BODIES` 中取 `taskKind: null`，与 MCP、Hook 正文一致；交付经 `/v1/agent-channels/{channelId}/deliveries` 资源展示，不进任务列表。
2. **入站身份由四部分组成。** 入站事件按四元组（channel instance、账号 generation、平台 event ID、语义 revision）去重。账号 generation 使 provider 侧重新配键之后的身份与之前的不可比，而不是错误地相等——email 适配器的 `uidValidity` 重置正是如此：代数变化重启游标与去重窗口，而不是跨窗口去重。语义 revision 区分同一平台事件被重新解析或编辑后的另一次出现；对 email 固定为 `1`，因为 RFC 822 存储不可变。两条文本相同的真实消息有不同的平台 event ID，保留为两个 input（参考设计第 14 节第 5 条）；provider 重投携带相同四元组，是一个 input。
3. **附件先于准入成为 Artifact。** 入站字节先转存为受控 Artifact，准入的 input 引用它们——Legacy 的临时附件目录是适配器的暂存空间，不是记录。准入不确定（提交结果未知）时，按参考设计第 6 节保留 staged bytes，并在再次准入任何东西之前查询原 `inputId`。
4. **交付分段并逐段回执。** 回复的交付计划拆成稳定的 `segmentId`/`ordinal`；`channel_delivery` 记录的每条修订记录 provider 已证实接受的段。恢复后的派发器只补发被证明未发送的段；`partial` 提交已证实的子集，其余保持未结。模型回合完成与外部送达完成是两个独立事实，分别展示——交付状态线绝不顶替运行线（参考设计第 3.2 与 6 节）。
5. **unknown 就是 unknown。** 当 provider 没有查询 API、也没有幂等键时——没有送达回执的 SMTP 就是 email 的情形——发送后断线进入 `delivery_unknown`（交付状态线上的 `unknown`）：记录表明 provider 可能已持有该消息，并禁止自动重发。用户显式重发创建新的 `deliveryId`，并提示可能重复（参考设计第 6 节）。email 适配器当前面对不确定在途状态时的拒绝启动正是这条规则的人工形态；Managed 路径提交 `unknown`，保持任务可对账，且不阻塞无关工作。
6. **账号换代是一次路由修订。** provider 重新配键（email：`uidValidity` 变化）时，`channel_route` 记录以新修订固定新代数；旧代数的在途交付继续按它对账，但不能创建新副作用——与 H0b/H0c 对 Runtime binding 应用的旧代数规则一致。
7. **普通聊天仍作为 Session input 进入。** 命中的入站消息按 H0c 的机制准入其 Session——同一事务携带输入及其唤醒——reply target 就是路由绑定的那个，并随输入一并提交。之后服务该交付的适配器读取已提交的 target；它不能替换成 UI 选中的 Session。
8. **email 适配器是参考垂直切片。** 首先移植它，是因为它的 Legacy 状态已经把契约需要的四个概念分开：邮箱代数（`uidValidity`）、平台事件身份（`uidValidity:uid`、基于 Message-ID 的摘要）、在途不确定性（`pending` / `outboundPending`）与回复路由。本切片把它们逐一映射到 `channel_route` 与 `channel_delivery` 事实，不发明代码中不存在的 provider API：IMAP 轮询与 `uidValidity` 来自 `imapflow`，Message-ID 解析来自 `mailparser`，外发接受来自 nodemailer 的 SMTP `send` 结果；SMTP 不提供送达查询，因此外发由决策 5 管辖。

## 记录正文（H5a）

两个正文都原样嵌入 H0b 运行块，都以 `taskKind: null` 注册进 `MANAGED_EXTENSION_RECORD_BODIES`——Channel 的 route 与 delivery 不是 Session 任务——并继续缺席 `MANAGED_SESSION_ENABLED_DOMAINS`。字节级契约位于 `packages/core/src/managed-runtime/managed-channel-record.ts`，由 `packages/sdk-java/managed-agent-server` 的 `ManagedChannelRecords` 镜像，并由共用语料 `contracts/managed-channel-record-v1.fixtures.json`（92 个形态用例与 57 个后继用例）固定，TypeScript 与 Java 回放完全一致。

- `managed-channel_route`（链身份 `routeId`）：封闭键 `routeId`、`channelInstanceId`、`accountId`、`accountGeneration`、`routeRevision`、`rootSessionId`、`sessionId`、`scope`、`policyRef`、`run`。scope 按 kind 携带 Legacy 路由键实际派生的身份：`user` 以 chat 内的发送者为键（`senderId` 与 `chatId` 必填，`threadId` 为 null）；`thread` 以 thread 为键并回退到 chat（`threadId`/`chatId` 恰填其一，`senderId` 为 null）；`chat_thread` 以 chat 为键、仅可细化到其一个 thread（`chatId` 必填，`threadId` 可填，`senderId` 为 null）；`single` 仅以实例为键（三者全 null）。运行只钉 `effectId: routeId`：无 definition、execution、Runtime、dispatch 或 delivery——绑定的生命周期是唯一状态。
- route 后继：身份（`routeId`、`channelInstanceId`、`accountId`、`scope`）不变。`routeRevision` 相同时重绑定集合——`accountGeneration`、`rootSessionId`、`sessionId`、`policyRef`——逐字节相同；重绑定或换代把 `routeRevision` 恰好加一，并且此时才能改动集合，但 `accountGeneration` 绝不后退（决策 6）。运行终态冻结整条记录。
- `managed-channel_delivery`（链身份 `deliveryId`）：封闭键 `deliveryId`、`routeId`、`routeRevision`、`sourceTurnId`、`contentRef`、`segments`、`cancelRequested`、`run`。分段计划携带 1–64 个 `{segmentId, ordinal, contentRef, receipt}` 段，`segmentId` 互不相同，`ordinal` 从 0 连续；回执为 `{providerMessageId, acceptedAt, proofRef|null}`。运行把 `effectId`/`deliveryId` 钉为链身份，并携带 H0b 目标 `channel` 的交付状态线，其余为空。
- delivery 一致性：交付状态线、运行状态线与已回执分段在每个修订上一致——`planned` 对应运行 `admitted` 且无回执；`sending`/`partial` 对应运行在途（`running`、`waiting` 或 `recovery_blocked`），其中 `partial` 至少已回执一段但仍至少差一段未齐；`delivered` 对应运行 `settled` 且回执全齐；`unknown` 恰对应运行无原因的 `waiting`（provider 可能已持有其余分段）；`rejected` 对应运行 `failed`；`cancelled` 对应运行 `cancelled` 且无回执。受阻运行只在交付可证为 `sending`/`partial` 时受阻；在运行的钉约束下，唯一能解析的恢复原因是 `handler_unavailable`。
- delivery 后继：计划、产出回合与钉住的路由修订不变；每段回执只写一次、绝不改写；`cancelRequested` 绝不撤销。其余由 H0b 状态线步进约束：`unknown` 的交付绝不回到 `sending`（重发使用新 `deliveryId`，决策 5）；运行终态冻结整条记录，已送达的消息不能事后编辑，而解决 `unknown` 的迟到回执仍可提交。为挡住 `unknown → partial → sending` 的两步绕行，离开 `unknown` 进入 `partial` 本身即要求证据：`partial` 修订必须结清 `unknown` 时尚未结清的至少一个分段。
- 决策 2 的入站去重四元组随准入的输入记录（`input.accepted` 的内容）；携带已提交四元组的重投以原 `inputId` 回答，不产生新回合——去重索引的确切存储形式是 H5b 的决策，随 email 切片固定。

## 切片计划

| 切片          | 范围                                                                                                                                                                                           | 通过门槛                                                                                                                                                                                                                                                                |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| H5a（已完成） | 记录契约：两个正文、验证器、固定字段规则与迁移见证，独立成 `managed-channel-record-v1` fixture 语料；`MANAGED_EXTENSION_RECORD_BODIES` 条目；Java 回放。                                       | TypeScript 与 Java 对 fixture 给出并拒绝完全相同的链。两个 domain 继续缺席 `MANAGED_SESSION_ENABLED_DOMAINS`；`commitExtensionRecord` 仍然拒绝它们。Java 存储先于任何写入者提交，携带这两个正文（H0c 未决问题 7）。没有生产调用方构造任一正文。                         |
| H5b           | email 入站垂直切片：`channel_route` 提交、按四元组身份的入站去重、附件 → Artifact 转存、带唤醒的路由输入准入。两个 domain 仅对该适配器开放提交。                                               | provider 重投只提交一个 input；两条文本相同的消息提交两个。准入崩溃保留 staged bytes 且原 `inputId` 可查；没有事件被准入两次，也没有事件被静默丢弃。`uidValidity` 换代产生路由修订，旧代数不再准入新内容。email 适配器在 Managed 路径上通过其现有行为套件。             |
| H5c           | email 外发垂直切片：`channel_delivery` 提交、outbox 派发器、逐次发送回执、`partial`/`unknown` 恢复、以新 `deliveryId` 的显式用户重发。公开 `/v1/agent-channels` 与 `.../deliveries` 形状提供。 | 发送中断的回复只补被证明未发送的部分；发送后断线记录 `delivery_unknown` 且绝不自动重发；显式重发提示可能重复。模型完成与外部送达分别投影，Channel 发送失败绝不重跑模型（参考设计第 14 节第 6 条）。两个 planned 路由随其 H5 形状转为 `partial`，并由 API 契约测试覆盖。 |

后续 H5 切片（本文不排期）：第二个适配器（按产品优先级选择）；provider 支持时的卡片式分段界面；超出 email 切片所用 O2/O3 转存的附件种类。

## 验证计划

- 两个正文的 fixture 一致性，TypeScript 与 Java 双方回放（H5a）。
- authority 套件：路由换代、重放拒绝、链重建与交付状态线语义：派发、partial、`unknown` 及其禁重发规则（H5a）。跨记录检查——交付按钉住的修订绑定已提交路由——属于执行它们的切片（H5b/H5c），与 MCP、Hooks 的启用期检查一致。
- 公开 Channel 资源的 Java 存储物化（Flyway V47），在 H5c 提供这些资源时启用。
- 适配器故障注入：重投风暴、准入崩溃窗口、发送后断线、交付中途换代、段回执之间重启派发器——每次最终每事件一个 input，或进入可见的 `partial`/`unknown`，绝不重复发送。
- email 参考切片一致性：Managed 路径对已提交记录回放 Legacy 适配器记录在案的行为用例（去重窗口、在途拒绝语义、回复路由）。
- 变异检查：每条去重、迁移与恢复规则逐一禁用，并且每一次都有测试失败。

## 验收标准

- 参考设计第 14 节第 5 条：Channel 重投只形成一个 input；两条真实同文本消息仍是两条；外发 ACK 丢失绝不导致自动二次发送。
- 参考设计第 14 节第 10 条：所有失败都能归为确定未执行、已结算、可 attach 或 `unknown`/`corrupt` 之一，`unknown` 不伪装成功。
- 参考设计第 11 节：Channel 资源对已提交记录只读提供；其中不出现 Runtime 身份、凭据、绝对路径或 PID。
- 两个 domain 只在随其生产者落地的切片中开放提交，并有契约测试证明开放是显式且按适配器限定的。

## 未决问题

1. **去重索引的保留。** 入站去重索引的窗口与压实（Legacy：1,024 条摘要）与 Session 历史保留的关系；由 H5b 随 email 切片固定。
2. **staged 字节配额。** 附件转存复用 O2 配额，但每条路由的转存积压上界及其拒绝行为是 H5b 的决策。
3. **带凭据的配置。** 路由配置按句柄引用 secret；email 的 IMAP/SMTP 凭据句柄在哪里签发与轮换是部署决策，不属于这批切片。
4. **交付预算。** 外发派发是否需要 H0b `rate_limit` 之外的交付速率配额，还是依赖 Session 现有预算，留给 H5c。
