# 会话提问时间排序

[English](session-question-time-sort.md) | [简体中文](session-question-time-sort.zh-CN.md)

## 需求

WebShell 左侧新增可见的“最近活动 / 提问时间”排序选择，并在工作目录列表、批量 catalog、standalone 列表及 SDK 一致提供可选 `sortBy: updatedAt | lastUserPromptAt`，供 Data Agent 等外部业务接入。默认排序保持兼容。助手输出不能推进提问顺序。

## 服务端与缓存

在分页前对完整候选集排序。复用 organized/metadata 过滤，organized 保留置顶优先；未知提问时间排最后，不回落创建或活动时间；同时间按 session id 稳定排序。游标绑定排序口径，跨排序复用游标时报错。非法排序值返回 400。通告 `session_last_user_prompt_sort` 能力；SDK 和 WebShell 对旧 daemon 先检查能力。

提问排序需要完整候选时间索引。标量元数据按 runtime/workspace/archive 分桶，在全局最多 100,000 个条目和 64 个作用域的预算内保留；淘汰整个最久未使用 scope，避免完整索引遍历中的逐行淘汰让超过 512 行的列表每次都重扫。热排序直接读取保留标量；冷缺失使用规范 reader、最多两个并发读取。既有 writer 通知更新同一索引；owner/历史拓扑恢复、归档/取消归档和删除使对应值失效。catalog TTL 过期不丢弃时间索引。有界 scope 淘汰属于明确的冷恢复条件。通用 catalog 枚举仍可能执行原有的有限元数据读取。

## WebShell 与 SDK

排序选择器放在会话操作行中，紧靠多选按钮左侧，不放在品牌标题旁。两个控件作为同一操作区对齐排列。没有该操作行的嵌入布局，在可用时保留工作区表头的备用入口。

复用现有 scoped dropdown 和语义样式，提供中英标签，按 host 保存偏好。排序透传主/次工作目录、最近会话、standalone、SDK 参数及 catalog 查询键。live 活动覆盖可以更新状态和活动时间，但不能改掉提问顺序。切换排序重置分页。保留置顶、分组、归档及当前会话选择。旧 daemon 保持原视图，不能静默接受不支持的提问排序。

## 验收

A 10:00 提问、10:10 继续输出；B 10:05 提问。最近活动 A 在前，提问时间 B 在前。覆盖多页、同时间和未知值。验证助手输出及 catalog TTL 刷新后的热读取不重建转录索引，包括超过 512 行的 catalog；验证真实人工输入更新索引及排序、游标口径拒绝、工作目录/归档隔离、SDK 透传、偏好恢复和 live 覆盖。运行 build/typecheck、定向测试及本地真实 WebShell/daemon 验证，并把前后截图贴到 PR #14654。不增加 HTTP 端点或逐卡请求。
