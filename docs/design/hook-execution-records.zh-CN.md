# Hook 执行记录与传输

[English](hook-execution-records.md) | [简体中文](hook-execution-records.zh-CN.md)

状态：已实现，2026-11-12。验证和评审结果单独报告。

## 问题与范围

HookProgress 已描述本地执行，但没有安全、持久化的轮次统计。本次覆盖具有明确历史轮次归属的本地主 Agent Hook、持久化、ACP 传输、SDK 归并和分页读取。不包含 Web Shell UI、托管执行、异步最终结果或子 Agent 聚合。

## 契约与归属

实际开始回调捕获 UUID 和不可变的 runtime/session/历史 prompt 归属。ACP 在提问 Hook 前绑定历史归属，重试和继续执行保留原轮次。没有归属则不产生轮次记录。保留原进度字段并附加白名单 hookLifecycle 载荷。执行计划保留配置来源。名称使用显式配置名称或类型及批内位置，禁止使用命令、URL、提示词、输出和原始错误。

事件为 started、ended（success/blocked/error/timeout/cancelled）或 dispatched。异步派发单独记录耗时，不算成功终态。异步交接被拒记为错误；执行前已取消的批次不产生生命周期记录。结束事件携带完整身份。仅历史开始记录恢复为 unknown，并将持久化 coverage 标为 partial。记录或传输失败不得改变 Hook 决策，也不得把晚到事件写入另一个会话。

## 持久化与传输

复用 system/ui_telemetry，event.name 为 hook_lifecycle。沿用删除身份，分支复制重映射 session/prompt ID。提问前的 Hook 纳入该轮回退边界，完整／按需恢复重建同一边界，并拒绝已回退执行的晚到终态记录。诊断记录排除于模型历史和普通遥测恢复。bridge 压缩和生命周期恢复必须保留元数据。ACP 观察 MessageBus 替换和销毁，用空 agent_message_chunk 携带 \_meta.hookLifecycle。

纯 Core 契约提供浏览器可用的解析、归并和汇总，供 reader、bridge 与打包后的 SDK 共用。SDK 声明不依赖 Core。重复开始不能覆盖终态，身份冲突标记数据不完整。

## 轮次查询

GET /session/:id/turns/:promptId/hooks 及工作区限定形式返回 sessionId、promptId、snapshot、start、totalExecutions、summary、executions、nextStart 和 coverage。SDK 提供 getSessionTurnHooksPage。默认 limit 为 50，范围 1–500；start 必须携带签名 transcript snapshot。先归并所选 active branch 的全部已记录执行，再按 startedAt 和 executionId 排序分页。

两个路由均为 persisted-workspace scoped，复用 transcript 运行时解析、归档锁、generation 检查和存储上下文。live 首屏用现有 transcript barrier 刷盘，冻结页不重复刷盘。冷会话无需加载即可读取。未知、歧义或已移除运行时不回退到主运行时。旧轮次无记录为 unrecorded，托管会话为 unsupported，已知缺失为 partial。汇总表示已记录执行，不证明历史采集完整。

## 验证与交付

[E2E 计划](../plans/hook-execution-records-e2e.zh-CN.md)定义基线、真实命令场景和确定性回归检查。

验证真实 command Hook、取消、异步派发、重叠批次、重试和继续、晚到结束、多会话和工作区、重放顺序、分支／删除／回退、安全载荷、空白消息抑制，以及超过 1,000 次执行的冻结分页。执行包级测试、build/typecheck/bundle、SDK 声明和浏览器检查及两轮连续无问题的自审。E2E 基线用全局 qwen，验证用本地 bundle。

不迁移数据，不增加保留上限，旧会话继续可读。涉及 Core hooks/recording/transcript reader、ACP 会话和 bridge、daemon session 路由和 SDK daemon API/UI helpers。无待定产品决策。
