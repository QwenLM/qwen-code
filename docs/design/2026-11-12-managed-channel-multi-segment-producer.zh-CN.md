# Managed channel 多分段交付生产者（H5d）

[English](2026-11-12-managed-channel-multi-segment-producer.md) | [简体中文](2026-11-12-managed-channel-multi-segment-producer.zh-CN.md)

状态：提议中。这是 [#12827](https://github.com/QwenLM/qwen-code/issues/12827)
切片 **H5d** 的多分段计划部分，由
[#16998](https://github.com/QwenLM/qwen-code/issues/16998) 追踪。它建立在多分段
交付台账（#16797）及其加固（#16818）之上——台账已能对每次交付规划、发送、回执并
恢复 1–64 个分段；只有生产者仍只规划单段。

## 问题

`planChannelSegments` 今天恰好返回一个分段：把回复截断到
`MANAGED_CHANNEL_LIMITS.maxSegmentBytes`（48 KiB）并附加截断提示。超过一个分段的
回复因此在被规划之前就丢失了尾部。出站路径（`hosted-channel-session.ts`）随后
硬编码单元素 `segments` 数组，台账的多分段能力从未被真实回复用上。分段计划契约、
逐段写一次回执、分发器与 partial/unknown 恢复都已支持 1–64 段。

## 决策

把回复拆成有序分段，而不是截断成一段，并为每个分片规划一个台账分段。拆分、计划与
代表回复是三个独立关注点：

- **拆分。** `planChannelSegments(text)` 返回至多 `maxSegments`（64）个分片，
  每片至多 `maxSegmentBytes`（48 KiB）UTF-8，在码点边界切割。能装进一个分段的回复
  返回单个分片、不带提示（今天的短回复行为逐字节不变）。会超出 64 段的回复保留前
  64 段，并把既有截断提示附加到最后一个保留分片上，溢出可见、绝不静默。
- **计划。** 出站路径为每个分片发布一个分段资源，并按序号顺序以 `segmentId`
  `deliveryId:i` 构建 `segments` 数组，替换硬编码的单元素。分发器、回执与恢复
  不变：它们本就逐段运作。
- **代表回复。** 交付的 `contentRef` 回复资源沿用既有 envelope 拟合循环（内联
  回复仍须满足 `maxEnvelopeBytes`），公开读模型的代表回复因此与今天一样保持有界。
  完整答案由分段资源承载；模型完成与外部交付仍分开投影（H5c）。

拆分优先在字节预算内的最后一个换行处断开，使分段边界在有换行可用时落在行尾，否则
回退到码点边界切割。这在不改变字节上限与拼接结果的前提下保持分段可读。

### 拼接不变量

当输入能装进 64 段时，拼接所有规划分片文本精确还原输入；装不下时，拼接还原保留的
前缀加截断提示（最后一个保留分片在字节上限内为提示让出空间）。绝不切断码点，绝不
分段超出字节上限。这是回归见证所钉住的性质。

## 涉及文件

- `packages/core/src/managed-runtime/managed-channel-operations.ts` —
  `planChannelSegments` 由截断改为拆分；提示移到溢出情形。
- `packages/cli/src/serve/hosted-channel-session.ts` — 出站计划为每个规划分片
  建一个分段；代表回复沿用 envelope 拟合。
- 两者的同位测试，以及已演练多分段计划的 channel service/contract 套件。
- 本设计文档及其中文版。

## 范围边界

- 不改分段台账 schema、回执写一次规则、分发器或 partial/unknown 恢复——它们已
  处理 1–64 段。
- 不做第二适配器（H5d 的另一项，按产品优先级另选）。
- 不做卡片样式界面（H5e），也不做内联暂存之外的附件类型（Media）。
- 单段字节上限、64 段上限与 envelope 上限均不变。

## 验证计划

- 拆分的单元见证：短回复不变；多分段拆分拼接还原输入；每片在字节上限内且在码点
  边界；溢出保留 64 片并附加提示；移除拆分（退回截断）或移除提示会使对应用例转红。
- 出站计划见证：长回复规划 N 个分段资源、`deliveryId:i` id 按序；短回复仍规划一个。
- 既有多分段 service/contract/MySQL 套件仍是分发、回执与恢复在如今真实的多分段
  计划之上的基线。

## 未决问题

1. 代表回复最终是否应引用分段资源、而非携带一份拟合副本，是后续切片的读模型决策；
   本切片沿用今天的 envelope 拟合代表回复。
