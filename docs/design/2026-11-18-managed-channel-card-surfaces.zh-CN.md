# Managed 渠道卡片界面（H5e）

[English](2026-11-18-managed-channel-card-surfaces.md) | [简体中文](2026-11-18-managed-channel-card-surfaces.zh-CN.md)

状态：本次改动已实现 DingTalk 互动卡片（单聊）；真实租户 smoke 与其他适配器的
卡片渲染仍另行处理。本文是 [#12827](https://github.com/QwenLM/qwen-code/issues/12827)
的 **H5e** 切片，由 [#17716](https://github.com/QwenLM/qwen-code/issues/17716)
跟踪，属于 Managed Agent 提案
[#12380](https://github.com/QwenLM/qwen-code/issues/12380)。它建立在
[H5 设计](2026-10-04-managed-channels.zh-CN.md)、
[渠道运行时](2026-10-07-managed-channel-runtime.zh-CN.md)、
[多分段台账](2026-11-10-managed-channel-multi-segment-ledger.zh-CN.md)、
[多分段 producer](2026-11-12-managed-channel-multi-segment-producer.zh-CN.md)
与 [DingTalk 适配器](2026-11-13-managed-channel-dingtalk-adapter.zh-CN.md)
之上。第一个支持卡片的 provider 是 DingTalk；其余 managed 适配器继续走文本路径。

## 问题

一次 managed 渠道回复被投递为 1 到 64 个有序文本分段，每段一条写一次回执。
四个已启用的适配器（email、DingTalk、GitHub、WeCom）都不会把一次投递渲染成
provider 原生卡片，也都无法编辑已送达的内容。在 managed DingTalk 路径上，这个
缺口很具体：每段都是一条 `sessionWebhook` 文本消息，其 `providerMessageId` 是
本地 `randomUUID()`，适配器手里没有任何可以更新的 provider 侧句柄。DingTalk 有
真实的互动卡片 API，Legacy 渠道也已经在用（`DingtalkInteractiveCardClient`），
但 managed 路径没有。

H5e 在一个 provider 上补上这个缺口，同时不另造第二条交付来源：支持卡片的适配器
把一次投递渲染成一张卡片，第一段之后的每个分段都成为对这张卡片的编辑。分段计划、
逐段回执、claim 预算与 partial/unknown 恢复完全保持不变。

## 现状

以下事实按本次改动与 `main` 的 merge-base 核实，并在每次合入 `main` 后复核
（最新 `3612b40420`）。站点用符号名锚定，不写行号，避免清单漂移。

- **记录契约禁止事后编辑。**
  `packages/core/src/managed-runtime/managed-channel-record.ts` 的
  `ChannelDelivery` 闭合了分段与回执的键集；`isChannelDeliverySuccessor` 冻结
  计划、分段身份与每段的 `contentRef`，回执写一次。
  [H5 设计](2026-10-04-managed-channels.zh-CN.md)直接写明了这条规则：终态 run
  冻结记录，「所以已送达的消息不能事后编辑」。因此编辑不能是一条记录修订；它只能
  是对这次投递已拥有的界面做 provider 侧更新。
- **claim 是分批的。**
  `packages/cli/src/serve/hosted-channel-session.ts` 的
  `HostedChannelSession.claimResult` 只返回放得进
  `MANAGED_CHANNEL_LIMITS.maxClaimTextBytes`（512 KiB，低于 SDK 的 1 MiB JSON
  上限）的前导未回执分段；适配器在每次回执后再 claim 其余部分。要承载整条回复的
  卡片必须跨 claim、跨重启累积它的正文。
- **回执重放按 ordinal 判定。** `HostedChannelSession.receipt` 查
  `delivery.segments[ordinal]`，已落定的回执在 `providerMessageId` 相同时原样
  返回。因此多个分段可以共享同一个 provider 句柄——它们共同渲染进的那张卡片的
  句柄。
- **managed DingTalk 的发送**（`ManagedDingtalkAdapter.send`）在每次副作用前
  持久化一条 `outbound` 条目，通过 `deps.sendWebhook` 发送分段，把确定性拒绝
  分类为 `rejected`、把含糊失败分类为 `unknown`，持久化回执、上报，并在任何
  非 accepted 结果上停止这次投递。确定性拒绝会把 webhook 逐出缓存。
  `reportOrphanedOutbound` 在重启后重放已持久化的回执，未证明结果的分段落
  `unknown`。
- **卡片原语已经存在。**
  `packages/channels/dingtalk/src/interactive-card-client.ts` 暴露
  `DingtalkInteractiveCardClient.createAndDeliver`
  （`POST /v1.0/card/instances/createAndDeliver`）、`updateInstance`
  （`PUT /v1.0/card/instances`，`updateCardDataByKey`）与 `openOrUpdateStream`
  （`PUT /v1.0/card/streaming`）。它用 `x-acs-dingtalk-access-token` 鉴权，
  401 时作废 token 并重试一次，用 `DingtalkCardRequestError.retryable` /
  `isRetryableDingtalkCardError` 分类失败。单聊（非群）卡片投放到
  `dtv1.card//IM_ROBOT.<userId>`——Legacy 的结果路径传的是发送者的 user id，
  不是 conversation id（`DingtalkAdapter.deliverBackgroundResponseToTarget`）。
  Legacy 客户端以 `robotCode: config.clientId` 构造。access token 来自
  `https://oapi.dingtalk.com/gettoken`（`DingtalkAdapter.getProactiveToken`），
  缓存到 `expires_in - 60`，用 `PERMANENT_TOKEN_ERROR_CODES` 区分死凭证与
  瞬态 errcode。
- **包里已有卡片正文上限。** `status-card-controller.ts` 把渲染的卡片正文限制在
  `CONTENT_LIMIT = 20_000` 个 UTF-16 单元，并可见地标记截断。一个台账分段可以是
  48 KiB UTF-8，整条回复最多 64 段，所以卡片装不下每一条回复。
- **managed 路径上不存在能力声明。** 适配器只告诉控制面 `platform` 与闭合四键的
  `ManagedChannelPolicy`（`adapter`、`senderPolicy`、`allowedSenders`、
  `dispatchMode`）；控制面原样转发 policy，不读其中任何字段。启用门在
  `MANAGED_SESSION_ENABLED_CHANNEL_ADAPTERS`
  （`packages/core/src/managed-runtime/managed-session-records.ts`），已是
  `['email', 'dingtalk', 'github', 'wecom']`。

## 决策

在 DingTalk 适配器内部渲染卡片，建立在不变的交付契约之上。一次投递是一张卡片；
第一个分段创建它，之后每个分段编辑它。记录体、Java 控制面、OpenAPI 文档与 claim
协议都不改。

### 1. 一次投递一张卡片，分段即编辑

对于首个被 claim 的分段 ordinal 为 0、且文本放得进卡片正文上限的投递，适配器用
确定性的 `outTrackId` 与该分段文本作为卡片正文调用 `createAndDeliver`。之后每个
分段把自己的文本追加到已持久化的正文上，并用完整的新正文调用 `updateInstance`
——全量快照编辑，不是流式追加。每个分段仍然各得一条写一次回执；卡片分段的
`providerMessageId` 就是 `outTrackId`，即解析这张卡片用于编辑的持久 provider 侧
句柄。文本回退的分段保留今天的本地 `randomUUID()`。

`outTrackId` 是 `qwen-managed-` 加 `sha256(deliveryId)` 的前 32 个十六进制字符
（45 个字符，在 provider 的 64 字符 `outTrackId` 上限内）。它是投递身份的纯函数，
所以重启会重新推导出同一个句柄，绝不会为同一投递创建第二张卡片；而重发——新的
`deliveryId`——得到自己的卡片，只承载已证明未发送的分段。前缀沿用 Legacy 的
`qwen-status-` / `qwen-result-` 约定，便于运营在 provider 控制台认出这张卡片。

正文是已渲染分段文本的纯拼接，不添加分隔符：这样 producer 的拼接不变量（拼接计划
分段即复现回复）对卡片正文同样成立。

### 2. 卡片正文上限，以及诚实的溢出

卡片正文上限为 `MANAGED_CARD_CONTENT_LIMIT = 20_000` 个 UTF-16 单元，即 Legacy
状态卡片已在用的上限。把一个分段渲染进卡片前，适配器检查累积正文加上该分段文本
是否仍然放得下。放不下时，适配器把这次投递从该分段起及其后所有分段切到文本路径。
若卡片已存在，这个切换会被持久化（`mode: 'text'`），使整个尾部跨重启都走文本；卡片
保留它已承载的前缀，尾部以普通 `sessionWebhook` 文本消息送达。若第 0 段本身就太大，
则不创建卡片、投递从一开始就是文本——没有卡片进度可持久化。每个分段仍然各得一条
真实的回执。

这是一次投递内部的渲染回退，不是第二条交付来源：同一个 `deliveryId`、同一本台账、
同一套 claim/resume 协议。另一种做法——截断卡片正文却把每个分段都回执为已送达——
会让回执声称用户从未看到的内容，因此被否决。

### 3. 卡片进度是持久化状态，缺省即文本

`ManagedDingtalkState` 新增一个可选的 `cards` 映射，按 `deliveryId` 键控：
`{ outTrackId, body, mode: 'card' | 'text' }`，上限
`MANAGED_CARD_PROGRESS_LIMIT = 64` 条，按最久未触碰逐出（`touchWebhook` 的纪律：
删除、重新定义为自有可枚举键、超出上限逐出第一个键）。该映射与 `outbound` 条目
写在同一次原子 `persist()` 里，先于卡片副作用。

发送决策只读这个映射与分段 ordinal：

| 情形                                    | 界面                        |
| --------------------------------------- | --------------------------- |
| ordinal 0，无进度，文本放得下上限       | 创建卡片                    |
| ordinal 0，无进度，文本超上限           | 文本（不建卡）              |
| 进度 `mode: 'card'`，累积文本放得下     | 编辑卡片                    |
| 进度 `mode: 'card'`，累积文本溢出       | 文本，持久化 `mode: 'text'` |
| 进度 `mode: 'text'`                     | 文本                        |
| ordinal > 0，无进度（被逐出或从未创建） | 文本                        |

最后一行正是逐出安全的原因：进度被逐出的投递绝不会在 provider 可能已持有的
`outTrackId` 下重新建卡——它剩余的分段直接以文本送达。

一旦投递可证明已终态就剪掉进度，这样已完成的投递不会把回复正文留在磁盘上、直到
被 64 个更新的卡片投递逐出（状态文件每次持久化都会重新 stringify 并 fsync）。
非 accepted 回执立即剪掉。accepted 回执在控制面应答报告投递 `delivered` 时剪掉：
`receipt` 现在透出落定的投递视图（Java 端点本就返回它，TS 客户端先前丢弃了），
适配器在 `delivered` 时剪掉、在 `partial` 时保留进度。孤儿重驱动在终态落定时也
剪掉。重启从已持久化的正文恢复累积；已持久化的回执重放，未证明的卡片分段落
`unknown`，两者都不会发出第二次创建或更新。

### 4. 适配器声明卡片能力；配置门控它

`packages/channels/base/src/managed-channel.ts` 新增
`ManagedChannelCapabilities { cards: boolean }`。`ManagedDingtalkAdapter`
暴露 `readonly capabilities: ManagedChannelCapabilities = { cards: true }`；
其余适配器不做声明，由构造保持文本路径。DingTalk 的声明是固定的 `true`，因此门的
`cards: false` 分支是契约/测试缝（通过变异该声明来见证），不是生产开关——它是未来
不支持卡片的适配器会用的缝。

只有三者同时成立才进入卡片模式：适配器声明 `cards`、渠道配置带有非空
`cardTemplateId`、deps 提供 `sendCardSegment`。模板 id 是运营自建的卡片模板，其
markdown 组件绑定 `content` 变量；它从渠道配置里与 `clientId` / `clientSecret`
并列读取，复用 `validCredential` 解析（去首尾空白；非字符串、空值或含 CR/LF/NUL
时拒绝），让凭证规则只在一处收紧。没有可用 id 时，适配器逐字节停在今天的文本
路径上。配置了但不可用的 id 会在构造时播报一次（记录事实而非取值），让「卡片始终
不出现」有可诊断的原因；该拒绝保持非致命。`cardTemplateId` 既在 DingTalk 插件的
`management.fields` 中声明（渠道编辑器或 settings-API 客户端可设置），**也**在
`envResolvableConfigFields` 中声明（运行时据此解析 `$VAR` 引用）。两份清单都必须
命名它：设置存储以 `management.fields[].envResolvable` 为准，而 `parseChannelConfig`
只解析 `envResolvableConfigFields` 加已知凭证字段——只出现在前一份清单的字段会以
未解析的字面量到达卡片 API，每条回复都会被终态拒绝。

能力声明由发送门自身消费，并有一条见证钉住：`cards: false` 的适配器即使配了模板、
装了卡片 deps 也走文本——声明是一道门，不是装饰。

### 5. 一个新 dep，复用 Legacy 卡片客户端

`ManagedDingtalkAdapterDeps` 新增一个可选成员：

```ts
readonly sendCardSegment?: (input: {
  outTrackId: string;
  templateId: string;
  target: { chatId: string; isGroup: boolean };
  body: string;
  create: boolean;
}) => Promise<void>;
```

`createManagedDingtalkDeps(proxy?, credentials?)` 在给定凭证时提供它：一个以
`robotCode = credentials.clientId` 构造的 `DingtalkInteractiveCardClient`
（Legacy 的构造方式）、一个镜像 `getProactiveToken` 的缓存 `gettoken` provider
（在 `expires_in - 60` 刷新、带 60 秒下限，永久 errcode 判确定性），由 `create`
选择 `createAndDeliver` 还是 `updateInstance`。目标是
`{ chatId: replyContext.senderId, isGroup: false }`：managed 路径只准入单聊
（群帧在入站即丢弃），单聊卡片投放到 user id。

managed 客户端启用 `strictResponses`——卡片客户端的新选项，Legacy 调用方不启用
（其宽容行为不变）。回执是写一次的，所以「客户端没抛错」不等于已送达：strict 模式
下无法解析的 200 body 抛错（含糊），`createAndDeliver` 应答中没有报告 success 的
`deliverResults` 条目也抛错（含糊）——`createAndDeliver` 有一个可独立于 HTTP 200
失败的投放步骤。编辑遇到可读的 200 body 即 accepted。失败分类随后镜像 webhook
发送：不可重试的 `DingtalkCardRequestError`（或永久 token errcode）是确定性 →
`rejected`；可重试状态、网络失败、超时或不可读/未确认的应答是含糊 → `unknown`。
适配器现有的分支停止这次投递，把剩余分段留在服务端，与文本发送失败完全一致。失败
或含糊的编辑绝不触发自动二次发送，未送达的卡片绝不被回执为 `accepted`。

代理-only 出口被尊重：配置了代理时，token 请求与卡片调用都走按调用创建的
`EnvHttpProxyAgent` dispatcher，即 `sendWebhook` 已在用的形状。由于 `fetch` 在响应
头到达时即 resolve、而两个调用方都在其后才读 body，包装层先把 body 缓冲
（`arrayBuffer`）、返回一个不依赖 dispatcher 的 `Response`，然后才销毁 dispatcher
——先销毁会中止每一次走代理的 body 读取（`UND_ERR_DESTROYED`）。卡片客户端接受
`fetch` 选项，因此注入 dispatcher 不需要碰 Legacy 客户端。

`TOKEN_API` 与 `PERMANENT_TOKEN_ERROR_CODES` 成为 `DingtalkAdapter.ts` 的导出，
让 managed token provider 与 Legacy 共享同一份承重 errcode 集合。这是增量导出；
Legacy 行为不变。

### 6. 编辑不是什么

没有新的操作 kind、没有新的记录修订、可信面或公开面上没有 `edit` 路由、后继规则
也不改。本切片里的「编辑」指对一次投递已拥有的卡片做 provider 侧更新，通过与发送
相同的 claim → send → receipt 管线发出，遵守相同的至多一次与 `unknown` 纪律。
编辑已落定的投递记录仍被 H5 契约禁止，公开 edit/resend mutation 仍是 API 切片的
工作。

## 涉及文件

- `packages/channels/base/src/managed-channel.ts` —— `ManagedChannelCapabilities`，
  以及 `receipt` 返回值从 `void` 拓宽为落定的投递视图，让适配器能剪掉已完成投递的
  卡片进度。纯类型改动，从 base index 导出；由 DingTalk 与 CLI 套件验证（不新增
  base 运行时测试）。
- `packages/channels/dingtalk/src/managed-dingtalk-adapter.ts` —— 能力声明、
  `cardTemplateId` 配置解析（复用 `validCredential` 并播报一次不可用 id）、卡片
  发送门与循环、溢出回退、进度触达与剪枝（`delivered` 回执与终态孤儿落定）、
  卡片拒绝不逐出 webhook 的守卫、`outTrackId` 推导与正文上限。
- `packages/channels/dingtalk/src/managed-state.ts` —— 可选 `cards` 映射、其校验
  子句与 `MANAGED_CARD_PROGRESS_LIMIT`。
- `packages/channels/dingtalk/src/managed-dingtalk-deps.ts` —— `sendCardSegment`、
  缓存 token provider、以及在销毁按调用 dispatcher 前先缓冲响应 body 的代理出口
  包装。
- `packages/channels/dingtalk/src/interactive-card-client.ts` —— opt-in 的
  `strictResponses` 选项（不可读或未确认的应答判含糊）；Legacy 调用方保持宽容。
- `packages/channels/dingtalk/src/DingtalkAdapter.ts` —— 仅增量导出 `TOKEN_API`
  与 `PERMANENT_TOKEN_ERROR_CODES`。
- `packages/channels/dingtalk/src/index.ts` —— `cardTemplateId` 管理字段，让渠道
  编辑器 / settings-API 客户端能启用卡片。
- `packages/cli/src/commands/channel/managed-dingtalk.ts` —— 把解析后的凭证传给
  deps 工厂。
- `packages/cli/src/commands/channel/managed-channel-client.ts` —— `receipt`
  透出控制面的落定投递视图，不再丢弃。
- 适配器、state、deps、卡片客户端、命令与 channel-settings store 的同目录测试。
- 本设计的中英两版；渠道运行时设计中英两版的 H5e 后续工作行。

## 范围边界

- 不新增适配器，也不为 email、GitHub、WeCom 渲染卡片——它们保持文本路径不变。
- 不改记录体、闭合键集、后继规则、Java 控制面、SQL schema、OpenAPI 文档及其版本、
  claim 预算或回执写一次规则。
- 不做流式卡片更新（`openOrUpdateStream`）：每段一次全量快照 `updateInstance`
  就是编辑原语。不做卡片回调、按钮或动作——只渲染。
- 不做群卡片：managed DingTalk 路径只准入单聊。
- 不做内联暂存之外的附件种类、不做主动发送、不做 H6 自动化交付、不做公开重发
  mutation、不做 WebShell 镜像路由。
- 不改模型驱动方式，也不改 Legacy 行为。

## 验证计划

所有见证都注入 deps；真实 provider 不是合并门，与 DingTalk 适配器切片一致。

- **卡片循环见证**（`managed-dingtalk-adapter.test.ts`）：配置后的单分段投递创建
  一张卡片并以 `outTrackId` 回执；多分段投递创建一次、之后每段编辑一次，正文累积，
  每个 ordinal 一条回执；渲染正文的拼接复现回复；超上限的第 0 段走文本且不建卡；
  第 k 段溢出把尾部切到文本并持久化 `mode: 'text'`；重启恢复累积正文并编辑同一个
  `outTrackId`；被逐出的进度把尾部以文本送达，绝不重新建卡。
- **纪律见证**：确定性卡片拒绝回执 `rejected` 并停止投递；含糊失败回执
  `unknown`；两者都不发出第二次创建或更新；副作用前的持久化失败把投递放弃给租约
  reconciler，并回滚 outbound 条目与卡片映射；孤儿卡片分段重放已持久化回执或落
  `unknown`；非 accepted 回执剪掉进度；`delivered` 回执剪掉已完成投递的正文，而
  `partial` 回执保留；确定性卡片拒绝不逐出缓存的 `sessionWebhook`（卡片 API 的
  判定不等于 webhook 的健康）。
- **门见证**：无 `cardTemplateId` → 逐字节文本路径；`cards: false` 且有模板与卡片
  deps → 文本路径；缺卡片 deps → 文本路径；重发投递推导出不同的 `outTrackId`；
  配置了但不可用的模板 id 播报一次并仍走文本。
- **dep 见证**（`managed-dingtalk-deps.test.ts`）：`create` 命中
  `createAndDeliver`，编辑命中 `PUT /v1.0/card/instances` 且带
  `updateCardDataByKey`；目标是 `IM_ROBOT.<senderId>`；token 被缓存、提前一分钟
  刷新（在 `expires_in - 60 ± 1s` 处见证）、60 秒下限使短 `expires_in` 不会缓存
  一个已过期 token、401 作废并重试一次；永久 token errcode 判确定性、瞬态不判；
  配置代理时使用 dispatcher，且仅在响应 body 被消费后才销毁（一个「dispatcher
  销毁后即报错」的流式 body 钉住该顺序）。
- **strict 响应见证**（`interactive-card-client.test.ts` 与 deps）：Legacy
  （非 strict）对非 JSON 200 body 与缺失 `deliverResults` 都正常返回；strict 对
  不可读 body、缺失或空 `deliverResults` 抛含糊错，仅在确认 success 时正常返回；
  编辑遇可读 body 正常返回、不可读则抛错。
- **状态见证**（`managed-state.test.ts`）：不带 `cards` 的状态仍然通过校验（向后
  兼容）；映射上限与条目形状被强制；超上限或畸形映射被拒绝。适配器上限测试断言
  逐出身份（最久未触碰者被逐出、最新者存活）以及被重新触达的投递能存活，而不只是
  数量。
- **设置见证**（`channel-settings-store.test.ts`）：携带 `cardTemplateId` 的
  DingTalk 配置可 upsert（声明该字段前会被拒为 not manageable），描述符出现在渠道
  catalog 中，修改后的值也能 upsert。
- **变异检查**：移除能力门、模板门、溢出检查、副作用前持久化、确定性
  `outTrackId`、逐出安全的文本回退、进度剪枝、回滚快照拷贝、卡片拒绝 webhook
  守卫、delivered 剪枝、代理 body-先于-销毁顺序、strict 响应判定、token 提前刷新/
  下限、或逐出身份，各自红掉对应见证。
- **基线**：现有 DingTalk managed 套件、channel-base 契约套件、core 记录/操作/
  权限套件与 CLI 漏斗套件保持原样全绿；`npm run build && npm run typecheck &&
npm run lint`。

## 验收标准

- 支持卡片且已配置的适配器把一次投递渲染成一张 provider 原生卡片；第一段之后的
  分段是对这张卡片的编辑。
- 分段回执仍是权威且写一次；卡片分段的 `providerMessageId` 是 provider 侧编辑
  句柄。
- partial 与 `unknown` 行为不变：丢失确认绝不触发自动二次发送，失败或含糊的编辑
  可见地落定（`rejected` / `unknown`），不重试。
- 没有声明或没有模板的适配器逐字节保持今天的文本行为。
- 溢出可见且完整：卡片承载它装得下的前缀，尾部以文本送达，每段一条真实回执。

## 待决问题

1. **模板制作。** 运营必须创建一个把 markdown 组件绑定到 `content` 的卡片模板。
   项目是否随附参考模板定义（以及如何版本化）是本切片之外的产品决策。
2. **公开读模型里的卡片元数据。** 在 `PublicChannelDeliverySegment` 上暴露卡片
   句柄或渲染模式需要闭合键、Java、SQL 与 OpenAPI 工作并 bump 契约版本；此处刻意
   不做。
3. **流式与 finalize。** 流式卡片界面（输入指示、增量追加）需要 claim 协议今天
   不携带的「最后一段」信号；全量快照编辑避开了它。
4. **群卡片。** managed 路径丢弃群帧；群卡片策略随群准入后续工作，不在本切片。
