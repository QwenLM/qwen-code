# Web Shell 工作区置顶功能

[English](2026-09-28-web-shell-workspace-pinning.md) | [简体中文](2026-09-28-web-shell-workspace-pinning.zh-CN.md)

## 目标

让 Web Shell 用户能够将重要的工作区固定在侧边栏顶部，使其始终可见且易于查找，即使存在大量其他工作区时也是如此。置顶状态在守护进程重启后持久化，并且在删除会话后仍然保留。

## 契约

- `PATCH /workspace-registrations/:id/pin` 用于设置或清除某个持久化注册项的置顶状态。
- `/capabilities` 中的工作区条目在通告 `workspace_pinning` 时包含 `registrationIds`、`isPinned`（布尔值，功能通告时始终存在）和 `pinnedAt`（ISO-8601，仅置顶时存在）；当标签不存在时，这些字段完全省略。
- `workspace_pinning` 能力标签用于通告支持；客户端在显示 UI 之前通过预检检查此标签。
- Web Shell 侧边栏仅在具有持久化注册记录且守护进程通告了 `workspace_pinning` 的行上显示"置顶工作区"菜单项。
- 已置顶的工作区在所有未置顶的非主工作区之上排序；主工作区始终保持在顶部，不受置顶状态影响。在置顶分组内，按置顶时间降序排列（最近置顶的在前）。未置顶分组保持守护进程目录顺序。
- 置顶状态存储在现有工作区注册存储快照中新增的 `pinnedAts: Record<string, string>` 字段下，以稳定注册 ID 为键。
- Schema 版本保持为 1；旧版守护进程会静默丢弃新增的 `pinnedAts` 字段（数据丢失风险见下文说明）。

## REST API

### `PATCH /workspace-registrations/:id/pin`

设置或清除某个持久化注册项的置顶状态。该路由需要 JSON 请求体 `{ "isPinned": boolean }`；省略请求体或传递非布尔值返回 `400 invalid_body`。成功返回 `{ id, isPinned, pinnedAt? }` —— `pinnedAt` 仅在 `isPinned` 为 true 时存在。

```json
// 请求（置顶）
{ "isPinned": true }

// 响应（现已置顶）
{
  "id": "abc123",
  "isPinned": true,
  "pinnedAt": "2026-09-28T10:30:00.000Z"
}

// 响应（现已取消置顶）
{
  "id": "abc123",
  "isPinned": false
}
```

返回 `404 workspace_registration_not_found`、`500 workspace_registration_store_error` 或 `501 persistence_not_available`。当启用守护进程认证时，需要突变认证。

### `/capabilities` 工作区条目形状扩展

当通告 `workspace_pinning` 时，每个工作区条目包含：

```ts
interface WorkspaceEntry {
  // ...现有字段...
  registrationIds?: readonly string[]; // 稳定注册 ID（别名路径时可能包含多个）
  isPinned: boolean; // 功能通告时始终存在（未置顶时为 false）
  pinnedAt?: string; // ISO-8601 时间戳，仅置顶时存在
}
```

当标签不存在时，三个字段全部省略。`isPinned` 对未置顶条目始终为 `false`（不是省略），与 `primary` 和 `trusted` 等始终存在的布尔值模式一致。

## 能力协商

新能力标签：`workspace_pinning`（自 v1 起）。

当 `persistentWorkspaceRegistrationAvailable` 为真时条件性启用（即 `deps.workspaceRegistrationStore !== undefined`）。客户端检查 `features.includes('workspace_pinning')` 后再渲染置顶 UI。

## 持久化和 Schema 兼容性

置顶状态与 workspace 注册信息存储在同一个 JSON 文件中（`~/.qwen/daemon/workspaces/<primary-hash>.json`），位于新增的 `pinnedAts` 对象下。文件 schema 版本保持为 1，因为：

- 旧版守护进程（置顶功能之前）在反序列化时会忽略未知的顶层字段。
- 但是，旧版守护进程**不会保留**未知字段——它们在写回时只序列化已知键。这意味着如果在较新的守护进程之后启动旧版守护进程，它会在下次写入时静默丢弃所有 `pinnedAts` 数据。

**缓解措施：** 用户在存在置顶状态后必须避免降级到不支持置顶的守护进程版本。本设计文档明确记录了这一风险，以便未来的维护者理解为何没有提升 schema 版本（为了避免每次小版本发布都强制迁移）以及故障模式是什么样的。

## 别名路径处理（macOS /var → /private/var）

在 macOS 上，`/var` 下的路径是指向 `/private/var` 的符号链接。通过两个路径注册的单个工作区会产生两个不同的注册 ID，但共享相同的规范 cwd。置顶路由通过扫描 `workspaceRegistry.listAllEntries()` 找到其 `registrationIds` 数组包含请求 ID 的条目，然后对该条目的**每个**注册 ID 调用 `setPinned(regId, isPinned)`。读取回退逻辑会扫描所有 `registrationIds` 以在请求 ID 是别名时找到 `pinnedAt`。

这确保了无论客户端使用哪个路径，置顶任一别名都会影响底层工作区。

## 前端行为

Web Shell 侧边栏（`WebShellSidebar.tsx`）在以下条件满足时渲染"置顶工作区"菜单项：

```ts
const canPin =
  !ws.primary &&
  ws.registrationIds !== undefined &&
  ws.registrationIds.length > 0 &&
  workspace.capabilities?.features.includes('workspace_pinning') === true;
```

这防止菜单出现在以下行上：

- 主工作区（无法置顶）
- 没有持久化注册的临时工作区
- 未通告 `workspace_pinning` 的守护进程（旧版本）

已置顶的行显示 📌 图标并排在所有其他行之上。置顶操作调用 `PATCH /workspace-registrations/:id/pin` 并传递 `{ isPinned: <目标状态> }`。

## 测试策略

- 单元测试验证 `/capabilities` 对未置顶条目发送 `isPinned: false`，且在功能标签不存在时省略这些字段。
- 单元测试验证置顶路由对缺失的注册项返回正确的错误码。
- 集成测试（手动）验证置顶状态在守护进程重启后持久化且排序正确。

## 风险和未决问题

- **Schema 降级风险**：如前所述，旧版守护进程会丢弃 `pinnedAts`。目前没有自动迁移或警告机制。未来的工作可以提升 schema 版本或添加兼容性标志。
- **无跨守护进程同步**：置顶状态本地存储在守护进程的主工作区哈希中。运行多个具有不同主工作区的守护进程会创建独立的置顶状态。
- **无批量操作**：用户必须一次置顶/取消置顶一个工作区。批量"置顶所有收藏"不在当前范围内。
