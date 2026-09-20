# Managed Session 记录基础

[English](./managed-session-record-foundation.md) |
[简体中文](./managed-session-record-foundation.zh-CN.md)

## 状态

本次变更实现本文描述的版本化记录类型和校验器，但不会启用 Managed Session
写入，也不会改变默认 Session 引擎。

## 问题

Managed Agent 需要一份权威历史，以便恢复模型、审批、工具和生命周期进度，
而不能从渲染后的聊天消息反推执行状态。在引入 writer、coordinator 或投影之前，
所有生产者和读取者需要共用一套有边界、带版本的记录契约。

## 目标

- 定义 v1 header、event 和 commit marker 记录。
- 在记录进入未来的 authority 或恢复路径前，拒绝格式错误、超限、有歧义或不受支持的内容。
- 通过 Core 包 API 提供稳定的 TypeScript 类型和解析器。
- 预留对应的 `ChatRecord` subtype，但不启用 writer。

## 非目标

- 向 transcript 追加记录。
- 获取 writer lease 或恢复不完整事务。
- 将 Managed 记录投影成普通聊天消息。
- 启动 Harness、Runtime、daemon 路由或后台进程。
- 迁移已有 Session 或改变其默认执行引擎。

## 记录契约

该基础层预留三种 system record subtype：

- `managed_session_header_v1` 标识格式、最低兼容 reader、Session key、Managed
  引擎及不可变 definition 引用。
- `managed_session_event_v1` 记录封闭 event-kind union 中的一项带 sequence
  事实，以及 subject、时间戳和 payload；独立校验器负责判断某类 actor 是否可请求
  该事件。
- `managed_session_commit_v1` 提交一段连续事件范围，并记录 command 身份、
  event digest 和上一个 commit digest。

v1 的 event kind、domain、actor class、action source 和 lifecycle state 都是封闭
集合，未知值校验失败。能够解析某个 domain 不代表启用了对应能力；后续组件仍负责
准入和授权。

## 编码与限额

记录只接受 JSON 兼容值。原始记录解析器会先拒绝重复对象 key、超过调用方指定
字节上限的记录、过深嵌套和非法 JSON；类型解析器再拒绝未知字段、非法标识、非
safe integer、非法状态转换，以及不是小写格式的 SHA-256 digest。

| 限额            |           v1 数值 |
| --------------- | ----------------: |
| 标识符          |   512 UTF-8 bytes |
| 有界自由文本    | 4,096 UTF-8 bytes |
| JSON 深度       |                64 |
| 单个 Event      |             1 MiB |
| Commit marker   |            64 KiB |
| 单事务 Event 数 |               256 |
| 编码后事务      |             8 MiB |

`eventsDigest` 对每个已提交事件的 `sequence`、`eventId` 和 `kind` 组成的
canonical JSON 计算 SHA-256。对象 key 排序，数组顺序保留，因此结果不依赖属性
插入顺序。

## 集成边界

Core 包导出记录常量、类型、原始及类型解析器、转换校验、事务校验和 digest
helper。未来 reader 必须先把 event 或 commit marker 对应的字节上限传给原始
解析器，再调用类型解析器。现有 `ChatRecord` 类型接受三种预留 subtype，便于
后续 writer 复用标准 transcript envelope。

本次变更没有调用方写入这些记录。后续工作必须通过独立变更加入单 writer
authority、持久资源、事务恢复、投影和 Harness checkpoint。

## 风险与缓解

- 过于宽松的解析器可能把损坏历史变成可执行状态。封闭 union、精确字段、字节限额
  和转换校验使不受支持的输入安全失败。
- 先导出格式、后实现 writer，可能被误认为功能已经启用。本次变更不增加构造路径、
  路由、配置开关或默认选择。
- 未来格式变化可能静默破坏旧 reader。不兼容修改必须提高 `formatVersion` 或
  `minimumReader`，并增加兼容测试。

## 验证计划

- 运行记录校验器定向测试。
- 运行 Core 包 typecheck。
- 验证恰好达到限额的记录可接受，超限记录失败。
- 验证重复 key、未知字段和 kind、非法 actor/subject 组合、非法转换和不连续事务失败。
- 验证 digest 稳定，并在事件顺序变化时改变。

## 验收标准

1. Core 导出 v1 常量、类型和校验器。
2. 原始记录解析执行调用方指定的字节和深度上限，类型解析对 header、event 和
   commit marker 执行 v1 schema 校验。
3. 事务身份 hash 是确定性的。
4. 没有生产调用方写入 Managed Session 记录。
5. 现有 Session 行为不变。

## 后续工作

下一项变更可以在此契约上实现串行 authority 和崩溃安全追加协议。资源存储、
transcript 投影、Harness 恢复和 Runtime 协调仍作为独立评审单元。
