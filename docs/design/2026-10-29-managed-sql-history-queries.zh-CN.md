# Managed SQL 历史查询

[English](2026-10-29-managed-sql-history-queries.md) | [简体中文](2026-10-29-managed-sql-history-queries.zh-CN.md)

后续[公开快照删除](2026-10-29-managed-message-snapshot-removal.zh-CN.md)取代本文的已发布快照消息读取和签名游标。下文最近消息契约已按有界实时消息读取更新；journal 查询保持既有行为。后续实现及验证证据单独记录。

## 范围

为 Managed 本地 H2 和 Hosted MySQL 提供小范围、有界读取，复用现有 SQL 表、实时消息分页与授权。本方案替换 PR #15839 中较宽的实现；原工作保留在 Draft PR #15696 及此前提交历史中。不包含 authority 窗口、历史缓存、派生历史表、补建、全历史流式恢复、checkpoint/CSI 重构或 Legacy 行为变更。

## 最近消息

`POST /api/agent/web-shell/v1/transcript/items/query` 使用既有 `WebShellExportRequest`：`sessionId`、可选 `cursor` 及 1 到 100 的 `limit`。首次请求固定序号成员范围上界，读取最新的一组有界当前消息行。每页按时间顺序返回，`nextCursor` 指向首请求范围内更早的 Item。SQL 元数据前瞻以及条目/字节预算约束物理读取，不创建或加载快照资源。

复用 `WebShellExportPage`：`items`、`nextCursor`、`hasMore` 与 `snapshotThroughSequence`。最后一个字段保留 wire 名称，表示固定成员上界；正文和状态保持实时。投影覆盖落后于 replay floor 时返回可重试的 `503 message_projection_pending`，而非用零覆盖空页证明 Session 为空。此接口不包含实时事件尾部，也不证明最新执行状态。transcript 提供用于 SSE 续接的实际投影覆盖位置；事件流、任务和审批接口继续承担既有职责。WebShell 客户端提供单页访问。

反向消息游标使用版本 1，绑定 scope、方向、投影代次、成员上界及完整 `(first_sequence, item_id)` 位置。游标未签名，没有快照到期时间或身份。正反向游标不能互换。每页均检查当前 Session 读取权限，并使用一致的 SQL 读取视图。投影重建返回 `409 message_projection_changed`，应丢弃游标并重新开始读取。后续消息更新不会冻结内容，也不会替换游标的初始成员范围。

## Journal 分页与点查

`GET /internal/managed-session-store/v1/sessions/{sessionId}/transactions:recent` 接受 `workspaceId`、可选 `throughRevision`、排他的 `beforeRevision` 及 1 到 100 的 `limit`。未指定时，首次响应捕获当前已提交版本；后续使用相同的返回值 `throughRevision` 与 `nextBeforeRevision`。响应按时间顺序返回最新选中的事务，其数量不等于可见消息数。先用 `LIMIT limit+1` 读取元数据，选中事务正文共享既有 8 MiB 页预算。版本缺口、非法长度或正文摘要不匹配均拒绝读取。

`GET .../transactions:lookup` 接受 `workspaceId`、`operation`、`commandId` 及可选 `throughRevision`，复用 canonical 命令键唯一索引。返回原已提交事务前核对精确身份、Workspace、字节长度和摘要。捕获前缀之外的命令在该视图中不存在。查询拒绝超前或已压缩前缀及缺失的边界行，但不独立证明每个未选中的 canonical 行均无任意损坏。

两个内部路由保留租户/Workspace/Session 凭据与数据库读授权，并在 READ_COMMITTED 下最终再次检查读授权。不获取 writer、不续写租约、不结算不确定追加。复用既有当前状态、审批、任务、record/resource 与恢复读取。请求不依赖另一实例的缓存。

## 兼容与延期工作

Journal 查询保留 canonical 历史、replay floor、journal 格式、事务准入、清理及执行消费者。后续改动删除公开快照 schema，并将 transcript/导出改为上方有界实时消息语义；`/transactions` 保持不变。Hosted scratch 及原生 checkpoint/CSI 安全检查继续保留。UI 全历史自动遍历与替换执行状态重建另行处理；最近消息有界读取不表示恢复耗时或进程总 RSS 已有界。

## 验证

聚焦测试覆盖跨页及相同序列值的反向顺序、游标方向/scope、固定成员范围与实时内容、字节与版本边界、精确命令读取、授权和所有权不变。MySQL 测试面向相同 journal 查询及最近消息读取；资格需要基于记录的最终源码执行验证。同步 OpenAPI、surface registry、parity capture 与生成的 WebShell 类型。薄客户端只请求一页，原样传递不透明游标与失败，不自动遍历全部历史。

原本地 Java 预算仍在 564.787/600 秒主动 CLOSED；剩余 35.213 秒禁用，包含准备、编译、重试与子代理。新增 Java/H2/MySQL/HTTP 执行交由最终 head 的 CI 验证。本地 TypeScript 构建/类型检查和受影响客户端测试是独立证据。旧的完整恢复/规模结果不能验收本实现。不宣称运行时发布、部署或模型验收完成。
