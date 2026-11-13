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

### 交付与回执纪律（与 email 一致）

适配器绝不驱动模型。入站由控制面准入（Session journal 中的路由绑定 + input +
wake）；回复经适配器拉取的带回执 outbox 返回。每段的发送结果先于其回执持久化，故
发送与回执之间崩溃会重放为 `unknown`，绝不重复发送。#17002 的领取预算与重领协议
原样适用。

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
- Legacy `DingtalkChannel` 不动；managed 适配器是复用 provider 机制的独立实现，而非
  复用 Legacy 类。

## 验证计划

- 契约见证：放宽的联合接纳 `dingtalk` 且仍接纳 `email`；启用接纳 `dingtalk` 且仍拒
  未知 adapter；契约移动后 email 既有套件保持绿色不变。
- 适配器见证（deps 注入、无真实 provider）：一条入站消息被准入一次、重投递重放；多段
  领取按序逐段发送并按 ordinal 逐段回执；回执之间中断的发送只恢复未发送分段；发送失败
  报 `unknown`、绝不二次发送。每条规则逐一禁用都有用例转红。
- 真实 provider 腿（stream 入站 + sessionWebhook 出站）在 deps 里对假 DingTalk 端点
  演练，仿 email 适配器的假传输测试；真实租户冒烟是后续、非合并门禁。

## 未决问题

1. DingTalk 回复仅用 session webhook，还是在 webhook 过期时回退机器人
   `groupMessages/send` / `oToMessages/batchSend` API，实现时按 provider 的 webhook
   生命周期定；设计把发送置于 deps 之后，两者都是局部改动。
2. 群 @ 提及门控与发送者白名单复用 email 适配器的 `senderPolicy` 形状；DingTalk 的确切
   身份空间（staffId vs senderId）在实现时钉住。
