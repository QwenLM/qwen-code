# Managed SQL 历史查询

[English](2026-10-29-managed-sql-history-queries.md) | [简体中文](2026-10-29-managed-sql-history-queries.zh-CN.md)

## 范围

为 Managed 本地 H2 和 Hosted MySQL 提供小范围、有界读取，复用现有 SQL 表、已发布快照与授权。本方案替换 PR #15839 中较宽的实现；原工作保留在 Draft PR #15696 及此前提交历史中。不包含 authority 窗口、历史缓存、派生历史表、补建、全历史流式恢复、checkpoint/CSI 重构或 Legacy 行为变更。

## 最近消息

`POST /api/agent/web-shell/v1/transcript/items/query` 使用既有 `WebShellExportRequest`：`sessionId`、可选 `cursor` 及 1 到 100 的 `limit`。首次请求选择最新已发布快照，从末尾读取不超过指定数量的 Item。每页按时间顺序返回，`nextCursor` 指向更早的 Item。复用现有快照页资源约束物理读取，不加载完整快照。

复用 `WebShellExportPage`：`items`、`nextCursor`、`hasMore` 与 `snapshotThroughSequence`。覆盖位置属于捕获的已发布快照，可能落后于当前 Session head。Item 为空且覆盖位置为零不能证明 Session 没有历史：可能尚无可用的已发布快照。此接口不包含实时事件尾部，也不证明最新执行状态；既有 transcript、事件流、任务和审批接口继续承担这些职责。WebShell 客户端提供单页访问，现有 UI 与 transcript 重建行为保持不变。

反向游标使用版本 2，并由既有快照密钥认证。scope、快照身份/版本、projection 和到期时间保持固定。正向导出的版本 1 游标与反向游标不能互换。每页均检查当前 Session 读取权限及既有资源读租约。新快照发布不会改变已有游标的视图。

## Journal 分页与点查

`GET /internal/managed-session-store/v1/sessions/{sessionId}/transactions:recent` 接受 `workspaceId`、可选 `throughRevision`、排他的 `beforeRevision` 及 1 到 100 的 `limit`。未指定时，首次响应捕获当前已提交版本；后续使用相同的返回值 `throughRevision` 与 `nextBeforeRevision`。响应按时间顺序返回最新选中的事务，其数量不等于可见消息数。先用 `LIMIT limit+1` 读取元数据，选中事务正文共享既有 8 MiB 页预算。版本缺口、非法长度或正文摘要不匹配均拒绝读取。

`GET .../transactions:lookup` 接受 `workspaceId`、`operation`、`commandId` 及可选 `throughRevision`，复用 canonical 命令键唯一索引。返回原已提交事务前核对精确身份、Workspace、字节长度和摘要。捕获前缀之外的命令在该视图中不存在。查询拒绝超前或已压缩前缀及缺失的边界行，但不独立证明每个未选中的 canonical 行均无任意损坏。

两个内部路由保留租户/Workspace/Session 凭据与数据库读授权，并在 READ_COMMITTED 下最终再次检查读授权。不获取 writer、不续写租约、不结算不确定追加。复用既有当前状态、审批、任务、record/resource 与恢复读取。请求不依赖另一实例的缓存。

## 兼容与延期工作

完整 canonical 历史、schema baseline、replay floor、journal 格式、事务准入、清理及所有执行消费者保持不变。既有 `/transcript/query`、正向导出和 `/transactions` 的语义保持。Hosted scratch 及 checkpoint/CSI 安全检查保留在基线中。完整快照的 UI 分页与替换执行状态重建另行处理；本次不宣称 UI 全历史、恢复耗时或进程总 RSS 已有界。

## 验证

聚焦测试覆盖跨物理页及相同序列值的反向顺序、游标方向/篡改、固定快照、字节与版本边界、精确命令读取、授权和所有权不变。MySQL 测试执行同一 journal 查询及最近快照读取。同步 OpenAPI、surface registry、parity capture 与生成的 WebShell 类型。薄客户端只请求一页，原样传递不透明游标与失败，不自动遍历全部历史。

原本地 Java 预算仍在 564.787/600 秒主动 CLOSED；剩余 35.213 秒禁用，包含准备、编译、重试与子代理。新增 Java/H2/MySQL/HTTP 执行交由最终 head 的 CI 验证。本地 TypeScript 构建/类型检查和受影响客户端测试是独立证据。旧的完整恢复/规模结果不能验收本实现。不宣称运行时发布、部署或模型验收完成。
