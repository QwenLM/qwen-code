# Managed Channel 公开 segments 投影

[English](2026-11-10-managed-channel-segments-projection.md) | [简体中文](2026-11-10-managed-channel-segments-projection.zh-CN.md)

状态：提议中。本文是 [#12827](https://github.com/QwenLM/qwen-code/issues/12827)（Managed Agent 提案 [#12380](https://github.com/QwenLM/qwen-code/issues/12380)）H5 channel 域中，接续[多分段交付台账](2026-11-10-managed-channel-multi-segment-ledger.zh-CN.md)的 API 切片。它建立在已合入的台账切片（#16797）之上：公开投影读取台账切片引入的 `ma_channel_segment` 表。

## 问题

台账切片已让控制面的逐段身份与写一次回执持久化，但公开交付读模型仍只暴露单一的 `segment_id`、`ordinal`、`provider_receipt` 字段。`GET /v1/agent-channels/{channelId}/deliveries` 的读者看不到多分段交付的各个分段，也看不到哪个分段携带哪个回执。逐段明细已在台账中；没有公开面读取它。

## 决策

在 `PublicChannelDelivery` 上以增量方式暴露 `segments` 数组，保留既有单数字段。每个条目是一个 `PublicChannelDeliverySegment`，含 `segment_id`、`ordinal` 与可选的 `provider_receipt`。该数组是按 ordinal 有序的权威逐段视图；单一 `segment_id` 与 `ordinal` 继续命名第一个分段，`provider_receipt` 继续是交付的代表回执，因此既有消费者不被破坏。

采用增量而非替换单数字段：资源仍是 `partial`，但保留单数字段避免破坏性形状变更，让消费者按自己的节奏迁移到 `segments`。数组必填且非空（`minItems: 1`、`maxItems: 64`），与记录契约的 1–64 分段计划一致；交付行可见前其分段必已规划。若 resend 铸出的 id 已对应一个首分段不同（id 或 ordinal）的存储交付，会在规划任何分段之前被拒绝，因此被拒的 resend 不留孤儿分段行；匹配 id 的重放 resend 则收敛而非冲突。首段检查之外还有完整链比对：存储链与 resend 计划在任一分段分歧即被拒——否则 INSERT IGNORE（唯一键在 `segment_id`、不在 ordinal）会把两条链拼进同一交付，出现单个 ordinal 两行。存储链仅为计划的匹配**前缀**时是合法的部分落库瞬态，予以收敛（由计划补全）。拒绝还在领取导入处做成持久：漏斗在 resend 守卫运行前已把 resent 记录提交为 planned，而领取清扫从日记账发现待处理工作，故 `claimOne` 施加同一完整链比对，并把冲突记录落定出待处理集合，而非每轮清扫反复重导入。

本切片把契约版本从 1.108.0 升到 1.109.0；后续切片继续推进（#16846 从 1.113.0 升到 1.114.0），本次后续不再升版本。Java 记录与 OpenAPI 模式同步变更，由记录↔模式契约门强制；channel 路由门保持三条路由与模式为 `partial`。

### 服务读路径

`getDelivery` 的 `publicDelivery` 从分段台账（`ChannelSegmentRepository.list`）构建数组。`listDeliveries` 用一条 `listByDelivery` 查询读取整页（`WHERE delivery_key IN (...)`，按交付分组、按 ordinal 排序）；两条路径复用同一个 `RowMapper`，故不会对同一交付发布不同的 segments。

### WebShell

channel 路由标签是 `Public Resources` 而非 `WebShell`，故 WebShell 类型生成器不产出 channel 类型。再生 WebShell 类型不产生 channel 变化；无 WebShell 消费者受影响。

## 涉及文件

- `contracts/.../model/ApiModels.java` —— `PublicChannelDelivery` 的 `segments` 与新记录 `PublicChannelDeliverySegment`。
- `contracts/.../openapi/managed-agent-public-api.openapi.json` —— `segments` 属性、`PublicChannelDeliverySegment` 模式与版本升级。
- `control-plane/.../channel/ManagedChannelService.java` —— 公开读路径从分段台账构建数组；`resend` 拒绝存储链与应答分歧的 resent id（首段检查＋容忍部分落库前缀的完整链比对）。
- `contracts/.../persistence/ChannelSegmentRepository.java` 与
  `persistence/.../JdbcChannelSegmentRepository.java` —— `listDeliveries`
  使用的批量 `listByDelivery` 页读取。
- `verification/.../ManagedAgentApiContractTest.java` —— 新记录的模式映射与 channel 夹具的分段行。
- `verification/.../ChannelContractTest.java` —— partial 模式门中的新模式。
- `verification/.../channel/ManagedChannelServiceTest.java` —— 多分段交付的公开读断言，及 resend 链守卫用例（首段/仅 ordinal/后续段分歧被拒，前缀与带回执重放收敛）。
- 本设计文档与其中文版本。

## 范围边界

- 不改 journal 记录契约、Harness 漏斗、可信适配器面、分段台账模式或交付状态线。
- 不改 WebShell 消费者（channel 非 WebShell 标签）。
- 单数字段保留；若消费者完全迁移到 `segments`，移除它们是后续的破坏性变更决策。

## 验证计划

- 记录↔模式契约门与路由响应契约门在记录与模式同步后通过；channel 夹具种入分段行，使 served 的 `segments` 数组满足 `minItems: 1`。
- 一个多分段服务用例断言 `getDelivery` 与 `listDeliveries` 暴露每个分段及其各自回执。
- resend 链守卫由服务用例钉住：存储链在首段、仅 ordinal、或后续段分歧时以 `409 channel_delivery_conflict` 拒绝（WARN 记录分歧位置与两侧分段身份）；存储链仅为计划前缀、以及带回执链的重放，均收敛。各拒绝/收敛用例在移除对应守卫行为时转红。
- 改动模块 Checkstyle 通过；WebShell 类型再生无漂移。

## 未决问题

1. 后续切片是否在消费者使用 `segments` 后移除单数字段。
