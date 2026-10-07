# Managed Channel 运行时（H5b/H5c）

[English](2026-10-07-managed-channel-runtime.md) | [简体中文](2026-10-07-managed-channel-runtime.zh-CN.md)

状态：本次变更已为 email 参考适配器实现；生产 AgentBundle 启用以及"验收标准"中列出的真实环境门槛另行推进。本文是 [#12827](https://github.com/QwenLM/qwen-code/issues/12827)（Managed Agent 提案 [#12380](https://github.com/QwenLM/qwen-code/issues/12380) 的 H 阶段）H5 切片的运行时部分：[H5 设计](2026-10-04-managed-channels.zh-CN.md)中的 **H5b**（入站）与 **H5c**（出站）。它承接 H5a（`managed-channel_route` 与 `managed-channel_delivery` 记录契约，PR #13548）和切片 C（planned 的公开 channel 路由与 V47 服务表，PR #13497），并延续 H0b（[记录契约](2026-09-27-managed-extension-record-contract.zh-CN.md)）、H0c（[authority](2026-09-27-managed-extension-authority.zh-CN.md)）和 H3（[后台 Shell 与 Monitor](2026-10-03-managed-shell-monitor-runtime.zh-CN.md)，本切片复用其内嵌 wake 调度器）的义务。下文"参考设计"指[扩展运行时设计](https://github.com/doudouOUC/code_agent/blob/689121646cc25ca08a34508a5f5555ae15308833/qwen-code/feature/managed-agents/managed-agent-extension-runtime.md)第 1、3、6、11、12、14 节，"自动化设计"指[自动化、Channels 与子任务交付设计](https://github.com/doudouOUC/code_agent/blob/689121646cc25ca08a34508a5f5555ae15308833/qwen-code/feature/managed-agents/managed-agent-automation.md)第 3 节（C10），均以 #12827 固定的提交为准。本文与 H5 设计不一致之处，以本文"决策"一节记录的覆盖为准。

## 问题与范围

H5a 钉住了*可以提交什么*：以 `routeId` 为链身份、各修订携带账号代数的路由绑定链，以及以 `deliveryId` 为链身份、各修订携带稳定分段计划且每段一个回执的交付链。切片 C 把三个公开只读路由冻结为 `planned` 并落地了两张服务表。但没有任何东西*产生*或*提供*它们：没有 Session 能提交任一 domain，没有适配器把入站事件路由到 managed 路径，没有派发器读取交付 outbox，三个路由也不回答任何内容。#12380 的 H5 行就是本切片要达到的出口："持久入站路由与附件、结果 outbox 投递、回执与 partial/unknown 投递恢复。"

本切片为 email 适配器交付两个方向：

- **入站（H5b）。** 可信的 channel 适配器向控制面提交一条已认证的平台事件；控制面按四元 ingress 身份去重，解析或创建该路由的 Session，并通过一次 Harness 操作，在一个 journal 事务里提交路由绑定修订（当需要时）、已暂存的附件资源、input 与其 wake。Session 的内嵌 wake 调度器把该 input 当作普通文本轮运行。
- **出站（H5c）。** channel 轮结束后，Harness 把回复提交为带分段计划的 `channel_delivery` 记录（`planned`）。适配器通过控制面拉取自己的 outbox：claim 把记录推进到 `sending`，V47 台账随之推进；逐段回执作为记录修订提交（`partial` → `delivered`）；发送后断线提交 `unknown` 且绝不自动重发；provider 明确拒绝提交 `rejected`；显式重发开启新的 `deliveryId`，只携带已证明未发送的分段，并提示可能重复。
- **公开读取。** `GET /v1/agent-channels`、`GET /v1/agent-channels/{channelId}/deliveries` 与 `GET /v1/agent-channels/{channelId}/deliveries/{deliveryId}` 从 `planned` 变为 `partial`，只读地基于已注册连接、V47 ingress 行与 V47 交付台账提供。
- **启用。** 两个 domain 开放提交，按适配器门控：路由提交的 policy 指明其适配器，仅放行 `email`。

仍然推迟（不属于本切片）：第二个适配器；卡片式分段界面；内联暂存之外的附件种类；managed 路径上的 Legacy 控制命令（`/help`、`/status`、`/cancel`、`/clear`、配对）；主动（非回复）发送与 H6 自动化交付；公开的重发 mutation 与 WebShell 镜像路由；生产 AgentBundle 启用。

## 现状

以下事实来自本切片的基线（H5a 分支头 `8b283d1c3f`，与 `main` 的 merge-base 为 `ac497aeed9`）。

- **记录。** `managed-channel-record.ts` 定义了两个封闭记录体；authority 的 `verifyExtensionResources` 在 Session 自己的资源库上闭合路由的 `policyRef` 以及交付的 `contentRef`、分段 `contentRef` 与回执 `proofRef`；`MANAGED_EXTENSION_RECORD_BODIES` 以 `taskKind: null` 持有两者。Java 的 `ManagedChannelRecords` 回放同一语料。两个 domain 都不在 `MANAGED_SESSION_ENABLED_DOMAINS` 中，也没有把交付与路由绑定的跨记录检查。
- **服务表（V47）。** `qwen_managed_channel_route` 每个四元 ingress 身份一行（`route_key = sha256(tenant|channel|generation|event|revision)`，NUL 连接），带 scope、目标 `session_id`、`state staged|admitted`、已准入的 `input_id` 与 `staged_attachment_refs_json`；`qwen_managed_channel_delivery` 每个 `delivery_id` 一行，携带一个 `segment_id`/`segment_ordinal`、取自共享 channel 交付线的状态与 `provider_receipt`。两者都有 JDBC 仓储（`findOrCreate`、`admit`、`transition`、最新优先分页），但无人调用。公开形状（`PublicChannel`、`PublicChannelRoute`、`PublicChannelDelivery` 及其列表）在契约 1.33.0 冻结为 `planned`；`PlannedChannelContractTest` 钉住其 planned 状态，API 契约测试要求每个非 planned 操作都被实际调用。
- **Harness 侧。** `hosted-harness-session.ts` 已经承载按能力划分的漏斗（`HostedChildAgentSession`、`HostedMonitorSession`）和每能力一条控制面操作路由（`POST /session/:id/children/operations`）；H3 的内嵌 wake 调度器把待处理通知 input（`source` 为 `monitor`，H4b 加入 `child_agent`）作为文本轮运行，待处理集合从 journal 推导（`pendingSessionInputs`）。hosted prompt 只接受文本块。HTTP Session store 每个内联资源最多 64 KiB。
- **控制面。** `HarnessConnector`/`HostedHarnessClient` 每能力一个操作动词（`runChildOperation`）；`ManagedAgentService.createWorkspaceSession` 在 actor 的 Workspace 授权下幂等地准入一个空的绑定 Session；`TenantContextFilter` 列出它解析租户的内部前缀；`@Scheduled` 工作者（`ChildResultRelay`、`SessionLifecycleCoordinator.recoverOperations`）只从已提交的行对账，绝不依赖内存。Flyway 在 `main` 上为 V47；开启中的分支已到 V50（W1c）与 V51（H4b）。
- **Legacy email 适配器。** `packages/channels/email` 在一个加锁的 JSON 文件里保存 `uidValidity`、`lastUid`、在途 `pending` UID、`outboundPending` Message-ID、1,024 条去重窗口与回复路由；在途状态不确定时拒绝启动；用 `mailparser` 解析、`imapflow` 轮询、`nodemailer` 发送。其行为套件基于这三个模块的 fake 运行。

## 决策

1. **三份索引，一个 authority。** Session journal 的 `channel_route` 与 `channel_delivery` 链是唯一的业务事实。控制面在旁边维护三份可重建索引，这是自动化设计"路由/任务 catalog"所允许的：V47 `qwen_managed_channel_route` 行是 ingress 出现记录——决策 2 的去重索引加准入结果；V47 `qwen_managed_channel_delivery` 行是派发器对一次交付的认领台账；V52 新增 `qwen_managed_channel_instance`（已注册连接：平台、账号、代数、状态、Workspace 选择、所属 actor、policy）与 `qwen_managed_channel_binding`（scope key → `routeId` → `sessionId`，新事件所需的查找）。它们都不保存 journal 事实的第二份副本；每一份都由 journal 提交派生或结算。
2. **ingress 身份就是 V47 的 route key。** `inputId = chin-<routeKey>`，其中 `routeKey = sha256(tenant NUL channelId NUL accountGeneration NUL platformEventId NUL semanticRevision)`——Java 与 TypeScript 同一推导。provider 重投命中同一行与同一 `inputId`；Harness 按 `inputId`（journal 的命令幂等）回答已提交的准入，不产生第二个 input 或轮次。两条真实消息即使文本相同也有不同的平台事件 ID（email：`uidValidity:uid`），仍是两个 input。email 的语义修订固定为 1。
3. **路由链以 scope 为键，而非代数。** `routeId = chrt-<sha256(channelId NUL accountId NUL scope.kind NUL senderId NUL chatId NUL threadId)>`。某个 scope 上的首个事件在与其 input 同一事务中开启该链（修订 1，`admitted`，`effectId = routeId`）；后续事件若账号代数比已提交的更新，则在与*它的* input 同一事务中开启换代修订（routeRevision + 1，新代数）；代数比已提交更旧的事件被拒绝（`channel_generation_stale`）——旧代数不再准入任何新内容（H5 设计决策 6）。同代数下已提交路由上的事件只提交 input（`submitInput`），并在 input 信封中钉住路由及其修订。
4. **一个路由一个 Session；创建幂等且受 actor 授权。** 控制面以连接注册的所属 actor，通过既有 `createWorkspaceSession` 路径创建路由的 Session，`Idempotency-Key = chcr-<sha256(tenant NUL channelId NUL routeId)>`，使用实例的 Workspace 选择且无输入；绑定行在准入之后插入。创建应答丢失时按该键重放——绝不产生第二个 Session。v1 中路由的 root Session 即路由自己的 Session（`rootSessionId = sessionId`）。
5. **一次 Harness 操作完成入站准入；它在任何副作用前完成，且可安全重放。** `POST /session/:id/channels/operations` 的 `kind: submit_input` 先发布附件资源与 input 信封，再在一个 authority 事务里提交路由修订 + input + wake（或仅 input）。控制面只在操作应答后把 V47 行标记为 `admitted` 并记录返回的 `inputId`；在此之前任何位置崩溃都让该行停留在 `staged`，适配器重试会重新驱动同一操作，而它回答原始准入。暂存字节保留在它们本就持久的地方：适配器记录准入前的不可变平台副本（IMAP），以及一经发布的 Session 资源库；V47 行以附件内容摘要（`sha256:<hex>`）作为其暂存引用。
6. **附件以 Session 资源暂存，受内联上限约束。** 每个 ≤ 64 KiB（hosted store 的内联资源上限）的附件在准入前发布为 `managed-channel-attachment` 资源，并以名称、MIME 类型、大小与摘要在信封中引用；超限者在信封中列为 `omitted` 并附摘要与大小——对模型和记录可见，绝不静默丢弃（参考设计第 6 节："unsupported 可见"）。更大字节提升到 O2/O3 Artifact 作为后续工作记录在"待决问题"。
7. **channel 轮走 H3 的 wake 路径。** input 的 `source` 为 `channel`；内嵌 wake 调度器在 `monitor` 与 `child_agent` 之外也放行它，于是它在 Session 空闲时作为普通文本轮运行，有轮次运行时在 journal 中排队，Session 被阻塞时准确地保持待处理。轮次文本是渲染为 `<channel-message>` 块的信封：发送者、平台身份、不可信的主题元数据、附件列表与消息正文。channel input 像 monitor input 一样排除在停泊轮次计算之外，关闭路径以无模型方式结算待处理的 channel input 且不产生回复。
8. **回复在结束时幂等地规划，并在打开时对账。** channel wake 轮以 `completed` 结束且助手文本非空后，漏斗发布回复资源（`managed-channel-reply`：文本与 input 携带的适配器不透明回复上下文）和每段一个 `managed-channel-segment` 资源，然后提交 `channel_delivery` 修订 1（`planned`），`deliveryId = <inputId>:reply`，`sourceTurnId = turnId`，并带上信封中的路由钉。email 的计划是一个分段：回复文本截断到 48 KiB 并附截断提示。以 `error` 或 `cancelled` 结束、或在关闭时无模型结算的轮次不规划任何内容。`reconcileReplies()` 在 Session 打开时运行，为任何尚无交付的已结束 channel 轮规划交付，于是结束与规划之间的崩溃既不丢失也不重复。
9. **outbox 由适配器经控制面拉取，每一步都是记录修订。** 适配器调用 `deliveries:claim`；控制面找出该 channel 各 Session 的 `planned` 交付（通过绑定索引与扩展记录投影），插入 V47 台账行（`planned`），请求 Harness 提交 `sending`（`kind: claim_delivery`）并把台账推进到 `sending`，然后返回各分段内容与回复上下文。逐段 `receipt` 提交该分段的回执（仍有分段未完成时为 `partial`，最后一段为 `delivered`），台账带 provider 回执随之推进。`unknown`（适配器无法证明 provider 未持有该消息）提交 `waiting`/`unknown`；`rejected`（provider 明确拒绝）提交 `failed`/`rejected`；两者对自动工作都是终态。Harness 的应答是权威：台账只在记录提交后推进，发现记录已在该状态的台账步骤即幂等重放。
10. **unknown 由租约对账，绝不由重发对账。** 台账行停留在 `sending` 超过认领租约（默认 10 分钟）且无回执时，由控制面的定时对账器结算为 `unknown`（Harness `settle_delivery`，`outcome: unknown`）：适配器可能在发送后死亡。该路径上不重发任何内容（参考设计第 14 节第 5 项）。Session 不再 `ACTIVE` 的 `planned` 交付已没有 writer 可以修订它：claim 跳过非活动 Session，记录保持可见的 `planned`。
11. **重发是新链、显式且带警告。** `deliveries/{deliveryId}:resend` 只对 `unknown`、`rejected` 或 `partial` 后 `unknown` 的交付准入；Harness 开启 `<deliveryId>:r<n>`（`planned`），使用相同的路由钉、`sourceTurnId` 与 `contentRef`，只携带没有回执的分段（序号从 0 重新致密编号，分段身份保留）。原记录不动。应答携带 `possibleDuplicate: true`。v1 只在可信适配器面暴露它；公开 mutation 需要自己的契约工作。
12. **启用按适配器划定范围。** `channel_route` 与 `channel_delivery` 加入 `MANAGED_SESSION_ENABLED_DOMAINS`，旁边新增门控 `MANAGED_SESSION_ENABLED_CHANNEL_ADAPTERS = ['email']`，由 authority 在每个路由首修订上检查：读取已提交的 `policyRef` 资源（`managed-channel-policy`：`{ adapter, senderPolicy, allowedSenders, dispatchMode }`），拒绝不在列表中的适配器。交付只在已提交、非终态且修订与所钉 `routeRevision` 一致的路由上准入（两种语言新增的跨记录检查），因此交付被传递地门控。服务端优先的顺序保持：Java store 自 H5a 起校验两个记录体，并在本切片获得跨记录检查。
13. **可信适配器面是内部的。** `/internal/managed-channels/v1/channels/{channelId}`（注册/连接、`disconnect`）、`.../inbound`、`.../deliveries:claim`、`.../deliveries/{deliveryId}:receipt` 与 `.../deliveries/{deliveryId}:resend` 像 Session store 一样挂在内部监听器上，从 `X-Qwen-Tenant-Id` 解析租户（过滤器增加该前缀），只有部署内的可信 channel 工作者可达。注册提供所属 actor、平台、账号身份与代数、Workspace 选择与 policy；重新配键上报更高的代数。
14. **email 适配器的 managed 模式是复用 Legacy 解析辅助的独立循环，Legacy 路径不变。** `ManagedEmailAdapter` 复用 `message.ts`（发送者接受、有界文本、回复路由）与 IMAP/SMTP 模块，维护自己的加锁状态（`uidValidity`、代数、`lastUid`、带已准入 `inputId` 的在途 `pending` 事件、在途 `outbound` 分段），并驱动流水线：轮询 → ingress 事件 → 控制面 → 持久化准入；claim → SMTP 发送 → 回执（`accepted` 携带生成的 Message-ID，SMTP 5xx 应答为 `rejected`，其余含糊情况为 `unknown`）。`uidValidity` 变化推进代数并重置游标。CLI 以 `qwen channel managed-email` 暴露它，这是实验性子命令，Legacy 的 `qwen channel start` 永远不会选中它。

## 流水线：逐修订

| 步骤 | 位置                     | 提交                                                                                                                                          |
| ---- | ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | 适配器                   | 轮询、解析、发送者门控，以四元身份持久化 `pending`                                                                                            |
| 2    | 控制面                   | V47 行 `findOrCreate`（`staged`）；绑定查找或幂等 Session 创建（决策 4）                                                                      |
| 3    | Harness `submit_input`   | 路由修订 1 或换代修订 + `input.accepted` + `wake.requested` 同一事务（或仅 input）；重放回答已提交的 `inputId`                                |
| 4    | 控制面                   | V47 行 `admitted` 并记录 `inputId`；适配器清除 `pending`，推进 `lastUid`                                                                      |
| 5    | Harness（wake）          | channel 轮运行；`turn.settled`                                                                                                                |
| 6    | Harness（结束 / 打开）   | `channel_delivery` 修订 1 `planned`（决策 8）                                                                                                 |
| 7    | 控制面 `claim`           | 台账 `planned`；Harness `claim_delivery` → 修订 `running`/`sending`；台账 `sending`                                                           |
| 8    | 适配器                   | 逐段 SMTP 发送，发送前持久化 `outbound`                                                                                                       |
| 9    | 控制面 `receipt`         | Harness `segment_receipt` → `partial`/`delivered`（run `settled`），或 `settle_delivery` → `unknown`/`rejected`；台账带 provider 回执随之推进 |
| 10   | 控制面对账器             | 租约过期的 `sending` → `unknown`；非活动 Session 的 `planned` 交付被 claim 跳过并保持可见                                                     |
| 11   | 适配器 / 操作者 `resend` | 新链 `<deliveryId>:r<n>` `planned` 携带未发送分段；返回警告                                                                                   |

每次提交让每条状态线最多前进一个允许的步骤（H0b 后继规则），因此任意两行之间的崩溃都从最后提交的行对账；每个控制面动词在行动前重读已提交的记录，并把"已在该状态"视为自己的重放。

## 配额

| 界限                | 值                                                           | 拒绝                                                      |
| ------------------- | ------------------------------------------------------------ | --------------------------------------------------------- |
| 入站文本            | ≤ 32,000 字符（email `maxTextLength` 默认值），信封 ≤ 64 KiB | 适配器截断文本；超限信封以 `channel_input_too_large` 拒绝 |
| 附件                | 每事件 ≤ 16 个；每个内联暂存 ≤ 64 KiB，更大者列为 `omitted`  | 无（可见的省略）                                          |
| 回复分段            | ≤ 48 KiB，email 为一个分段                                   | 截断并附提示                                              |
| 每交付分段数        | 1–64（契约）                                                 | 规划拒绝                                                  |
| 认领租约            | 10 分钟（`qwen.managed-agent.channels.claim-lease`）         | 对账器结算为 `unknown`                                    |
| 认领批量            | 每次调用 ≤ 16 个交付                                         | —                                                         |
| 每 channel 在途入站 | ≤ 32 个待处理事件（适配器）                                  | 适配器停止准入直到有一个结算                              |

## 非目标

- managed 路径上的**主动发送、控制命令、配对、memory 与 loop**；v1 中回复是唯一的交付来源（自动化设计 3.2，`source: reply`）。
- **多分段计划与卡片界面**：契约支持它们；email 计划为一个分段，V47 台账按 `deliveryId` 只记一个分段。
- **超出内联上限的附件字节**、从工具读取已暂存附件、O3 公开 Artifact 提升。
- **公开重发 mutation、WebShell 镜像路由，以及除把三个已冻结路由及其 schema 翻为 `partial` 之外的任何 OpenAPI 变更。**
- **任何 Legacy 变更**：`EmailChannel`、`ChannelBase`、daemon channel 工作者与路由保持原行为。

## 涉及文件

- `packages/core/src/managed-runtime/`：`managed-session-records.ts`（启用与适配器门控）、`managed-channel-operations.ts`（新增：身份、信封、policy、记录体构造器）、`managed-session-authority.ts`（路由首修订的适配器门控、交付→路由跨记录检查）、同位测试。
- `packages/cli/src/serve/`：`hosted-channel-session.ts`（新漏斗）、`hosted-harness-session.ts`（漏斗接线、操作路由、`channel` input 的 wake 放行、结束与打开时的回复规划、关闭时结算），`hosted-wake-intake.ts` 不变。
- `packages/cli/src/commands/channel/`：`managed-email.ts`（新子命令）、`managed-channel-client.ts`（可信面的 HTTP 客户端）、在 `channel.ts` 注册。
- `packages/channels/email/src/`：`managed-email-adapter.ts` 与 `managed-state.ts`（新增），从 `index.ts` 导出；基于既有 fake 的测试。
- `packages/sdk-java/managed-agent-server`：`V52__managed_channel_instance_binding.sql`、`ChannelInstanceStore`、`ManagedChannelService`、`ManagedChannelAdapterController`（内部）、`ManagedChannelController`（公开）、`HarnessConnector.runChannelOperation` 及其客户端/连接器实现、`ManagedExtensionRecordStore` 中的跨记录检查、租户过滤器前缀、OpenAPI 翻为 `partial`、`ApiModels` 记录与测试（store、service、controller、contract）。
- `packages/sdk-java/qwencode`：`HostedHarnessClient.runChannelOperation`。
- 本设计双语版本；H5 设计中切片表的状态（双语）。

## 验证计划

- **TypeScript**：记录体构造器与身份套件（每个构造器产出 H5a 解析器接受且后继规则放行的记录体；每个拒绝指明原因）；authority 套件覆盖适配器门控、跨记录检查、同事务换代、陈旧代数拒绝、按 `inputId` 重放、交付 claim/receipt/unknown/rejected/cancel/resend 与重新打开重建；`packages/cli` 漏斗套件覆盖 `submit_input` 重放、附件暂存与省略、结束时回复规划与打开时对账、`channel` input 的 wake 放行；email 适配器套件基于 fake 控制面回放 Legacy 行为用例（去重窗口、重投、换代、不确定 SMTP、容量）。
- **Java**：store 套件覆盖 V52、绑定索引与待交付查询；service 套件覆盖 ingress 去重（一个平台事件 → 一行 V47 与一个 `inputId`；两事件同文本 → 两个）、创建重放、对着记录型 Harness 的 claim/receipt/unknown/rejected/resend 迁移、对账器的租约与已关闭 Session 规则；跨记录检查给出拒绝；契约测试调用三个路由（200、400 `invalid_cursor`/`invalid_limit`、403、404）并校验 schema。
- **故障注入（store/authority 级）**：V47 行之前崩溃；行与 Harness 应答之间；应答与 `admitted` 之间；结束与规划之间；claim 与发送之间；发送后回执前；回执与台账之间——每种都终于每事件一个 input、每分段至多一次 provider 发送，或可见的 `unknown`。
- **变异检查**：去重推导、代数比较、适配器门控、跨记录检查、每个交付迁移与重发过滤逐一禁用后，在两种语言中都有测试失败。

## 验收标准

- 参考设计第 14 节第 5 项：channel 重投只形成一个 input；两条真实的相同文本消息仍是两个；外发 ACK 丢失绝不引起自动二次发送。
- 第 14 节第 10 项：每次交付都落到 `delivered`、`partial`、`rejected`、`cancelled` 或 `unknown`；`unknown` 绝不伪装为 delivered，也绝不自动重发；显式重发是带警告的新链。
- 第 11 节：三个 channel 资源只读地基于已提交的行提供；其中不出现 Runtime 身份、凭据、绝对路径或 PID。
- 两个 domain 只对 `email` 适配器开放提交；契约测试证明门控显式且按适配器划定，`shell`/其他生产者不受影响。
- 所有既有套件保持绿色——H1–H4a/H5a 的每个契约回放、authority、store、tool-turn 与生命周期测试，`npm run typecheck && npm run lint && npm run build`，以及 `managed-agent-server` 的 surefire 套件。
- 仍然独立：真实 IMAP/SMTP provider、多实例控制面、第二主机恢复，以及 #12380 记录的 §13 产品栈验收。

## 待决问题

1. **更大的附件。** 内联暂存止于 64 KiB；`omitted` 附件是否在信封的后续修订中获得 O2/O3 Artifact 暂存，与媒体后续工作一起决定，不在此处。
2. **去重索引保留。** v1 不清理 V47 行与绑定索引；保留策略随 Session 归档/删除工作推进。
3. **认领租约与 provider 延迟。** 十分钟是 SMTP 的默认值；接受更慢的 provider 需要按平台的租约，实例注册可在之后携带。
4. **公开重发。** 公开契约是否增加 `POST .../deliveries/{deliveryId}:resend`（在应答中带可能重复的警告），是 WebShell 切片的 API 契约决策。

## 后续工作

| 切片 | 范围                                                  |
| ---- | ----------------------------------------------------- |
| H5d  | 按产品优先级的第二个适配器；带逐段台账的多分段计划。  |
| H5e  | provider 支持时的卡片式分段界面与编辑。               |
| 媒体 | 内联暂存之外的附件种类；工具对已暂存附件的访问。      |
| API  | 公开重发 mutation；channel 资源的 WebShell 镜像路由。 |
| H6   | 复用交付契约与 claim/receipt 面的自动化交付。         |
