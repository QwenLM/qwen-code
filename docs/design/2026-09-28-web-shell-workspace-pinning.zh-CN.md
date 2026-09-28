# Web Shell 工作区置顶功能

## 目标

让 Web Shell 用户能够将重要的工作区固定在侧边栏顶部，使其始终可见且易于查找，即使存在大量其他工作区时也是如此。置顶状态在守护进程重启后持久化，并且在删除会话后仍然保留。

## 契约

- `PATCH /workspace-registrations/:id/pin` 用于切换或设置某个持久化注册项的置顶状态。
- `/capabilities` 中的工作区条目在被置顶时包含可选字段 `isPinned: true` 和 `pinnedAt: "<ISO-8601>"`；未置顶的条目完全省略这两个字段。
- `workspace_pinning` 能力标签用于通告支持；客户端在显示 UI 之前通过预检检查此标签。
- Web Shell 侧边栏仅在具有持久化注册记录且守护进程通告了 `workspace_pinning` 的行上显示"置顶工作区"菜单项。
- 已置顶的工作区在所有未置顶的工作区之上排序；在每个分组内，按最后活动时间降序排列。
- 置顶状态存储在现有工作区注册存储快照中新增的 `pinnedAts: Record<string, string>` 字段下，以稳定注册 ID 为键。
- Schema 版本保持为 1；旧版守护进程会静默丢弃新增的 `pinnedAts` 字段（数据丢失风险见下文说明）。

## REST API

### `PATCH /workspace-registrations/:id/pin`

设置或清除某个持久化注册项的置顶状态。该路由接受可选的 JSON 请求体 `{ isPinned?: boolean }`；省略请求体表示切换当前状态。成功返回更新后的条目，包含 `isPinned` 和 `pinnedAt`（当置顶时）或两者都不包含（当取消置顶时）。

```json
// 请求（切换）
PATCH /workspace-registrations/abc123 HTTP/1.1
Content-Type: application/json

{}

// 响应（现已置顶）
{
  "id": "abc123",
  "cwd": "/path/to/workspace",
  "displayName": "Payments Production",
  "active": true,
  "persisted": true,
  "isPinned": true,
  "pinnedAt": "2026-09-28T10:30:00.000Z"
}

// 响应（现已取消置顶）
{
  "id": "abc123",
  "cwd": "/path/to/workspace",
  "displayName": "Payments Production",
  "active": true,
  "persisted": true
}
```

返回 `404 workspace_registration_not_found`、`500 workspace_registration_store_error` 或 `501 persistence_not_available`。当启用守护进程认证时，需要突变认证。

### `/capabilities` 工作区条目形状扩展

当通告 `workspace_pinning` 时，每个工作区条目可能包含：

```ts
interface WorkspaceEntry {
  // ...现有字段...
  isPinned?: true; // 仅在置顶时出现
  pinnedAt?: string; // ISO-8601 时间戳，仅在置顶时出现
}
```

未置顶的条目省略这两个字段。这与 `removable` 的模式一致，后者受 `workspace_runtime_removal` 门控。

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

已置顶的行显示 📌 图标并排在所有其他行之上。切换操作调用 `PATCH /workspace-registrations/:id/pin` 且不携带请求体（切换语义）。

## 测试策略

- 单元测试验证 `/capabilities` 对未置顶条目省略 `isPinned`/`pinnedAt`。
- 单元测试验证置顶路由对缺失的注册项返回正确的错误码。
- 侧边栏单元测试验证 Pin 菜单不出现在不可置顶的行上。
- 集成测试（手动）验证置顶状态在守护进程重启后持久化且排序正确。

## 风险和未决问题

- **Schema 降级风险**：如前所述，旧版守护进程会丢弃 `pinnedAts`。目前没有自动迁移或警告机制。未来的工作可以提升 schema 版本或添加兼容性标志。
- **无跨守护进程同步**：置顶状态本地存储在守护进程的主工作区哈希中。运行多个具有不同主工作区的守护进程会创建独立的置顶状态。
- **无批量操作**：用户必须一次置顶/取消置顶一个工作区。批量"置顶所有收藏"不在当前范围内。
