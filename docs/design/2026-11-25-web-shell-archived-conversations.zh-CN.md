# Web Shell 已归档会话：搜索、筛选、排序与归档时间

[English](2026-11-25-web-shell-archived-conversations.md) | [简体中文](2026-11-25-web-shell-archived-conversations.zh-CN.md)

**状态：设计方案 · 2026-11-25**
**来源 Issue：**[QwenLM/qwen-code#17772](https://github.com/QwenLM/qwen-code/issues/17772)
**汇总跟踪 Issue：**[QwenLM/qwen-code#18302](https://github.com/QwenLM/qwen-code/issues/18302)

---

## 1. 问题陈述、目标与非目标

### 1.1 背景与源码核对缺口

在 Web Shell 中，**设置 → 已归档对话（Archived conversations）** 承担着已结束、空闲回收或手动归档会话的长期存储职责。随着多工作区下的归档会话不断累积，当前面板逐渐不可用。对照最新仓库源码（已演进至 `#17772` 报告的 `0.27.2` 之后）核对，确认存在以下 5 个真实缺口：

1. **缺少搜索框与归档正文搜索：** 侧边栏搜索仅覆盖活跃会话，[StandaloneRecents.tsx](../../packages/web-shell/client/components/sidebar/StandaloneRecents.tsx) 虽已有 `searchQuery` 属性但归档实例未传入；同时 [sessionService.ts](../../packages/core/src/services/sessionService.ts) 的 `SessionService.searchSessionContent` 硬编码扫描 `getChatsDirForState('active')`，无法检索 `chats/archive/`。
2. **缺少工作区筛选（且工作区排序未对齐）：** [WebShellSidebar.tsx](../../packages/web-shell/client/components/sidebar/WebShellSidebar.tsx) 中的 `allArchivedSessions` 仅按 `archiveSourceType` 过滤，并按 `Map` 插入顺序渲染所有工作区分组，未遵循侧边栏的 `orderedProjectWorkspaces` 顺序，也无法筛选单个工作区或「无工作区会话」。
3. **归档面板缺少可见排序控件与更多排序维度：** `0.27.2` 之后，当 daemon 声明 `session_last_user_prompt_sort` 时，归档目录查询已透传侧边栏共享的 `sortBy` 偏好，但归档面板自身仍没有任何排序 UI 控件，也不支持按 `archivedAt`、`createdAt` 或 `alphabetical` 排序。
4. **行内无时间展示且缺乏持久化 `archivedAt`：** 归档行当前为纯文本，时间仅在悬停 [SessionDetailsTooltip.tsx](../../packages/web-shell/client/components/sidebar/SessionDetailsTooltip.tsx) 浮层中显示；磁盘上 `SessionService.archiveSessions` 仅通过 `fs.renameSync` 移动文件（保留原有 `mtime`），`toSummary` / `toStandaloneSummary` 以 `item.mtime` 构造 `updatedAt`，全链路均不存在 `archivedAt` 字段。
5. **100 条隐藏分页断崖与行状态隔离风险（设计阶段新发现）：** Web Shell 请求 `SESSION_LIST_PAGE_SIZE = 1000`，但 daemon 在 [session-list.ts](../../packages/cli/src/serve/server/session-list.ts) 中强制截断为 `MAX_SESSION_PAGE_SIZE = 100`；与已支持 `cursor` 分页的 `StandaloneRecents` 不同，工作区归档分组未消费 `nextCursor`，导致单工作区超过 100 条归档会话时第 101 条及以后不可达。此外，`StandaloneRecents` 在搜索命中为 0 时仍会渲染标题和空提示，且 `renderSessionRow` 若不显式隔离会读取活跃侧边栏的 `contentSearchHits`。

### 1.2 目标

- 重构 **设置 → 已归档对话** 为可扩展的归档管理面板：顶部统一控制栏（搜索框、`Type` 与 `Sort by` 聚合下拉菜单、工作区筛选下拉框）+ 带边框的工作区分组卡片与两行式条目（标题 + 格式化时间副标题）。
- 在桌面端与触屏端完整保留现有归档行操作能力（导出、恢复/取消归档、重命名、删除），不破坏现有悬停与触屏布局契约。
- 通过 `O(1)` 读取的追加式账本（`chats/archive/archive-meta.jsonl`）持久化真实的 `archivedAt` 归档时间，与 daemon 磁盘 I/O 优化准则保持一致。
- 扩展服务端排序（在 `updatedAt`、`lastUserPromptAt` 基础上新增 `archivedAt`、`createdAt`、`alphabetical`）及归档正文搜索（`archiveState=archived`），并通过 capability 协商保证对旧版 daemon 的平滑降级。
- 为每个工作区归档分组补齐基于 `cursor` 的「加载更多」分页，解决单工作区超 100 条归档无法访问的问题。

### 1.3 非目标

- **不修改 `managed-agent-server` 后端 API（`#15077`）：** `ManagedArchivedSessions` 归属 Java managed-agent 控制面，本设计仅保证 Web Shell 挂载该组件时的集成兼容。
- **不引入全文检索索引或持久化搜索缓存：** 归档正文搜索复用现有的有界流式扫描。
- **不实现归档会话只读预览打开（`#13018`）：** 用户仍需先取消归档再打开对话。
- **不涵盖 CLI `/resume` 或 VS Code 历史搜索（`#6824`）：** 但 Core 层扩展后的 `searchSessionContent(..., { archiveState })` 可供这些入口后续复用。
- **V1 不提供分组级破坏性批量操作：** 分组标题右侧的 `...` 菜单仅保留为后续扩展点，V1 不接入批量删除或批量取消归档。

---

## 2. 现有架构基线（源码核对）

### 2.1 Web Shell 界面与组件

- **宿主挂载点：** [SettingsMessage.tsx](../../packages/web-shell/client/components/messages/SettingsMessage.tsx) 渲染设置页的 `Archived` 分类（`activeGroup?.id === 'Archived'`），提供 `[data-web-shell-archived-sessions]`（`archivedSessionsTarget`）挂载容器。
- **Portal 与数据聚合：** [WebShellSidebar.tsx](../../packages/web-shell/client/components/sidebar/WebShellSidebar.tsx) 通过 `createPortal(..., archivedSessionsTarget)` 生成 `archivedSection`，分别用 `useWebShellSessions` 和 `useSessionCatalogQueries` 订阅主工作区与次级工作区的归档列表（`archiveState: 'archived'`、`view: 'organized', group: 'all'`），组装 `archivedWorkspaceGroups`，依次渲染 `Tabs`（Tasks / Channels）、`managedArchivedSessions?.content`、`<StandaloneRecents archiveState="archived" />` 和 `archivedWorkspaceGroups`。
- **Standalone 归档：** [StandaloneRecents.tsx](../../packages/web-shell/client/components/sidebar/StandaloneRecents.tsx) 调用 `GET /standalone/sessions?archiveState=archived`（`PAGE_SIZE = 50`），已内置基于 `searchQuery` 的客户端过滤（`displayName` 与 `sessionId`）及游标分页，并通过 `onStatusChange` 上报 `{ count, loading, error }`。
- **行渲染与浮层提示：** [WebShellSidebar.tsx](../../packages/web-shell/client/components/sidebar/WebShellSidebar.tsx) 中的 `renderSessionRow` 渲染 `.archivedRow`（`.sessionText` + `SessionPrBadge` + `.sessionMetaSlot` 内的 Export/Restore/More 按钮）并包裹 [SessionDetailsTooltip.tsx](../../packages/web-shell/client/components/sidebar/SessionDetailsTooltip.tsx)。[WebShellSidebar.module.css](../../packages/web-shell/client/components/sidebar/WebShellSidebar.module.css)、[WebShellSidebar.css.test.ts](../../packages/web-shell/client/components/sidebar/WebShellSidebar.css.test.ts) 与 [web-shell.archived-settings.spec.ts](../../packages/web-shell/client/e2e/web-shell.archived-settings.spec.ts) 对 `.sessionMetaSlot` 和触屏端按钮布局有严格断言。
- **复用工具与 UI 原语：** [SessionSortMenu.tsx](../../packages/web-shell/client/components/sidebar/SessionSortMenu.tsx)、[sessionSearch.ts](../../packages/web-shell/client/components/sidebar/sessionSearch.ts)（`sessionMatchesGitQuery`、`mergeSessionContentHits`）、[useSessionContentSearch.ts](../../packages/web-shell/client/components/sidebar/useSessionContentSearch.ts)、[formatDateTime.ts](../../packages/web-shell/client/utils/formatDateTime.ts)、[formatRelativeTime.ts](../../packages/web-shell/client/utils/formatRelativeTime.ts)、[constants/sessions.ts](../../packages/web-shell/client/constants/sessions.ts)、[i18n.tsx](../../packages/web-shell/client/i18n.tsx)，以及内置 `useWebShellPortalRoot()` 的 shadcn 原语（[input.tsx](../../packages/web-shell/client/components/ui/input.tsx)、[select.tsx](../../packages/web-shell/client/components/ui/select.tsx)、[dropdown-menu.tsx](../../packages/web-shell/client/components/ui/dropdown-menu.tsx)、[button.tsx](../../packages/web-shell/client/components/ui/button.tsx)）。

### 2.2 Core、Daemon、Bridge 与 SDK 链路

- **存储与生命周期：** 本地工作区与 standalone 会话的归档、恢复、删除均汇聚于 [sessionService.ts](../../packages/core/src/services/sessionService.ts) 的 `SessionService`（`archiveSessions`、`unarchiveSessions`、`cleanupRemovedSessionStateInternal`、`removeSessionFiles`）。`SESSION_FILE_PATTERN`（`/^[0-9a-fA-F-]{32,36}\.jsonl$/`）在扫描目录时自动跳过非 UUID 文件。现有 sidecar 与文件锁范式见 [session-title-sidecar.ts](../../packages/core/src/services/session-title-sidecar.ts)（`0o600`、`atomicWriteFileSync`）和 [session-pr-service.ts](../../packages/core/src/services/session-pr-service.ts)（进程内队列 + `proper-lockfile`）。[config.ts](../../packages/core/src/config/config.ts) 中的 `moveCurrentSessionArtifacts` 仅迁移显式列举的活跃会话文件。
- **Daemon 列表、缓存与搜索：** [session-list.ts](../../packages/cli/src/serve/server/session-list.ts) 借助 [persisted-session-list-cache.ts](../../packages/cli/src/serve/server/persisted-session-list-cache.ts) 构建 `PersistedSessionListSnapshot`（2 秒 TTL，归档/恢复/删除路由会同时失效 `['active', 'archived']`），使用 `OrganizedCursorKey` / `LiveSessionCursorKey` 排序分页，服务于 [session.ts](../../packages/cli/src/serve/routes/session.ts)（`GET /workspace/:id/sessions`、`GET /workspaces/:workspace/sessions`、`GET /workspace/:id/sessions/search`、`GET /workspaces/:workspace/sessions/search`）、[session-catalog.ts](../../packages/cli/src/serve/routes/session-catalog.ts)（`POST /sessions/catalog`）以及 [standalone-sessions.ts](../../packages/cli/src/serve/routes/standalone-sessions.ts) + [standalone-session-service.ts](../../packages/cli/src/serve/conversations/standalone-session-service.ts)（`GET /standalone/sessions`）。
- **协议类型与能力注册：** [bridgeTypes.ts](../../packages/acp-bridge/src/bridgeTypes.ts)（`BridgeSessionSummary`）、[types.ts](../../packages/sdk-typescript/src/daemon/types.ts)（`DaemonSessionSummary`）、[standalone-sessions.ts](../../packages/sdk-typescript/src/daemon/standalone-sessions.ts)（`parseStandaloneSummary`）、[DaemonClient.ts](../../packages/sdk-typescript/src/daemon/DaemonClient.ts)、[capabilities.ts](../../packages/cli/src/serve/capabilities.ts) 和 [capability-parity.ts](../../packages/cli/src/serve/capability-parity.ts)。

---

## 3. 目标交互与视觉设计

```text
已归档对话
┌───────────────────────────────────┐ ┌────────────────────┐ ┌──────────────────────┐
│ 🔍 搜索已归档对话              ×  │ │ ≡ 全部对话       ⌄ │ │ 📁 全部工作区      ⌄ │
└───────────────────────────────────┘ └────────────────────┘ └──────────────────────┘

📁 qwen-code                                                                    6 个会话
┌────────────────────────────────────────────────────────────────────────────────────────┐
│ Find assigned contributor PRs · #142                    [↓] [重命名/删除 ⋯] [ 取消归档 ]│
│ 2026年11月25日 10:33                                                                    │
├────────────────────────────────────────────────────────────────────────────────────────┤
│ Fix archived sorting edge case                                        [↓] [⋯] [ 取消归档 ]│
│ 2026年11月24日 17:14                                                                    │
│ …Phase 3 展示的转录正文命中摘要…                                                         │
└────────────────────────────────────────────────────────────────────────────────────────┘
                                    [ 加载更多 ]   (存在 nextCursor 时)

◌ 无工作区会话                                                                   2 个会话
┌────────────────────────────────────────────────────────────────────────────────────────┐
│ Standalone cleanup task                                            [↓] [⋯] [ 取消归档 ]│
│ 2026年11月20日 14:08                                                                    │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

### 3.1 顶部控制栏

置于面板标题下方（`flex flex-wrap items-center gap-2 px-1 pb-3`）：

1. **搜索框 `<Input>`**（`flex-1 min-w-[180px]`）：
   - 圆角输入框，前置 `SearchIcon`，非空时显示清除按钮（带 `aria-label`）。
   - **键盘行为边界：** 输入非空时按 `Escape` 清空搜索词并调用 `event.stopPropagation()`，避免误关闭外层设置面板；为空时交给外层按原有逻辑处理。
   - **客户端快路径匹配（大小写不敏感）：** 匹配解析后的 `displayName`（自定义标题或首条 prompt）、`sessionId`，以及复用 [sessionSearch.ts](../../packages/web-shell/client/components/sidebar/sessionSearch.ts) 的 `sessionMatchesGitQuery(session, query)`（分支名、worktree 分支/slug、绑定 PR `#N`、关联 issue `#N`）；同时将 `searchQuery` 透传给 `<StandaloneRecents archiveState="archived" />`。

2. **类型与排序聚合下拉菜单**（触发按钮：`ListFilterIcon` + 当前类型文案 + `ChevronDownIcon`，基于 Web Shell 共享的 `DropdownMenu` 原语构建以自动继承 `useWebShellPortalRoot()`）：
   - **分组 1 — `Type`（类型）：** 仅动态渲染当前上下文实际可用的选项，避免出现无效空项：
     - `All conversations` / 全部对话（默认）
     - **会话来源选项**（仅当 `showSessionSourceSwitch && sourceMetadataEnabled` 时展示）：`Tasks` / 任务（`default`）、`Channels` / 频道（`channel`）—— 取代原先占满整行的 Tasks/Channels `<Tabs>` 切换栏。
     - **托管来源选项**（仅当同时挂载 `managedArchivedSessions` 与本地 daemon 归档时展示）：`Local` / 本地（工作区 + standalone）、`Cloud` / 云端（`managedArchivedSessions`）。
   - **`DropdownMenuSeparator` 分割线**
   - **分组 2 — `Sort by`（排序方式）：** 按 host 独立持久化于 `web-shell:archived-session-sort:${host}`，与活跃侧边栏的 `web-shell:session-sort:${host}` 解耦，确保调整归档排序（如按归档时间或标题）不会影响活跃侧边栏顺序：
     - `Archived` / 归档时间（`archivedAt` 降序）—— Phase 2 当 daemon 声明 `session_archived_at_sort` 时展示；若用户尚未保存自定义归档排序偏好，默认选中该项。
     - `Updated` / 最近活动（`updatedAt` 降序）—— Phase 1 默认项及旧版 daemon 降级项。
     - `Last question` / 最后提问时间（`lastUserPromptAt` 降序）—— 当 daemon 声明 `session_last_user_prompt_sort` 时展示。
     - `Created` / 创建时间（`createdAt` 降序）
     - `Alphabetical` / 按名称排序（`alphabetical`，按展示标题不区分大小写 A→Z 排序）
   - **Phase 1 与 Phase 2 排序执行策略：** Phase 1 中 `updatedAt` 与 `lastUserPromptAt` 由服务端排序分页，`createdAt` 与 `alphabetical` 在客户端对已加载记录排序（若存在未加载的 `nextCursor` 则提示分页范围）。Phase 2 将 `archivedAt`、`createdAt`、`alphabetical` 全部提升至服务端全量预排序后再分页（连接旧版 daemon 时 `createdAt` 和 `alphabetical` 仍保留客户端排序兜底）。

3. **工作区筛选下拉框 `<Select>`**（`FolderIcon` + 当前工作区名称 + `ChevronDownIcon`）：
   - 选项：`All workspaces` / 全部工作区（默认）→ `No-workspace sessions` / 无工作区会话（当 standalone 可见且有条目或当前已被选中时）→ 按侧边栏 `orderedProjectWorkspaces` 排序的有归档会话的工作区（附带会话数），最后追加未注册的兜底 `cwd`（按字母序）。
   - **显隐控制：** 当 `lockedWorkspaceCwd` 生效，或筛选值为 `all` 且可选范围不超过 1 个时隐藏筛选框，保持单工作区界面简洁。
   - **状态联动规则：**
     - 选中具体工作区时隐藏 `StandaloneRecents`；选中 `No-workspace sessions` 时仅渲染 `StandaloneRecents`。
     - 当选中 `No-workspace sessions` 时将 `Type` 切换为 `Channels`，自动把工作区筛选重置为 `all`（standalone 不属于 channel）。
     - 在已筛选的单个工作区内恢复或删除最后一条归档会话后，保持当前工作区选中状态并显示针对性空态及「查看全部工作区」按钮，避免列表突然跳变。
     - 切换 daemon host 或 primary workspace 时重置临时的 `searchQuery`、`typeFilter` 和 `workspaceFilter`。

### 3.2 分组卡片与两行式归档行

- **分组标题（位于卡片外侧）：** 左侧展示 `FolderClosedIcon`（standalone 为 `CircleDashedIcon`）+ 工作区名称；右侧展示本地化计数（`N conversations` / `N 个会话`，若仍有 `nextCursor` 可追加 `+`）以及面向未来扩展的溢出菜单预留位。
- **卡片容器：** 使用未加前缀的 Tailwind 语义 token：`rounded-xl border border-border bg-card divide-y divide-border overflow-hidden`。
- **两行式行结构：**
  - **左侧主体（`min-w-0 flex-1`）：**
    1. **第一行：** 会话标题（`truncate font-medium`）、`SessionPrBadge`、Git/Worktree 图标、定时任务标记（`CalendarClockIcon`）。
    2. **第二行：** 格式化时间副标题（`<time dateTime={iso} className="text-xs text-muted-foreground tabular-nums">`），采用 `Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' })`（例如 `Nov 25, 2026, 10:33 AM` / `2026年11月25日 10:33`），并防御非法日期字符串（`!Number.isFinite(Date.parse(iso))` 返回空）。
       - **时间字段选择规则：** 随当前排序维度联动：`archivedAt` 排序优先取 `session.archivedAt`；`lastUserPromptAt` 排序优先取 `session.lastUserPromptAt`；`createdAt` 排序优先取 `session.createdAt`；`updatedAt` 与 `alphabetical` 取 `session.updatedAt ?? session.createdAt`。当历史归档缺少 `archivedAt` 时回退展示 `updatedAt ?? createdAt` 并标注真实语义（绝不将 `updatedAt` 误标为「归档时间」）。
    3. **第三行（Phase 3）：** 单行截断的正文命中摘要（`styles.sessionSearchSnippet`）。
  - **右侧操作区（`shrink-0 flex items-center gap-1.5`）：**
    - 完整保留现有全部操作能力：导出图标按钮、更多菜单（`重命名`、`删除`）以及胶囊型 **`取消归档` / `Restore`** 按钮（兼容既有 `t('sidebar.unarchive')` 的 `aria-label` / `title`）。
    - **CSS 与触屏布局安全：** 不复用活跃侧边栏的 `.sessionMetaSlot`（避免触动 [WebShellSidebar.css.test.ts](../../packages/web-shell/client/components/sidebar/WebShellSidebar.css.test.ts) 与 [web-shell.archived-settings.spec.ts](../../packages/web-shell/client/e2e/web-shell.archived-settings.spec.ts) 的强断言），改用独立的 `.archivedCardRow` 样式，使桌面端（`1440×900`）与触屏端（`390×900`）按钮均稳定可见且不挤压或抖动。
- **悬停详情浮层对齐：** [SessionDetailsTooltip.tsx](../../packages/web-shell/client/components/sidebar/SessionDetailsTooltip.tsx) 在 `session.archivedAt` 存在时明确展示「归档时间」行，并与「更新时间」区分。

### 3.3 分页、空态与查询减负

- **工作区分组「加载更多」：** 当某个工作区归档查询返回 `nextCursor` 时，在卡片下方渲染「加载更多」按钮，按游标拉取下一页并去重追加。搜索时，即使已加载记录没有命中，也保留按钮。
- **去除不必要的 organized 开销：** 归档面板不展示置顶或颜色分组，请求归档目录时去掉 `view: 'organized', group: 'all'`，避免被置顶过的旧会话强行排在前面，并省去一次 `session-organization.v1.json` 读盘。
- **`StandaloneRecents` 搜索空态：** 在 `onStatusChange` 中增加 `matchedCount: number`。加载成功后，搜索结果为空且无工作区分组的游标已耗尽时才隐藏该分组。可见分组的游标均已耗尽后，归档面板统一呈现无匹配提示和「清除筛选」按钮。
- **摘要隔离：** `WebShellSidebar.tsx` 的 `renderSessionRow` 在 `isArchived === true` 时仅读取 `options.searchSnippet`，不读取活跃侧边栏的 `contentSearchHits`。

---

## 4. 分阶段架构设计

### 4.1 Phase 1：Web Shell 归档面板重构与客户端控件

**范围：** 纯 Web Shell 客户端改造，零 Core/Daemon/SDK 协议变更，直接兼容所有现网 daemon。

- 将 [WebShellSidebar.tsx](../../packages/web-shell/client/components/sidebar/WebShellSidebar.tsx) 中的归档 portal 逻辑拆分为：
  - `packages/web-shell/client/components/sidebar/ArchivedSessionsPanel.tsx`（含单元测试）
  - `packages/web-shell/client/components/sidebar/archived-session-sort.ts`（`ArchivedSessionSort`、`readArchivedSessionSort`、`writeArchivedSessionSort` 及客户端比较器）
- 落地顶部搜索框、`Type`/`Sort by` 聚合菜单、工作区筛选、`orderedProjectWorkspaces` 顺序对齐、两行式卡片行与时间显示、工作区游标加载更多、`StandaloneRecents` 命中数上报以及 `i18n.tsx` 中英文词条。

### 4.2 Phase 2：持久化 `archivedAt` 账本（方案 D）、服务端扩展排序与 SDK

#### `archivedAt` 存储选型结论

| 候选方案                                                      | 冷扫描读 I/O（1,000 条归档）        | 写并发与锁                                       | 损坏隔离                               | 实现复杂度                | 结论                                                                                                |
| ------------------------------------------------------------- | ----------------------------------- | ------------------------------------------------ | -------------------------------------- | ------------------------- | --------------------------------------------------------------------------------------------------- |
| **A. 追加记录到 `.jsonl` 转录**                               | 0 额外读                            | 与 writer lease 竞争                             | 耦合转录正文                           | 中                        | **否决：** 会改写文件 `mtime` 破坏 `updatedAt`，污染对话历史与导出                                  |
| **B. 依赖文件 `ctimeMs`**                                     | 0 额外读                            | 无                                               | 无                                     | 极低                      | **否决：** 归档重命名、文件同步/备份及 Windows NTFS rename 均会改写 `ctime`                         |
| **C. 单会话 sidecar**（`chats/archive/<id>.archive.json`）    | `O(N)`：1,000 次 `open+read`        | 无跨会话竞争                                     | 单会话隔离                             | 低（~70 行）              | **否决：** `O(N)` 冷读违背 [daemon-session-list-io.md](daemon-session-list-io.zh-CN.md) 降 I/O 目标 |
| **D. 归档目录追加账本**（`chats/archive/archive-meta.jsonl`） | **`O(1)`：** 整目录 1 次 `readFile` | 两级串行（内存队列 + `proper-lockfile`）；读无锁 | JSONL 按行容错，单行截断不影响其余会话 | 低（~130 行，含惰性压缩） | **采纳**                                                                                            |

**为何选择方案 D：** [sessionService.ts](../../packages/core/src/services/sessionService.ts) 的 `SESSION_FILE_PATTERN`（`/^[0-9a-fA-F-]{32,36}\.jsonl$/`）天然忽略非 UUID 文件，因此 `archive-meta.jsonl` 不会被任何转录扫描器误判为会话文件，也不会影响 [config.ts](../../packages/core/src/config/config.ts) 中针对活跃会话的目录迁移。仅当 `archiveState === 'archived'` 时才读取账本，活跃会话列表零开销。

#### Core 账本格式与生命周期（`packages/core/src/services/session-archive-metadata.ts`）

- **路径与权限：** `<chatsDir>/archive/archive-meta.jsonl`，文件权限 `0o600`。
- **行格式（JSONL）：** `sessionId` 统一转小写以兼容大小写不敏感文件系统：
  ```json
  {"v":1,"op":"archive","sessionId":"<lowercase-uuid>","archivedAt":"2026-11-25T03:00:00.000Z"}
  {"v":1,"op":"clear","sessionId":"<lowercase-uuid>"}
  ```
- **`SessionService` 内的全部 5 个写入时机：**
  1. `archiveSessions` 正常归档（`active` → `archived`）：`fs.renameSync` 成功后追加 `op: "archive"`（时间戳 `new Date().toISOString()`）。
  2. `archiveSessions` 处于 `alreadyArchived`：**不覆盖**已有 `archivedAt`（保留首次归档时刻）。
  3. `archiveSessions` 冲突修复（`resolveConflicts` 保留归档副本）：仅当账本中该 `sessionId` 尚无有效 `archivedAt` 时补写 `op: "archive"`。
  4. `unarchiveSessions`（正常恢复与保留活跃的冲突修复）：移动/清理成功后追加 `op: "clear"`，避免未来文件被外部重新移入 `archive/` 时复用旧时间。
  5. `cleanupRemovedSessionStateInternal` / `removeSessionFiles`（永久删除）：仅当 `archive-meta.jsonl` 存在且当前包含该 `sessionId` 时追加 `op: "clear"`（删除活跃会话零额外 I/O）。
- **Best-effort 与所有权围栏：** 每次写入遵守 `assertCleanupOwned?.()` 租约围栏，采用 best-effort 策略（写失败仅 `this.warn(...)`，不回滚已提交的转录文件移动）。
- **并发锁与惰性压缩：** 写操作复用 [session-pr-service.ts](../../packages/core/src/services/session-pr-service.ts) 的两级锁模式（进程内按路径排队 + 跨进程 `proper-lockfile`）。在写锁内当总行数 > `256` 且总行数 > `有效条目数 * 3`（或体积 > `256 KiB`）时触发压缩：剔除已 `clear` 及 `chats/archive/` 下已不存在 `.jsonl` 的孤儿条目，通过 `atomicWriteFileSync(..., { mode: 0o600 })` 原子替换。
- **无锁读取与历史兼容：** 单次读取上限 `4 MiB`，`ENOENT` 返回空 `Map`，按行容错解析并校验 `Number.isFinite(Date.parse(archivedAt))`。升级前已归档的会话无账本记录，`archivedAt` 保持 `undefined`（严禁用 `mtime` 或 `ctime` 伪造）。

#### 协议透传、排序、分页游标与能力协商

- **类型与字段透传：**
  - 在 `SessionListItem`（[sessionService.ts](../../packages/core/src/services/sessionService.ts)）、`BridgeSessionSummary`（[bridgeTypes.ts](../../packages/acp-bridge/src/bridgeTypes.ts)）和 `DaemonSessionSummary`（[types.ts](../../packages/sdk-typescript/src/daemon/types.ts)）新增 `archivedAt?: string`。
  - `SessionService.listSessions`（`archiveState === 'archived'` 时单次读账本）和 `getSessionListItem(..., 'archived')` 填充 `archivedAt`。
  - `toSummary`（[session-list.ts](../../packages/cli/src/serve/server/session-list.ts)）与 `toStandaloneSummary`（[standalone-session-service.ts](../../packages/cli/src/serve/conversations/standalone-session-service.ts)）透传 `archivedAt`；`withoutDecorations` **保留** `archivedAt`（属于核心时间戳而非装饰 sidecar）；`parseStandaloneSummary`（[standalone-sessions.ts](../../packages/sdk-typescript/src/daemon/standalone-sessions.ts)）校验其为可选字符串。
- **扩展 `sortBy` 契约：**
  - `GET /workspace/:id/sessions`、`GET /workspaces/:workspace/sessions`、`POST /sessions/catalog`、`GET /standalone/sessions` 及 `DaemonClient` 将 `sortBy` 扩展为 `'updatedAt' | 'lastUserPromptAt' | 'archivedAt' | 'createdAt' | 'alphabetical'`。
  - **路由作用域与信任边界：** 各工作区路由严格保持 selected-runtime 作用域（只读次级工作区仅读取本地持久化存储，绝不回退主工作区）；`GET /standalone/sessions` 保持 standalone-runtime 作用域。
  - **非法参数校验（`400`）：** `sortBy=archivedAt` 与 `archiveState !== 'archived'` 或 `liveOnly=1` 组合返回 `400`；`sortBy=createdAt|alphabetical` 与 `liveOnly=1` 组合返回 `400`；未知 `sortBy` 返回 `400`；跨排序复用游标返回 `400 invalid_cursor`。
- **游标键与确定性排序（`session-list.ts`）：**
  - `archivedAt`、`createdAt`、`alphabetical` 走 `listWorkspaceSessionsByMetadataForResponse`（显式传 `view=organized` 时走 `listOrganizedWorkspaceSessionsForResponse`），并将 `sortBy` 编入 cursor。
  - **`archivedAt` 排序键：** 两级键 `(hasPrimaryTime desc, activityTime desc, sessionId asc)` —— 有真实 `archivedAt` 的归档会话排在前面（按归档时间降序），无账本记录的历史归档紧随其后（按 `Date.parse(updatedAt ?? createdAt) || 0` 降序），最终由 `sessionId` 升序稳定破平。
  - **`createdAt` 排序键：** `(hasPrimaryTime desc, createdAtMs desc, sessionId asc)`。
  - **`alphabetical` 排序键：** `(hasTitle desc, normalizedTitle asc, sessionId asc)`，无标题会话排在最后，`normalizedTitle` 取 `displayName.trim().toLocaleLowerCase('en')`。
  - **缓存复用：** 归档/还原/删除路由已通过 `runWithSessionListInvalidation(runtime, ['active', 'archived'], ...)` 失效 `PersistedSessionListCache`，`archivedAt` 随快照自动保持最新。
- **能力协商：**
  - 在 [capabilities.ts](../../packages/cli/src/serve/capabilities.ts) 注册 `session_archived_at_sort`，并在 [capability-parity.ts](../../packages/cli/src/serve/capability-parity.ts) 标记 `LEGACY_ONLY`（与 `session_last_user_prompt_sort` 一致）。
  - SDK 在 `sortBy` 为 `'archivedAt' | 'createdAt' | 'alphabetical'` 时 pre-flight `requireCapability('session_archived_at_sort')`。Web Shell 检测到该能力时才将默认排序设为 `archivedAt`，否则平滑降级为 `updatedAt`（并对 `createdAt`/`alphabetical` 使用客户端排序兜底）。

### 4.3 Phase 3：归档会话正文搜索

- **Core（[sessionService.ts](../../packages/core/src/services/sessionService.ts)）：**
  - `SessionContentSearchOptions` 新增 `archiveState?: SessionArchiveState`（默认 `'active'`）。
  - `searchSessionContent` 使用 `this.getChatsDirForState(archiveState)` 替代硬编码 `'active'`。
  - 当 `archiveState === 'archived'` 时，候选文件在 `maxFiles = 200` 上限内按 `max(archivedAtMs ?? 0, mtime)` 降序扫描，确保刚归档的老对话优先进入扫描窗口，同时保留 `AbortSignal` 中断与 `setImmediate` 让渡。
- **Daemon（[session-list.ts](../../packages/cli/src/serve/server/session-list.ts)、[session.ts](../../packages/cli/src/serve/routes/session.ts)、[standalone-sessions.ts](../../packages/cli/src/serve/routes/standalone-sessions.ts)）：**
  - `searchWorkspaceSessionsForResponse` 将 `archiveState` 透传至 `searchSessionContent`、`getSessionListItem(hit.sessionId, archiveState)`、`enrichWorktreeSidecars(..., archiveState)` 及 `enrichPrSidecars(..., archiveState)`。
  - `GET /workspace/:id/sessions/search` 与 `GET /workspaces/:workspace/sessions/search` 支持可选 `archiveState=active|archived`（默认 `'active'`；非法值返回 `400 invalid_search_archive_state`；严格保留 selected-runtime 隔离）。
  - 新增 standalone 对等路由 `GET /standalone/sessions/search?q=...&archiveState=active|archived&maxResults=...`，过滤 top-level standalone 会话并排除 deletion journal 已删除项。
  - 注册能力标签 `session_archived_content_search` 与 `standalone_session_content_search`。
- **SDK 与 Web Shell：**
  - `DaemonClient.searchWorkspaceSessions` 支持 `archiveState`（`'archived'` 时校验 `session_archived_content_search`），并新增 `searchStandaloneSessions`。
  - Web Shell 新增 `useArchivedContentSearch`（300 ms 防抖、最小长度 2 字符、`AbortController`、选择「全部工作区」时并发上限为 3、旧 daemon 静默降级）。
  - 复用 `mergeSessionContentHits` 合并本地匹配与服务端命中（支持超越首页 100 条分页限制的幽灵命中），在归档卡片行中渲染 `sessionSearchSnippet`。

---

## 5. 约束、风险与缓解措施

| 风险 / 约束                                                         | 影响                                            | 缓解策略                                                                                                         |
| ------------------------------------------------------------------- | ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| 现有 CSS 与 E2E 强断言 `.sessionMetaSlot` 和 `390×900` 触屏按钮边界 | 破坏活跃侧边栏或触屏 E2E 测试                   | 保持 `.sessionMetaSlot` 零改动；归档卡片行采用独立 `.archivedCardRow` 样式，在 `1440×900` 与 `390×900` 双端验证  |
| 历史归档缺少 `archivedAt`                                           | 若直接以 `updatedAt` 冒充「归档时间」会误导用户 | 历史条目保持 `archivedAt: undefined`；行内与 Tooltip 严格区分「归档时间」与「更新时间」                          |
| 账本写入异常或 CLI/Daemon 并发操作                                  | 丢失时间或损坏尾部行                            | Best-effort 写入（绝不阻断转录移动）、`proper-lockfile` + 原子压缩、按行容错解析                                 |
| 多工作区下输入搜索词触发并发风暴                                    | 在「全部工作区」模式下打满 daemon I/O           | 300 ms 防抖、≥2 字符触发、自动 abort 过期请求、仅查有归档会话的工作区且限并发 3                                  |
| 连接旧版 daemon                                                     | 发送未知 `sortBy` 或 `archiveState` 触发 400    | 通过 `session_archived_at_sort`、`session_archived_content_search`、`standalone_session_content_search` 严格门控 |

---

## 6. 验证计划与验收标准

### 6.1 验证计划

- **Phase 1：** `ArchivedSessionsPanel.test.tsx`、`StandaloneRecents.test.tsx`、`SessionDetailsTooltip.test.tsx`、`WebShellSidebar.css.test.ts` 单测；扩展 [web-shell.archived-settings.spec.ts](../../packages/web-shell/client/e2e/web-shell.archived-settings.spec.ts)，在桌面端（`1440×900`）与触屏端（`390×900`）验证搜索、类型/排序/工作区筛选、时间展示、加载更多与视觉截图。
- **Phase 2：** `session-archive-metadata.ts` 与 `SessionService` 单测（正常归档、`alreadyArchived` 保值、冲突修复、恢复/删除清理、大小写归一化、损坏行恢复、惰性压缩、旧归档返回 `undefined`）；Daemon/SDK 单测（`sortBy=archivedAt|createdAt|alphabetical`、混合新旧归档跨页排序、非法组合 `400`、跨排序 cursor 拒收、能力降级）；真实 `qwen serve` 冒烟验证重启与重命名后 `archivedAt !== updatedAt`。
- **Phase 3：** Core/Daemon/SDK 单测（`archiveState=archived` 搜索隔离、sidecar 补全、standalone 过滤、`400` 校验、`AbortSignal` 取消）；Web Shell 单测/E2E 验证正文摘要渲染及超页幽灵命中操作。
- **每个 PR 提交前门禁：** `npm run build && npm run typecheck`、`npm run lint` 以及对应包的 Vitest / Playwright 用例。

### 6.2 验收标准

1. 用户可通过标题、首条 prompt、会话 ID、分支/worktree/PR/issue（Phase 1）及对话正文（Phase 3）检索已归档会话。
2. 用户可按工作区（含「无工作区会话」）、对话 `Type`（`All conversations` / `Tasks` / `Channels` / `Local` / `Cloud` 按上下文动态展示）筛选，并支持 `Archived`、`Updated`、`Last question`、`Created`、`Alphabetical` 排序与独立 host 级持久化。
3. 归档行内直接展示格式化时间，并在悬停详情中明确区分「归档时间」与「更新时间」；升级前历史归档不展示伪造的 `archivedAt`。
4. 超过 100 条归档的工作区可通过「加载更多」完整访问，旧版 daemon 无报错平滑兼容。

---

## 7. 实施里程碑与待决问题

### 7.1 里程碑

- **Milestone 0：** 合并中英文设计文档（`docs/design/`）并创建汇总跟踪 Issue。
- **Milestone 1（Phase 1 PR）：** Web Shell `ArchivedSessionsPanel` UI 重构、客户端检索/筛选/排序/时间展示及分组加载更多。
- **Milestone 2（Phase 2 PR）：** Core `archive-meta.jsonl` 账本、`archivedAt` 全链路透传、服务端 `archivedAt`/`createdAt`/`alphabetical` 排序、SDK 与 `session_archived_at_sort` 能力。
- **Milestone 3（Phase 3 PR）：** 归档工作区与 standalone 正文搜索、`session_archived_content_search` / `standalone_session_content_search` 能力及行内命中摘要展示。

### 7.2 待决问题

- **分组 `...` 批量操作：** 延后至 V1 之后；需进一步评估分组级「全部取消归档 / 全部删除」的交互需求与防误触二次确认规则。
- **归档会话只读预览（`#13018`）：** 独立后续能力；待 `#13018` 落地后，点击归档卡片行可直接跳转只读回放视图，无需改动 Phase 1–3 的卡片结构。
