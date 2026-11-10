# Managed Channel 公开 segments 投影

[English](2026-11-10-managed-channel-segments-projection.md) | [简体中文](2026-11-10-managed-channel-segments-projection.zh-CN.md)

状态：提议中。本文是 [#12827](https://github.com/QwenLM/qwen-code/issues/12827)（Managed Agent 提案 [#12380](https://github.com/QwenLM/qwen-code/issues/12380)）H5 channel 域中，接续[多分段交付台账](2026-11-10-managed-channel-multi-segment-ledger.zh-CN.md)的 API 切片。它堆叠在台账切片之上：公开投影读取台账切片引入的 `ma_channel_segment` 表，因此其 base 在台账 PR 合入前是台账分支，合入后 retarget 到 `main`。

## 问题

台账切片已让控制面的逐段身份与写一次回执持久化，但公开交付读模型仍只暴露单一的 `segment_id`、`ordinal`、`provider_receipt` 字段。`GET /v1/agent-channels/{channelId}/deliveries` 的读者看不到多分段交付的各个分段，也看不到哪个分段携带哪个回执。逐段明细已在台账中；没有公开面读取它。

## 决策

在 `PublicChannelDelivery` 上以增量方式暴露 `segments` 数组，保留既有单数字段。每个条目是一个 `PublicChannelDeliverySegment`，含 `segment_id`、`ordinal` 与可选的 `provider_receipt`。该数组是按 ordinal 有序的权威逐段视图；单一 `segment_id` 与 `ordinal` 继续命名第一个分段，`provider_receipt` 继续是交付的代表回执，因此既有消费者不被破坏。

采用增量而非替换单数字段：资源仍是 `partial`，但保留单数字段避免破坏性形状变更，让消费者按自己的节奏迁移到 `segments`。数组必填且非空（`minItems: 1`、`maxItems: 64`），与记录契约的 1–64 分段计划一致；交付行可见前其分段必已规划。

契约版本从 1.108.0 升到 1.109.0。Java 记录与 OpenAPI 模式同步变更，由记录↔模式契约门强制；channel 路由门保持三条路由与模式为 `partial`。

### 服务读路径

`publicDelivery` 为每个交付行从分段台账（`ChannelSegmentRepository.list`）构建数组。`listDeliveries` 与 `getDelivery` 逐交付读台账。这是有界的逐行读（交付页至多 100 行）；若读路径需要，批量读分段是后续优化。

### WebShell

channel 路由标签是 `Public Resources` 而非 `WebShell`，故 WebShell 类型生成器不产出 channel 类型。再生 WebShell 类型不产生 channel 变化；无 WebShell 消费者受影响。

## 涉及文件

- `contracts/.../model/ApiModels.java` —— `PublicChannelDelivery` 的 `segments` 与新记录 `PublicChannelDeliverySegment`。
- `contracts/.../openapi/managed-agent-public-api.openapi.json` —— `segments` 属性、`PublicChannelDeliverySegment` 模式与版本升级。
- `control-plane/.../channel/ManagedChannelService.java` —— 公开读路径从分段台账构建数组。
- `verification/.../ManagedAgentApiContractTest.java` —— 新记录的模式映射与 channel 夹具的分段行。
- `verification/.../ChannelContractTest.java` —— partial 模式门中的新模式。
- `verification/.../channel/ManagedChannelServiceTest.java` —— 多分段交付的公开读断言。
- 本设计文档与其中文版本。

## 范围边界

- 不改 journal 记录契约、Harness 漏斗、可信适配器面、分段台账模式或交付状态线。
- 不改 WebShell 消费者（channel 非 WebShell 标签）。
- 单数字段保留；若消费者完全迁移到 `segments`，移除它们是后续的破坏性变更决策。

## 验证计划

- 记录↔模式契约门与路由响应契约门在记录与模式同步后通过；channel 夹具种入分段行，使 served 的 `segments` 数组满足 `minItems: 1`。
- 一个多分段服务用例断言 `getDelivery` 与 `listDeliveries` 暴露每个分段及其各自回执。
- 改动模块 Checkstyle 通过；WebShell 类型再生无漂移。

## 未决问题

1. 若读取量需要，列表路径上逐交付分段读的批量化。
2. 后续切片是否在消费者使用 `segments` 后移除单数字段。
