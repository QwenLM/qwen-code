# Managed channel 第二适配器：DingTalk（H5d）

[English](2026-11-13-managed-channel-dingtalk-adapter.md) | [简体中文](2026-11-13-managed-channel-dingtalk-adapter.zh-CN.md)

状态：提议中。这是 [#12827](https://github.com/QwenLM/qwen-code/issues/12827)
切片 **H5d** 的第二适配器部分。多分段生产者那一半已由 #17002 落地；其供数的逐段
台账由 #16797 落地、#16818 加固。本切片把第二个真实 provider 接上 managed 路径，
让多分段交付能力在 email 之外被真实演练。provider 按产品优先级选 DingTalk。

## 问题

managed channel 路径目前只有 email 一个适配器。路由策略的 `adapter` 与控制面
`platform` 都是字面量 `'email'`，启用列表是 `['email']`。共享适配器契约
（`ManagedChannelPolicy`、`ManagedChannelControlPlane`、`ManagedInboundEvent`、
`ManagedClaimedDelivery`、`ManagedReceipt`）定义在 email 包内，CLI 的 HTTP 客户端
从那里导入。因此第二个 provider 既需要一个新适配器，也需要把这份契约做小幅通用化，
让两个包能共享而互不依赖。

## 现状（哪些已经通用）

调研发现控制面已然 provider 无关，故本切片主要是 TypeScript 工作：

- Java `RegisterRequest.adapter` 用模式 `[a-z][a-z0-9-]{0,63}` 校验（并非 email
  枚举）；`platform` 是有界字符串；回复上下文是适配器不透明 JSON、领取时原样回传。
  Java 侧没有 adapter 启用闸——启用在 TypeScript core
  （`MANAGED_SESSION_ENABLED_CHANNEL_ADAPTERS`）。
- `ManagedClaimedDelivery.segments[]` 与 `ManagedReceipt`（accepted 带
  `ordinal`/`providerMessageId`/`acceptedAt`，或 `unknown`/`rejected`）已多分段
  就绪；领取受 `maxClaimTextBytes` 预算约束（#17002），适配器在每次回执后重领其余。
- DingTalk 包已依赖 `@qwen-code/channel-base` 与 `dingtalk-stream-sdk-nodejs`；
  Legacy `DingtalkChannel` 展示了 provider 机制（stream 入站；
  `conversationId → sessionWebhook` 出站）。

## 决策

在 email 之外新增 managed DingTalk 适配器，并把共享适配器契约上移到
`channel-base`，让两个 provider 与 CLI 共享。

- **共享契约 → `channel-base`。** 把 `ManagedChannelPolicy`、
  `ManagedChannelControlPlane`、`ManagedInboundEvent`、`ManagedClaimedDelivery`、
  `ManagedReceipt` 从 email 包移入 `channel-base` 的 `managed-channel` 模块。把
  `adapter`/`platform` 的字面量 `'email'` 放宽为联合 `'email' | 'dingtalk'`。
  email 包与 CLI HTTP 客户端改从 `channel-base` 导入；email 行为不变。入站事件的
  回复上下文保持适配器不透明（`unknown`）；各 provider 自定义自己的回复上下文形状。
- **启用。** `MANAGED_SESSION_ENABLED_CHANNEL_ADAPTERS` 增加 `'dingtalk'`。Java
  模式本就接纳它；名字无需 Java 改动。
- **`ManagedDingtalkAdapter`。** deps 注入的适配器，沿用 email 适配器的纪律：每次
  领取先持久化再副作用，重启重放同一事件或把同一段报 `unknown`，绝不二次入站、绝不
  二次发送。入站经 DingTalk stream 客户端（`dingtalk-stream-sdk-nodejs`）；一条消息
  成为控制面准入的一个平台事件。出站把每个被领取的分段发到会话的 `sessionWebhook`
  并按 ordinal 回执；多分段答案是若干有序消息，中断的发送经既有 partial/resume
  协议只恢复已证明未发送的分段。
- **身份与 scope。** 路由 scope 为 `chat_thread`，以 DingTalk `conversationId`
  为键；发送者身份用 staff/sender id。回复上下文携带回复所需（会话 id、session
  webhook、发送者与机器人身份），随 input 提交、由 outbox 回传。
- **命令。** `managed-dingtalk` CLI 命令把适配器接到
  `HttpManagedChannelControlPlane`，仿照 `managed-email`。

### 交付与回执纪律（出站与 email 一致）

适配器绝不驱动模型。入站由控制面准入（Session journal 中的路由绑定 + input +
wake）；回复经适配器拉取的带回执 outbox 返回。每段的发送结果先于其回执持久化，故
发送与回执之间崩溃会重放为 `unknown`，绝不重复发送。#17002 的领取预算与重领协议
原样适用。

有一处入站分歧是承重的。email 的待决领取只存消息 UID，因为重启后信箱能重新提供该
消息。DingTalk 流在收到每条消息时即 ack、绝不再投递，也没有可重拉的信箱——因此待决
领取持久化完整的入站事件。重启重驱的正是这条持久化事件；绝不能丢弃一条已无法重建的
准入。

入站文本在提交前被钳制到线上可接纳的上界——至多 32,000 个 UTF-16 单元（上限按
UTF-16 计，因服务端 `maxTextChars` 如此；末尾高代理会回退一格以保持文本良构），以及
Harness 的 64 KiB 字节信封。字节上限以 JSON 序列化后的文本度量——控制字符占 6 字节、
引号或反斜杠占 2 字节——并按码点边界切割。因此超长消息以截断形式被准入，而不是撞上
确定性拒绝后被整条丢弃。注意这与 email 参考实现的钳制有意不同：email 仍按原始 UTF-8
长度计；若照抄 email 的原始字节预算，会重新引入本钳制所防止的转义膨胀拒绝。

回复上下文中的 `sessionWebhook` 是一种 bearer 能力。重启持久化要求把它随状态一起落盘
（`0700` 目录下的 `0600` 文件），而 Legacy 通道只把它放在内存 map 里。相对 Legacy 这是
新增的磁盘暴露面，是 ack-once 重驱所必须付出的代价。

## 涉及文件

- `packages/channels/base/src/managed-channel.ts`（新增）——共享适配器契约，放宽为
  双 provider 联合；从 base index 导出。
- `packages/channels/email/src/managed-email-adapter.ts`、`managed-state.ts`——
  改从 `channel-base` 导入共享契约；email 行为不变。
- `packages/cli/src/commands/channel/managed-channel-client.ts`——改从
  `channel-base` 导入契约。
- `packages/core/src/managed-runtime/managed-session-records.ts`——启用列表加
  `'dingtalk'`。
- `packages/channels/dingtalk/src/managed-dingtalk-adapter.ts`、
  `managed-dingtalk-deps.ts`、`managed-state.ts`（新增）——适配器、生产 deps、持久化
  状态。
- `packages/cli/src/commands/channel/managed-dingtalk.ts`（新增）——命令。
- 各自同位测试；channel service/contract 套件仍为基线。
- 本设计文档及其中文版。

## 范围边界

- 不改分段台账、领取预算、回执写一次规则或 partial/unknown 恢复——它们已处理 1–64
  段且 provider 无关。
- adapter 名字与不透明回复上下文无需 Java 控制面改动；实现中若发现 Java 侧的
  provider 特定需求，先明示再加入。
- 不做 DingTalk 交互/卡片表面（H5e）、不做内联暂存之外的附件种类（Media）、不做主动
  发送或自动化（H6）。
- Legacy `DingtalkChannel` 的行为不变；对 Legacy 的唯一改动是把 connect-logging 凭据
  守卫抽到共享模块、使其只有一份。managed 适配器是复用 provider 机制的独立实现，而非
  复用 Legacy 类。

## 验证计划

- 契约见证：放宽的联合接纳 `dingtalk` 且仍接纳 `email`；启用接纳 `dingtalk` 且仍拒
  未知 adapter；契约移动后 email 既有套件保持绿色不变。
- 适配器见证（deps 注入、无真实 provider）：一条入站消息被准入一次、重投递重放；超长
  入站文本被截断到线上上界而非丢弃；多段领取按序逐段发送并按 ordinal 逐段回执；非
  accepted 的分段停下其投递的其余分段；发送失败报 `unknown`、绝不二次发送；持久化回执
  在重启后重放而非落 `unknown`；确定性准入拒绝、实例级停滞（含跨重启）与注册拒绝后重注册
  各有用例转红。中断后恢复仍未发送的分段，属控制面的 partial/resume 重领（#17002），
  此处不改。承重规则均由经变异验证的见证钉住；其余覆盖缺口记录于 #17173。
- 真实 provider 腿（stream 入站 + sessionWebhook 出站）在 deps 里对假 DingTalk 端点
  演练，仿 email 适配器的假传输测试；真实租户冒烟是后续、非合并门禁。

## 决策（已落地）

1. 回复仅用会话的 `sessionWebhook`，不回退机器人 `groupMessages/send` /
   `oToMessages/batchSend` API。webhook 过期或被拒即确定性 `rejected` 回执。发送仍置于
   deps 之后，若需 webhook 生命周期回退，属局部后续改动。
2. 发送者身份为 `senderStaffId`、以 `senderId` 兜底，由 email 形状的 `senderPolicy`
   （allowlist / open / disabled）门控。群消息（`conversationType '2'`）被丢弃：managed
   路径服务私聊，在私聊策略下回复群会把回复发进群里、让每个成员读到。显式群策略
   （Legacy GroupGate 语义）属后续，不在本切片。
3. 超过 DingTalk 单条消息上限的出站分段，在 deps 内拆成有序的 provider 尺寸分块；
   一条回执仍覆盖整个台账分段。
