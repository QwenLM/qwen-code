# 托管渠道第四适配器：企业微信（WeCom）

[English](2026-11-16-managed-channel-wecom-adapter.md) | [简体中文](2026-11-16-managed-channel-wecom-adapter.zh-CN.md)

状态：提议中。本切片是托管渠道路径
（[#12827](https://github.com/QwenLM/qwen-code/issues/12827)）的第四适配器，
承接 DingTalk 第二适配器
（[2026-11-13-managed-channel-dingtalk-adapter](2026-11-13-managed-channel-dingtalk-adapter.zh-CN.md)）
与 GitHub 第三适配器
（[2026-11-16-managed-channel-github-adapter](2026-11-16-managed-channel-github-adapter.zh-CN.md)）。
提供方选用现有 WeCom 智能机器人（`wecom` 渠道类型，botId + secret，走
`@wecom/aibot-node-sdk` WebSocket），由产品优先级确定并经维护者确认。只发不收的
群 webhook 与自建应用 callback 是 WeCom 的另外两种连接方式，均不在本切片内
（见范围边界）。

## 问题

托管渠道路径现有 email、DingTalk 与 GitHub 三个适配器。WeCom 是一等 Legacy 渠道
（智能机器人、应用 callback、群 webhook），但没有托管路径适配器，因此 WeCom
机器人无法把入站消息路由进绑定的 Managed Agent Session，也无法通过控制面的
发件箱投递带回执的回复。共享适配器契约（`ManagedChannelAdapter`、
`ManagedChannelPolicy`、`ManagedChannelControlPlane`、`ManagedInboundEvent`、
`ManagedClaimedDelivery`、`ManagedReceipt`）已在 `channel-base`；启用列表为
`['email', 'dingtalk', 'github']`。

## 现状（已经通用的部分）

控制面是平台无关的，因此与 DingTalk 切片一样，这主要是一个 TypeScript 切片：

- Java 侧 `ChannelPolicy.adapter` 按模式 `[a-z][a-z0-9-]{0,63}` 校验（不是适配器
  枚举）；`platform` 是有界字符串；reply context 是适配器不透明的 JSON，认领时
  原样回显。Java 侧没有适配器启用门——启用在 TypeScript core
  （`MANAGED_SESSION_ENABLED_CHANNEL_ADAPTERS`）。无需 Java 改动。
- 分段账本、认领预算、回执一次写入规则与 partial/resume 重新认领已支持 1–64
  段，且平台无关。
- WeCom 包已依赖 `@qwen-code/channel-base` 与 `@wecom/aibot-node-sdk`；Legacy
  `WeComChannel` 展示了提供方机制：SDK 在认证后的 WebSocket 上推送入站消息帧
  （`message.text` 及兄弟事件），`sendMessage(chatid, body)` 经同一连接主动发送
  markdown，以提供方回执帧 resolve。单聊时 SDK 的 `chatid` 即用户 userid；
  Legacy 渠道在单聊帧不带 `chatid` 时已回退到发送者 userid。
- 共享命令工厂 `createManagedChannelCommand` 承载参数面、控制面接线与生命周期；
  提供方只需提供适配器工厂与面向用户的文案。

有两处提供方机制与 DingTalk 不同，且是承重的：

1. **入站无 ack、不重投。** SDK 把 `aibot_msg_callback` 帧分发给事件处理器，
   从不向提供方确认；提供方也不重投。DingTalk 流对每帧回 ack（SUCCESS /
   LATER）并重投未确认帧。因此 WeCom 适配器没有「留待重投」臂：无法持久化暂存
   的帧就是丢失，必须按丢失记录日志。
2. **没有 session webhook。** DingTalk 回复指向会话的 `sessionWebhook`——一个
   会过期的 bearer 能力，所以 DingTalk 适配器要缓存、快照与逐出 webhook。
   WeCom 回复经活着的认证 WebSocket、仅以 `chatid` 定位；没有逐消息的能力需要
   持久化、缓存或逐出。reply context 携带的是身份，不是凭据。

## 决策

在 DingTalk 适配器旁新增托管 WeCom 适配器，镜像其纪律：每个认领先持久化再产生
副作用，重启重放同一事件或把同一段报为 `unknown`，绝不产生第二次输入、绝不
第二次发送。

- **共享契约。** `channel-base` 的 `ManagedChannelAdapter` 放宽为
  `'email' | 'dingtalk' | 'github' | 'wecom'`，命令工厂的 `adapterType` 联合同步放宽。这是
  已发布包类型的增量放宽；既有导出形状不变。
- **启用。** core 的 `MANAGED_SESSION_ENABLED_CHANNEL_ADAPTERS` 增加 `'wecom'`，
  并更新钉死的契约测试。Java 模式已接纳该名字。
- **`ManagedWecomAdapter`。** deps 注入的适配器。入站来自 SDK 的 `message.text`
  事件；一个文本帧成为控制面准入的一个平台事件。出站把每个认领段经活着的 SDK
  客户端发到会话 `chatid`，按 ordinal 回执；多段答案是若干条有序消息。
- **身份与范围。** 路由范围是 `chat_thread`，以会话 id 为键：帧带 `chatid` 时
  用它，否则用发送者 userid（Legacy 渠道与 SDK 发送契约都用的单聊回退）。发送者
  身份是 `from.userid`。reply context 为 `{ chatId, senderId, botId }`，随输入
  提交、由发件箱回显。
- **命令。** `managed-wecom` CLI 命令经共享工厂把适配器接到
  `HttpManagedChannelControlPlane`，镜像 `managed-dingtalk`。与其他托管入口一样
  是实验性、显式选择的：`qwen channel start` 不会选它，它也不驱动模型。

### 入站暂存（ack-once 纪律的适配）

SDK 事件处理器在返回前把帧同步暂存为持久认领；异步准入留给 tick，与 DingTalk
完全一致。因为提供方不重投，持久化的认领是唯一副本：重启重驱动这个确切的持久化
事件，绝不重建。`store.save()` 失败无法把帧留待重投——丢帧并记录丢失日志
（latched，磁盘故障不会刷屏）。这是相对 DingTalk LATER 臂的刻意分歧。

门禁因三种原因拒绝入站帧，闩锁诊断逐一点名：32 条认领表已满、instance 停摆已
武装、或渠道正在重注册（`registeredGeneration === 0`）。这样的帧从未暂存，所以
这是丢弃唯一副本——而非丢弃已落盘的认领——在不重投的提供方上就是永久丢失。另一
类是确定性准入拒绝：它丢弃已暂存的认领并把其 id 记入 `recent`。逐消息裁决
（400/403/409）首次拒绝即丢弃；instance 级拒绝（`workspace_not_found` 及同类）
牺牲第一条、从第二条起 held，停摆准入直到绑定应答。held 认领每个 tick 重驱动；
被丢弃的认领已消失，其 id 的重投会被 `recent` 排重吃掉。

帧仅在以下条件全部满足时暂存；其余帧一律丢弃并输出点名原因的诊断行（只记 id，
不记正文）：

- 带 `msgid`（排重键；无它的帧无法跨重启排重）；
- 是单聊（`chattype` 不是 `group`）——托管路径在私聊策略下服务私聊，与
  DingTalk 切片同一决策：在私聊策略下回复群会把回复发到每个成员可读的地方；
- 是文本帧且 `text.content` 非空；
- 带发送者 userid 与可解析的会话 id；
- 发送者通过 email 形状的 `senderPolicy`（allowlist / open / disabled；
  `pairing` 在构造期拒绝，与 DingTalk 一致）。

排重同时对照已落定的 `recent` 窗口与在途的 `pending` 认领。入站文本在提交前按
DingTalk 适配器同款钳制收敛到线上界：至多 32,000 UTF-16 单元（服务端
`maxTextChars` 按 UTF-16 计；尾部高代理回退一格）与 Harness 64 KiB JSON 信封
减去元数据开销，按码点边界切割。超长消息按截断准入，而不是撞上确定性拒绝被
整条丢弃。钳制是适配器旁的本地副本，与 DingTalk 一致；提升到 `channel-base`
会触碰已发布包与 DingTalk 适配器，却没有行为收益。

没有回复目标准入门（DingTalk 的「无 sessionWebhook 且无缓存」丢弃）：回复目标
是活客户端加会话 id，适配器连接期间恒可用。

### 出站投递与回执纪律

出站协议沿用 DingTalk 不变：守卫认领阶段，按序发送每段，发送前持久化出站条目、
发送后持久化回执，报告回执，然后才移除条目。无法报告的回执在下一 tick 重驱动
——绝不重发。持久化的回执在重启时重放；发送从未产生结果的段落落定 `unknown`。
单条投递无法报告的回执绝不中止已认领的批次。

两个 WeCom 特有决策：

- **失败分类。** SDK 的 `sendMessage` 在 socket 失败、回执超时、队列溢出或回执帧
  `errcode` 非零时 reject。aibot 发送路径没有经过验证的 errcode 可重试性表
  （SDK 未提供），因此所有发送失败都分类为 `unknown`——可重驱动，绝不声称确定性
  拒绝。把未验证的 errcode 判为确定性，可能让被限流段的整条投递落定 `rejected`
  且余段永不发送——正是 DingTalk 瞬态 errcode 集合防止的失败。发送前校验臂
  （缺会话 id 或当前策略拒绝的发送者）仍报 `rejected`，因为该拒绝本地可证。
  经过验证的 errcode 表是后续工作。
- **提供方消息 id。** 回执的 `providerMessageId` 是本地生成的 UUID，与 DingTalk
  一致：send-msg 回执帧的 body 形状未验证携带提供方消息 id，而账本需要的正是
  本地关联 id。

账本段可能超过 WeCom 单条 markdown 预算，因此 deps 用共享的结构感知切分器
（`splitMarkdown`，目标 3,800 UTF-8 字节、上限 20,000——Legacy 渠道的预算）切分
并按序发送各块；一个回执仍覆盖整个账本段。部分块已送达后的失败是 `unknown`
（该段部分送达，而非从未发送），全 unknown 分类已保证这一点。

### 流生命周期

生产 deps 包装 SDK 客户端：

- `connect()` 仅在 SDK `authenticated` 事件后 resolve，以 30 秒超时为界（Legacy
  渠道的界）；认证前的认证错误或被踢 reject。首次失败必须暴露给运维——错误凭据
  不能报告一个永久失聪的健康启动。SDK 错误文本先脱敏再记日志（可能携带凭据
  材料），与 Legacy 渠道一致。
- 客户端配置为无限重连与无限认证失败重试（`maxReconnectAttempts: -1`、
  `maxAuthFailureAttempts: -1`）：瞬态断连或会话中凭据轮换靠重试自愈，镜像
  DingTalk deps 的永久重试纪律。SDK 的心跳与 missed-pong 检测驱动重连。
- 服务端踢下线（`event.disconnected_event`，新连接取代了本连接）是致命的：重连
  会反过来取代新主人。deps 经 `onStopped` 回调通知适配器；适配器记录日志、把自身
  标记为 `displaced`、停止，并在 park 期间释放状态锁——被踢取代的是 WebSocket 而非
  锁（锁仍归我们），故该条目的重启可以获锁，而不必等到 SIGTERM。displaced 适配器
  在关闭时还跳过共享渠道行的 `disconnect()`：服务端 disconnect 无 generation 守卫，
  注销会 409 新主人并丢弃 WeCom 永不重投的入站帧。这刻意不同于所有权丢失的形状——
  锁被回收时锁归另一进程、不释放，且持久化被抑制（但出于同一原因，该路径同样跳过
  行注销）。
- 只把 `message.text` 转发给适配器。非文本帧（图片、语音、文件、视频、图文混排）
  被丢弃并输出点名帧类型的闩锁诊断；媒体与混排文本支持是后续工作，不在本切片。

### 状态

适配器的带锁状态镜像 DingTalk 存储、去掉 webhook 映射：版本、账号 generation、
实例拒绝连击、pending 认领（完整持久化事件，上限 32）、出站分段账本（上限 64，
共享 `MANAGED_OUTBOUND_LIMIT`）、已落定排重窗口（上限 256）。每个配置条目
（渠道 name + botId）每个工作区范围一个目录
（`~/.qwen/channels/<workspace-scope>/wecom-<hash>`），与 DingTalk 存储相同的
name+account key 形状；`0700` 目录内 `0600` 状态文件，原子写 + fsync + rename，
校验器拒绝不可读或非法状态而非静默重置。目录锁（`proper-lockfile`，WeCom 包的
新依赖）串行化该条目的并发托管实例；共用同一 botId 的两个条目得到不同目录与不同
锁（SDK 随即只允许一个连接并踢掉另一个），因此复制或改名条目是运维配置问题，
锁不会合并它们。Legacy WeCom 渠道不加锁，所以锁不仲裁 managed-vs-Legacy。锁被
破坏时适配器停止并停止持久化，与 DingTalk 一致。reply context 不携带 bearer
能力，因此盘上暴露面严格小于 DingTalk 持久化的 session webhook。

## 涉及文件

- `packages/channels/base/src/managed-channel.ts` —— 适配器联合放宽为四个提供方；
  导出形状其余不变。
- `packages/core/src/managed-runtime/managed-session-records.ts` —— 启用列表增加
  `'wecom'`；`managed-channel-record.test.ts` 更新其钉死断言。
- `packages/channels/wecom/src/managed-wecom-adapter.ts`、
  `managed-wecom-deps.ts`、`managed-state.ts`（新增）—— 适配器、生产 deps 与
  持久化状态。
- `packages/channels/wecom/src/index.ts` —— 导出适配器、设置解析器、deps 工厂
  及其类型。
- `packages/channels/wecom/package.json`、`pnpm-lock.yaml` —— 增加
  `proper-lockfile`（类型作为 dev 依赖）。
- `packages/cli/src/commands/channel/managed-channel-command.ts` —— `adapterType`
  联合放宽。
- `packages/cli/src/commands/channel/managed-wecom.ts`（新增）—— 命令。
- `packages/cli/src/commands/channel.ts` —— 注册命令；`channel.test.ts` 与
  `managed-channel-command.test.ts` 钉死注册。
- 每个新模块的同位测试；Legacy WeCom 套件保持基线不变。
- 本设计文档及其中文版。

## 范围边界

- 不改分段账本、认领预算、回执一次写入规则、partial/unknown 恢复——已平台无关。
- 不改 Java 控制面：适配器名与不透明 reply context 由既有模式接纳。实现中发现的
  任何 Java 侧提供方特有需求，先点名再添加。
- 不做群聊策略（托管路径只服务私聊）、不做附件或媒体（入站或出站）、不做图文
  混排帧、不做交互卡片或流式回复、不做主动发送或自动化。
- `wecom-callback`（自建应用）与 `wecom-webhook`（只发群）连接方式在本切片不是
  托管适配器；webhook 根本无法接收输入。
- 不做出口代理接线：两个方向都走 SDK WebSocket，Legacy WeCom 渠道也没做代理
  支持。仅代理部署的需求被证实后再作后续。
- Legacy `WeComChannel`、`WeComCallbackChannel`、`WeComWebhookChannel` 不变。
- 确定性发送失败 errcode 表等待经过验证的提供方语义；在此之前所有发送失败都是
  `unknown`。

## 验证计划

- 契约见证：放宽后的联合接受 `wecom` 且仍接受 `email`、`dingtalk` 与 `github`；启用接纳
  `wecom` 且仍拒绝未知适配器；email、DingTalk 与 GitHub 套件不变保持绿。
- 适配器见证（deps 注入、无真实提供方），镜像 DingTalk 套件：入站帧准入一次且
  重投重放；群帧、非文本帧、无 `msgid` 帧与被拒发送者各带诊断丢弃；无 `chatid`
  的单聊帧按发送者 userid 路由；超长入站文本截断到线上界；保存失败丢帧并记录
  丢失（无重投臂）；多段认领按序发送每段并按 ordinal 回执；非 accepted 段停掉
  其投递余段；所有发送失败报 `unknown`、绝不二次发送；持久化回执重启重放；
  确定性准入拒绝、实例级停摆（含跨重启）与注册拒绝后重新注册各红其案；被踢停止
  适配器。
- deps 见证对假 SDK 客户端：认证等待在 `authenticated` resolve、在超时/错误/被踢
  reject；只有 `message.text` 到达适配器；被踢调用 `onStopped`；超预算段切成有序
  的提供方尺寸块；断连客户端的发送瞬态失败。
- 真实提供方腿（认证 WebSocket 入站 + `sendMessage` 出站）在 deps 允许处以讲
  aibot 帧协议的回环端点演练；真实租户冒烟需要 WeCom 智能机器人凭据，是后续工作，
  不是合并门。

## 决策清单

1. 连接方式选用智能机器人 WebSocket（现有 `wecom` 渠道类型），经维护者确认。它
   与 DingTalk 流机器人最接近，且无需公网端点。
2. 回复仅用活 SDK 客户端的 `sendMessage`；没有 `response_url` 或被动回复兜底。
   reply context 携带 `{ chatId, senderId, botId }`，不含凭据。
3. 发送者身份是 `from.userid`，受 email 形状 `senderPolicy` 门控。群帧
   （`chattype 'group'`）丢弃：托管路径服务私聊，显式群策略是后续工作。
4. 所有发送失败为 `unknown`，直到存在经过验证的 errcode 可重试性表；发送前校验
   拒绝为 `rejected`。回执的 `providerMessageId` 是本地 UUID。
5. 超过单条 markdown 预算的出站段在 deps 内切成有序的提供方尺寸块（3,800 /
   20,000 UTF-8 字节，Legacy 预算）；一个回执覆盖整个账本段。
6. 服务端踢下线停止适配器；瞬态断连与认证失败在 SDK 内永久重试。首次连接必须
   暴露其失败。

## 开放问题

当前范围无阻塞问题。真实平台冒烟需要一个真实的 WeCom 智能机器人凭据；在拿到
之前，真实平台验收保持为显式缺口，与 DingTalk 切片一致。
