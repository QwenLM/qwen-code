# Web Shell 会话绑定 GitHub PR 号

日期：2026-08-20
状态：已确认 MVP 范围

## 问题

Web Shell 同时运行 20+ 会话时，侧栏信息不足以回答"哪个会话对应 PR #N"。
当前链路全断：

1. `GitDialog.doCreatePr` 创建 PR 拿到 `{url, number}` 后只显示状态消息，不回写（`packages/web-shell/client/components/dialogs/GitDialog.tsx:502-553`）。
2. `DaemonSessionSummary` / `BridgeSessionSummary` 无 PR 字段；`updateSessionMetadata` 只放行 `displayName`。
3. 侧栏搜索只匹配标题和 sessionId（`WebShellSidebar.tsx:3289-3302`），不匹配分支名、worktree slug、PR 号。
4. 无任何持久化载体，daemon 重启后即使内存绑定也会丢。

## 方案

### 数据模型

`DaemonSessionSummary` 与 `BridgeSessionSummary`（镜像，需同步）增加：

```json
"pr": { "number": 9517, "url": "https://github.com/owner/repo/pull/9517" }
```

- `number`：正整数；`url`：http(s) URL（badge/tooltip 直接作为链接目标渲染，拒绝 `javascript:` 等 scheme——route、bridge、SDK 校验器、sidecar 校验四层统一要求）。
- 字段可选、可缺省；不提供"清除"语义（MVP 内 PR 绑定只增不改——重复创建 PR 时覆盖为最新）。

### 写入端

- SDK `DaemonClient.updateSessionMetadata` 的 metadata 参数扩展 `pr?: { number: number; url: string }`。
- daemon 两个 PATCH metadata 路由（`/session/:id/metadata` 与 workspace 作用域版本，`packages/cli/src/serve/routes/session.ts` ~5040/5089）校验并透传 `pr`。
- bridge `updateSessionMetadata`（`packages/acp-bridge/src/bridge.ts:9526`）校验后写入 live entry，`session_metadata_updated` SSE 事件 data 增加 `pr`。
- `GitDialog.doCreatePr` 成功后：用已注入的 `sessionId` / `resolveSessionForWorkspace` 解析当前会话，调用 `updateSessionMetadata(sessionId, { pr })`。GitDialog 已有这两个 props（`App.tsx:11130-11131`）。写入失败仅降级为 console 警告，不影响 PR 创建成功的状态展示。

### 持久化

新增 sidecar `<chatsDir>/<sessionId>.pr.json`，完全复刻 worktree sidecar 模式：

- 新 core 服务 `packages/core/src/services/sessionPrService.ts`：`SessionPr` 接口、`isValidSessionPr` 运行时校验、`readSessionPr` / `writeSessionPr`（atomicWriteJSON，容忍 ENOENT/JSON 损坏）。
- `SessionService` 增加 `getPrSessionPathForArchiveState(sessionId, archiveState)` 路径助手（对照 `getWorktreeSessionPathForArchiveState`）。
- daemon workspace 作用域 PATCH 路由在 bridge 更新成功后写 sidecar。
- `session-list.ts` 增加 `enrichPrSidecars`（对照 `enrichWorktreeSidecars`），三条列表路径共用，回填 persisted summary 的 `pr` 字段。

### 展示与搜索（web-shell 侧栏）

- `renderSessionRow`：会话行标题旁渲染小号 `#1234` badge（仅当 `session.pr` 存在），点击新窗口打开 PR URL；worktree/branch 图标逻辑不变。
- `SessionDetailsTooltip`：分支行下方增加 PR 链接行。
- `filteredSessions` 匹配逻辑扩展：`label`、`sessionId` 之外，增加 `pr.number`（输入 `9517` 或 `#9517` 都命中）、`branch.name`、`worktree.branch`、`worktree.slug`。
- `WorkspaceSection.tsx:428-439` 的同类过滤若仍在使用则同步更新；若为死代码则不动。
- SSE 消费侧：web-shell 不直接消费 `session_metadata_updated` 更新 store；bridge 的 `markSessionCatalogChanged()` 触发 catalog revision bump，侧栏 live-state 轮询（2s 周期）发现后自动 refetch——badge 在绑定后 ~2s 内出现（与改名等其他客户端变更的传播机制一致）。
- i18n：新增 badge 的 aria-label / tooltip 文案 key（如 `sidebar.sessionPr`）。

## 关键决策

- **绑定时机 = GitDialog 创建 PR 成功时**。Agent 在 shell 里自行 `gh pr create` 的路径无法拦截，MVP 不覆盖；用户主力流程是 GitDialog。
- **sidecar 而非 transcript 记录**：displayName 走 `custom_title` transcript 记录是因为标题属于会话内容流；PR 绑定是会话外部元数据，worktree sidecar 是同类先例，改动面更小。
- **只覆盖最新 PR**：同一会话多次创建 PR 时 `pr` 字段覆盖。会话-PR 是 1:1 主力场景，不做列表。
- **workspace 级打开 GitDialog（无会话上下文）时不回写**：`resolveSessionForWorkspace` 解析不到会话就跳过，不报错。

## 影响文件

| 层          | 文件                                                                                                                                                      |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SDK 类型    | `packages/sdk-typescript/src/daemon/types.ts`（DaemonSessionSummary.pr）                                                                                  |
| SDK 事件    | `packages/sdk-typescript/src/daemon/events.ts`（MetadataUpdated data + 校验）                                                                             |
| SDK 客户端  | `packages/sdk-typescript/src/daemon/DaemonClient.ts`（updateSessionMetadata 参数）                                                                        |
| bridge 类型 | `packages/acp-bridge/src/bridgeTypes.ts`（BridgeSessionSummary.pr、metadata 参数）                                                                        |
| bridge      | `packages/acp-bridge/src/bridge.ts`（updateSessionMetadata 校验/存储/广播）                                                                               |
| core        | `packages/core/src/services/session-pr-service.ts`（新增）+ SessionService 路径助手/归档移动/删除清理                                                     |
| daemon 路由 | `packages/cli/src/serve/routes/session.ts`（两个 PATCH 路由校验 + sidecar 写入）、`acp-http/dispatch.ts`（ACP `session/update_metadata` 的 sidecar 写入） |
| daemon 列表 | `packages/cli/src/serve/server/session-list.ts`（enrichPrSidecars）                                                                                       |
| web-shell   | `GitDialog.tsx`（回写）、`WebShellSidebar.tsx`（badge + 搜索）、`SessionDetailsTooltip.tsx`（PR 行）、locale 文件                                         |
| 测试        | 上述各层的 collocated 单测                                                                                                                                |

## 范围边界（明确不做）

- 服务端分页过滤（20+ 会话规模客户端搜索足够；`sourceType/sourceId` 过滤管道是将来扩展的样板）。
- 历史会话迁移；CLI `--worktree=#<pr>` 的 `pr-<n>` slug 由搜索匹配 slug 顺带覆盖。
- 纯 branch 会话 branch 信息重启丢失的独立 bug，另行处理。
- Agent shell 内 `gh pr create` 的自动发现。

## 开放问题

无。
