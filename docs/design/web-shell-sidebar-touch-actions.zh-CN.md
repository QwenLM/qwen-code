# Web Shell 左侧栏会话与工作区操作的触控友好改进设计

[English](web-shell-sidebar-touch-actions.md) | [简体中文](web-shell-sidebar-touch-actions.zh-CN.md)

- **状态：** 已实现（Implemented）
- **日期：** 2026-11-28
- **基线提交：** `72e8eb4290`
- **范围：** P0（触控可达性与纯 Hover 死角修复）+ P1（移动端底部 Action Sheet、内嵌详情、抽屉内分组选择、长按呼出、弹窗重命名）

---

## 1. 问题背景与现状

Web Shell 左侧栏目前大量依赖鼠标悬停（`:hover`、`onPointerEnter`、`onMouseEnter`）来展示会话操作、会话详情、工作区头部操作以及分组头部操作。在没有持续悬停指针的触屏设备——iPhone、iPad 与 Android 手机/平板——上，这些交互要么空间局促极易误触，要么完全无法触发。（归档会话已迁至独立的宽屏 Settings 面板 `ArchivedSessionsPanel` 并自带常显操作，不在本次侧栏折叠范围内，保持不变。）

| 交互面                     | 当前实现位置                                                                                                                                                         | 触控端体验问题                                                                                                                                                                                                                                                                           |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 会话行操作栏               | `WebShellSidebar.tsx`（`renderSessionRow`）、`WebShellSidebar.module.css`（`.sessionActions`、`.sessionActionButton`、`@media (hover: none) and (pointer: coarse)`） | 行内 `Pin` 仅在严格的 `(hover: none) and (pointer: coarse)` 下收起（会漏掉混合指针 iPad 与桌面模式移动端抽屉）；`.sessionActionButton` 在 `30px` 行内仍只有 `26px × 26px`，远低于 44 pt / 48 dp 触控目标标准，手指极易误触穿透到 `openRow` 切走会话。                                    |
| 触控媒体查询覆盖面         | `WebShellSidebar.module.css`（`@media (hover: none) and (pointer: coarse)`）、`ManagedWorkspaceNavigation.tsx`（`[@media(hover:none)]:visible`）                     | 严格的 `and` 组合会漏掉支持 Apple Pencil 悬停的新款 iPad、外接键鼠/触控板但仍手点屏幕的 iPad，以及部分上报 `hover: hover` 或 `pointer: fine` 的 Android 平板浏览器。                                                                                                                     |
| 会话操作菜单与分组二级菜单 | `WebShellSidebar.tsx`（`DropdownMenuContent`、`openGroupMenuFromAnchor`）、`WebShellSidebar.module.css`（`.groupMenu`、`.groupMenuItem`）                            | `DropdownMenuItem` 采用紧凑桌面密度（`py-1`）。选择「分组」后会弹出第二个手动算坐标的 `position: fixed; width: 240px` 浮窗（`.groupMenu`），在手机窄屏下易贴边/遮挡且行高仅 `34px`。                                                                                                     |
| 会话悬停详情浮窗           | `SessionDetailsTooltip.tsx`、`WebShellSidebar.tsx`（`withDetails`）、`ManagedSessionNavigationRow.tsx`                                                               | 仅在 `onPointerEnter` 延迟 300 ms 后打开，且 `onPointerDownCapture` / `onClick` 一碰即关。触屏用户无法查看完整折行标题、工作区路径、Git 分支、关联 PR/Issue 链接、连接状态，也无法复制 Session ID（组件本身已有 `openOnClick` 属性并在 `SessionOverviewPanel.tsx` 使用，但侧栏未接入）。 |
| 工作区头部操作             | `WorkspaceSection.tsx`（`actionsVisible`、`onMouseEnter` / `onMouseLeave`）、`WebShellSidebar.tsx`（`workspaceHeaderActions` 内联 `style={{ visibility }}`）         | 可见性被 JS 鼠标移入状态锁定为 `visibility: hidden`，无任何触控兜底。在 iPhone / iPad / Android 上，工作区的「新建任务」按钮与 `WorkspaceMenu`（重命名、复制路径、新建 worktree 任务、创建分组、MCP/Skills/Extensions/Channels/Settings、重载、移除）几乎无法触发。                      |
| 工作区悬停详情浮窗         | `WorkspaceDetailsTooltip.tsx`、`WorkspaceSection.tsx`                                                                                                                | 纯悬停弹出，触屏用户不打开菜单时无法查看工作区完整路径、Git 状态摘要与资源统计。                                                                                                                                                                                                         |
| 会话分组头操作             | `SessionGroupSection.tsx`、`WebShellSidebar.module.css`（`.sessionGroupHeaderActions`）                                                                              | 默认 `opacity: 0`，仅在 `:hover` / `:focus-within` 显示，无触控兜底。重命名分组与删除分组在触屏端不可达。                                                                                                                                                                                |
| 会话重命名流程             | `WebShellSidebar.tsx`（`SessionRenameEditor`）、`StandaloneRecents.tsx`（`SessionRenameDialog`）                                                                     | 工作区会话在窄侧栏行内直接编辑；手机端弹起软键盘会压缩视口，行内输入框易被挤出或误触失焦取消，而 `StandaloneRecents.tsx` 已使用居中弹窗 `SessionRenameDialog`。                                                                                                                          |

---

## 2. 目标与非目标

### 目标

1. **消除侧边栏全部纯 Hover 死角（P0）：** 所有桌面鼠标悬停可达的会话操作、会话元信息/详情、工作区菜单操作与分组头操作，在 iPhone、iPad（无论是否搭配 Apple Pencil / 触控板）与 Android 设备上均可稳定通过触控触发。
2. **兼顾标题可读性与触控人体工学（P0）：** 在触控/紧凑抽屉场景下，将行尾多按钮收敛为单个常显的 `⋮` 触发器（`EllipsisVerticalIcon`）并放大触控热区，避免误触切换会话。
3. **提供原生级移动端菜单体验（P1）：** 在触控/紧凑场景下复用现有 `ui/drawer`（`vaul`）以底部 Action Sheet 呈现会话菜单，顶部直接内嵌会话详情摘要，并将手动定位的 `.groupMenu` 替换为抽屉内二级视图。
4. **支持长按快捷呼出（P1）：** 支持长按会话行（约 450 ms）呼出同一 Action Sheet，且绝不干扰列表纵向滚动或触发误切会话。
5. **稳健的触控端重命名（P1）：** 触控触发的会话重命名统一走现有 `SessionRenameDialog` 居中弹窗，避免侧栏行内编辑与软键盘冲突。
6. **桌面端零回退：** 桌面鼠标用户继续保持现有的 Hover 显隐、行内 `inlineItems` 快捷按钮、悬停 `SessionDetailsTooltip` / `WorkspaceDetailsTooltip`、`DropdownMenu` 以及行内 `SessionRenameEditor`，行为完全不变。

### 非目标

- **不改 daemon、协议或公开包 API：** 所有改动限制在 `packages/web-shell/client` 内。既有 `WebShellSidebarSessionActionsOptions`（`items` 与 `inlineItems`）策略继续生效：`items` 在所有形态下统一控制可用动作集合，`inlineItems` 继续作用于桌面端 Hover 行内按钮。
- **不做行级左滑显示操作（Swipe-to-Reveal）：** 横向滑动与 iOS/Android 边缘返回手势及左侧栏抽屉自身关闭手势冲突，且无法清爽承载 6–8 项操作与详情。
- **P2 延后项：** 对话页顶栏标题（`ChatPane`）点击看详情/快捷操作，以及托管模式（Managed）超越 P0 触发器/热区改进之外的独立 Action Sheet 改造，列为第 8 节后续项。

---

## 3. 架构与交互设计

### 3.1 触控与紧凑场景探测策略

将两个容易混淆的判断显式拆分，而不是强绑在单一媒体查询上：

1. **粗指针入口可见性（CSS 与 JS）：** 决定 Hover 控件是否需要常显并放大触控热区。
   - **CSS 媒体查询：** 从 `@media (hover: none) and (pointer: coarse)` 调整为 `@media (pointer: coarse)`，同时对移动端覆盖抽屉态（`.sidebar.mobileOpen`）也应用单按钮触控布局。
   - **为何选用 `(pointer: coarse)` 而非 `(hover: none), (pointer: coarse)`：**
     - `(pointer: coarse)` 可覆盖 iPhone、Android 手机/平板、纯触屏 iPad 以及带 Apple Pencil 悬停的新款 iPad（`hover: hover` + `pointer: coarse`），同时避免在报告 `hover: none` 且 `pointer: fine` 的无头 Linux 桌面 Chromium 环境下产生误判。
     - `.sidebar.mobileOpen` 保证即便平板/手机浏览器开启了「请求桌面网站」模式，或在窄窗嵌入式宿主中使用抽屉，菜单入口依然可用。
     - 对于外接触控板为主指针（`pointer: fine` + `hover: hover`）的混合指针 iPad 在常驻宽侧栏（`mobileOpen = false`）下，通过**事件级 `pointerType === 'touch'` 识别**，让手指长按任意会话行或手指轻触 `⋮` 都能直接弹出底部 Action Sheet，同时不干扰鼠标/触控板操作。
   - **保留桌面端 Hover 专属守卫：** 现有的悬停背景运行圆点时隐藏操作栏规则（`.sessionRow:has(.sessionBackgroundRunning:hover) .sessionActions`）收紧到 `@media (hover: hover) and (pointer: fine)` 内，确保触屏点击产生的粘滞 hover 绝不会意外藏起行尾按钮。
2. **菜单呈现形态（Action Sheet 对比 `DropdownMenu`）：**
   - 新增轻量共享 hook `useTouchSidebarActions(mobileOpen: boolean)`（位于 `packages/web-shell/client/components/sidebar/use-touch-sidebar-actions.ts`），返回 `{ isTouchActions: boolean; useActionSheet: boolean }`：
     - `isTouchActions`：当 `mobileOpen` 为 `true` 或 `window.matchMedia('(pointer: coarse)').matches`（含旧 `TOUCH_COMPOSER_QUERY` 兼容，并监听 `MediaQueryList` 的 `change` 事件，确保 iPad 插拔妙控键盘时状态能平滑更新）时为 `true`。
     - `useActionSheet`：当 `isTouchActions` 为 `true` 时为 `true`。在手机窄屏下，底部抽屉贴底全宽（`inset-x-0 bottom-0`）；在横屏 iPad 等宽触屏视口（`sm:` 及以上）下，同一底部抽屉限制最大宽度并水平居中（`sm:mx-auto sm:max-w-md sm:rounded-t-2xl`），避免在 1024 px 屏幕上拉得过宽。
   - **兼容 jsdom / SSR：** 当 `window.matchMedia` 不存在或返回 `false`（默认 jsdom 测试环境）时两个标志均默认 `false`，确保现有桌面单测确定性不变；触控单测通过 stub `matchMedia` 或传入 `mobileOpen` 验证。

### 3.2 会话行入口：行尾单个 `⋮` 按钮 + 长按呼出

#### 按钮收敛与视觉层级

当 `isTouchActions` 为 `true`（CSS 侧与 `@media (pointer: coarse)` 及 `.sidebar.mobileOpen` 保持一致）时：

- **所有可操作会话行变体的行尾动作栏统一收敛为 1 个 `⋮`（`EllipsisVerticalIcon`）按钮：**
  - **普通工作区会话行：** 行内的 `Pin`（以及任何 `inlineItems` 按钮）收进 Action Sheet，`.sessionActions` 中只渲染 `⋮`。已置顶状态本身已由行首置顶图标和置顶分区体现，无需在行尾额外常驻开关按钮。
  - **Settings 中的归档会话行（`ArchivedSessionsPanel`）：** 归档列表位于独立宽屏 Settings 面板并保持 `Export`、`More`、`Restore` 常显，不受侧栏触控折叠影响。
  - **独立无工作区会话行（`StandaloneRecents`）：** 行内的 `Pin` 与 `Archive` 收进 Action Sheet，与 `Rename`、`Export`、`Delete` 及详情合并；行尾只保留 `⋮`。
  - **最近会话行（`RecentSessions`）：** 在 `isTouchActions` 为 `true` 时，用同一个 `⋮` 触发器替代原本自定义的 `recent.actions` 按钮/下拉菜单，打开包含该条目所允许操作（置顶/取消置顶、归档、会话详情）的 Action Sheet。
  - **托管模式会话行（`ManagedSessionNavigationRow` + `ManagedSessionActions`）：** 原本就只渲染单个 `⋮` 按钮且复用 `sidebarStyles.sessionActions` / `sidebarStyles.sessionActionButton`，自动继承放宽后的触控媒体查询与放大后的热区。
  - **不可操作行保持克制：**
    - 多选模式行（`SelectableSessionRow`，`selectionMode === true`）：不显示操作触发器，也不响应长按。
    - 未信任工作区的只读会话行（`.sessionItemReadOnly`）：不显示操作菜单触发器，不出现无效的假操作。
    - 宿主通过 `sessionActions.items` 配置为空 `[]`（既无动作也无 `details`）时：不渲染 `⋮` 触发器且禁用长按。
- **视觉降噪：** 非当前选中侧栏行的 `⋮` 按钮采用较低透明度（`0.55`），避免满屏图标杂乱；当前选中行保持全不透明（`1`）。
- **触控热区与间距：**
  - 触控/移动端抽屉模式下（`:not([data-narrow])`），将非归档侧栏 `.sessionRow` 最小高度从 `30px` 提升至 `40px`（在保持一屏可见 10+ 条会话的同时显著降低误触率），同时完整保留 `<= 280px` 极窄抽屉的 `[data-narrow]` 换行规则。
  - 将 `:not([data-narrow])` 触控/移动端抽屉行的 `.sessionActionButton` 放大至 `36px × 36px`，内部图标仍保持 `16px`。
  - 保持 `.sessionMetaSlot` 与 `.sessionActions` 之间清晰间隔，避免状态标签或 PR 徽章与 `⋮` 按钮紧贴。
  - 点击 `⋮` 时调用 `event.stopPropagation()` 打开会话 Action Sheet（或桌面回退时的 `DropdownMenu`），绝不触发 `openRow`。

#### 长按手势状态机（Long Press）

抽离可复用的轻量 hook `useLongPress`（`packages/web-shell/client/components/sidebar/use-long-press.ts`），在 `isTouchActions` 为 `true` 且不处于多选/行内重命名状态时绑定到可操作会话行：

| 事件 / 状态                                    | 行为约束                                                                                                                                                                                                                                                                 |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `onPointerDown`                                | 忽略非主按键及 `pointerType === 'mouse'`；忽略起始于 `.sessionActions`、按钮、链接或输入框内部的事件（`target.closest('button, a, input')`）。记录 `(pointerId, clientX, clientY)` 并启动 `450 ms` 定时器，同时设置 `data-pressing="true"` 提供轻微的按压背景/缩放反馈。 |
| `onPointerMove`                                | 当相对起点的欧氏位移超过 `10 px` 时，立即取消定时器并清除 `data-pressing`，确保纵向滚动列表丝滑不受干扰。                                                                                                                                                                |
| `onPointerUp` / `onPointerCancel` / `onScroll` | 取消未触发的定时器并清除 `data-pressing`。                                                                                                                                                                                                                               |
| 定时器触发（`450 ms`）                         | 清除 `data-pressing`，为本次指针序列设置 `suppressNextClickRef`，可选触发轻触觉反馈（做能力判断后调用 `navigator.vibrate?.(10)`，iOS Safari 自动空操作），并打开该会话的 Action Sheet。                                                                                  |
| 随后的 `onClick` / `onContextMenu`             | 若本次交互已触发长按，则执行 `event.preventDefault(); event.stopPropagation();` 并清空抑制标志，确保松手后不会误切换会话或弹出浏览器原生菜单。                                                                                                                           |

> 说明：`packages/web-shell/client/styles/standalone.css` 已在触控媒体查询下设置了 `-webkit-touch-callout: none` 和 `user-select: none`，可阻止 iOS Safari 弹出系统拷贝/查询菜单。本设计也在 `WebShellSidebar.module.css` 的 `.sessionRow` 触控（`@media (pointer: coarse)`）及 `.sidebar.mobileOpen` 规则中补齐这两条声明，使未加载 `standalone.css` 的嵌入式宿主同样获得干净的长按体验。`useLongPress` 还在长按激活期间监听 `window` `blur` 与捕获阶段 `scroll` 立即取消计时器。

### 3.3 移动端底部 Action Sheet（`ui/drawer`）与内嵌会话详情

沿用 `packages/web-shell/client/components/composer/AddMenu.tsx` 的既定组件范式，新增 `SessionActionSheet`（`packages/web-shell/client/components/sidebar/SessionActionSheet.tsx`），基于 `packages/web-shell/client/components/ui/drawer.tsx` 的 `Drawer`、`DrawerContent` 和 `DrawerTitle` 实现。

在 `WebShellSidebar` 根部**仅挂载 1 个** `SessionActionSheet` 实例（由 `actionSheetSession` 状态驱动），而不是每条会话行挂载一个 `Drawer`，保证数百条会话场景下列表渲染依然轻快。

#### 根视图布局（`page === 'root'`）

```text
┌─────────────────────────────────────────────┐
│  ──── （拖拽把手）                            │
│  [完整折行显示的会话标题]               [×]  │  ← DrawerTitle + 关闭按钮（44×44）
├─────────────────────────────────────────────┤
│  会话详情摘要区（当 'details' 在              │  ← 复用抽取后的 SessionDetailsContent
│  sessionActionItems 中时内嵌展示）：          │    （紧凑展示：工作区、分支、时间、
│  • 工作区 · Git 分支 · 更新时间               │     状态、PR/Issue 链接、复制 Session ID）
│  • 运行中 / 等待审批 / 客户端数状态           │
│  • 关联 PR / Issue 标签（可直接点击跳转）     │
│  • Session ID  [复制]                        │
├─────────────────────────────────────────────┤
│  [置顶 / 取消置顶]                      48px │
│  [重命名]                               48px │
│  [分组 ...]  （当前分组徽章）         › 48px │  ← 同 Drawer 内切入 page === 'group'
│  [归档 / 恢复]                          48px │
│  [导出]                                 48px │
│  [添加到分屏视图]（仅在支持分屏时显示）       │  ← 手机窄屏不支持分屏时自动隐藏
├─────────────────────────────────────────────┤
│  [删除]  （红色危险操作）               48px │
└─────────────────────────────────────────────┘
```

核心交互规则：

- **动作可用性与桌面完全一致：** 每个菜单项严格复用 `renderSessionRow` 现有的权限与配置门禁（包括 `sessionActionItems`、`canOrganizeSession`、`canMutateSessionMetadata` 控制的 `bindPr`、`sessionBlocksDelete`、`canMutateSessionArchive`、`getActiveExportScope`、`showSplit` / `canOpenSplitView`、`busy`、`standalone` 与 `recent`）。
- **内嵌会话详情（抽取 `SessionDetailsContent`）：** 将 `SessionDetailsTooltip.tsx` 中的纯元信息展示逻辑（工作区名称、分支、时间戳、运行状态、PR/Issue 链接、带成功反馈的复制 Session ID 按钮）抽离为共享内部组件 `SessionDetailsContent`（`variant="popover" | "sheet"`）。
  - 只要 `sessionActionItems.has('details')` 成立，即在 `SessionActionSheet` 顶部展示该摘要区。
  - 避免桌面悬停浮窗与移动端抽屉各维护一套字段拼装逻辑，确保 PR/Issue 外链与 Session ID 复制体验双端一致。
  - Action Sheet 内容区放在 `data-vaul-no-drag` 的 `overflow-y-auto` 容器内，设置 `max-h-[85dvh]` 与底部安全区留白 `pb-[max(1rem,env(safe-area-inset-bottom))]`，超长标题或多条 PR 徽章均可自然滚动、不被截断。
- **抽屉内分组与颜色选择页（`page === 'group'`）：**
  - 点击根视图的「分组」后，在同一 `Drawer` 内切换至 `'group'` 子页（顶部左侧配 `44×44` 返回按钮），直接复用 `listSessionGroups`、`assignSessionGroup`、`assignSessionColor`、`handleCreateGroupForSession`。
  - 触控端彻底替代手工算坐标的 `openGroupMenuFromAnchor` + `.groupMenu`（`position: fixed; width: 240px`），杜绝窄屏溢边与双层浮窗问题。
  - 分组与颜色选项行高均为 `min-h-[44px]` 并带清晰勾选态；点击「新建分组」通过 `closeAndRun` 关闭抽屉后拉起既有新建分组弹窗。
- **弹窗衔接（沿用 `AddMenu.tsx` 的 `closeAndRun` 模式）：**
  - 即时非弹窗操作（置顶、归档/恢复、导出、加入分屏）直接执行并关闭抽屉。
  - 会打开二级模态弹窗的操作（重命名、删除、新建分组）将回调存入 `pendingCloseActionRef`，先关闭 `Drawer`，再在 `DrawerContent` 关闭完成时执行回调（在测试或无动画环境下做好同步兜底），避免 Radix/vaul 两层模态遮罩和焦点陷阱互相打架。

### 3.4 触控端重命名统一走 `SessionRenameDialog`

当重命名由 `SessionActionSheet` 触发（或处于 `isTouchActions` 状态）时：

- 打开仓库已有的 `SessionRenameDialog`（`packages/web-shell/client/components/dialogs/SessionRenameDialog.tsx`），不再激活侧栏行内的 `SessionRenameEditor`。
- 提交后复用同一套重命名处理逻辑（`saveRename` / `StandaloneSessionRowAdapter.onRename`），保持 `onSessionRenameConfirmed` 与错误处理完全一致。
- 桌面鼠标用户通过下拉菜单或双击行仍沿用行内 `SessionRenameEditor`。
- 当 `isTouchActions` 为 `true` 时，屏蔽 `.sessionRow` 上的 `onDoubleClick` 重命名，防止快速点击误入行内编辑。

### 3.5 补齐其余纯 Hover 死角

1. **工作区头部操作（`WorkspaceSection.tsx` + `WebShellSidebar.tsx` + `WorkspaceMenu.tsx`）：**
   - **移除内联 JS 可见性锁定：** 将 `WebShellSidebar.tsx` 中的 `style={{ visibility: visible || openWorkspaceMenuId === ws.id ? 'visible' : 'hidden' }}` 及 `WorkspaceSection.tsx` 中依赖 `onMouseEnter` 的 `actionsVisible` 改为 CSS 类驱动（`.workspaceHeaderActions` + `data-menu-open="true"`），与 `ManagedWorkspaceNavigation.tsx` 及 `.sessionActions` 保持同一模式：
     - 桌面端：在 `.headerRow:hover`、`.headerRow:focus-within` 或 `[data-menu-open="true"]` 时显示（`WorkspaceSection.module.css` / `WebShellSidebar.module.css`）。
     - 触控端 / 移动端抽屉（`@media (pointer: coarse)` 与 `.sidebar.mobileOpen`）：常显单个放大热区的 `⋮`（`WorkspaceMenu`）触发按钮（`36px × 36px`），原本仅悬停出现的独立「新建任务」按钮收进 `WorkspaceMenu`（菜单内本身已有 `actions.newSession`），既保住工作区名称宽度，又让全部工作区操作一键可达。
   - **在 `WorkspaceMenu` 内展示工作区摘要：** 当 `isTouchActions` 为 `true` 时，在 `WorkspaceMenu` 顶部增加紧凑的只读摘要头（完整工作区路径、当前 Git 分支与状态摘要），补足 `WorkspaceDetailsTooltip` 在触屏端不可见的缺口（`WorkspaceMenu` 本身已展示 MCP / Skills / Extensions / Channels 计数）。
   - **对齐 `ManagedWorkspaceNavigation.tsx`：** 将其中的 `[@media(hover:none)]:visible` 调整为 `[@media(pointer:coarse)]:visible`，覆盖支持 Apple Pencil 悬停的 iPad，同时避免在细指针无头 Linux Chromium 上误显示。

2. **会话分组头操作（`SessionGroupSection.tsx` + `WebShellSidebar.module.css`）：**
   - 当前 `.sessionGroupHeaderActions` 并排渲染「重命名分组」和「删除分组」两个图标按钮，且默认 `opacity: 0` 仅靠 hover 显示。
   - 当 `isTouchActions` 为 `true` 且 `onRename` / `onDelete` 至少存在其一时，收敛为 1 个常显的 `⋮` `DropdownMenu` 触发按钮（内部「重命名分组 / 删除分组」项采用 `44px` 触控行高）。
   - 桌面鼠标端保持现有双行内悬停图标不变。

3. **抑制悬停详情浮窗在触屏上的粘滞误闪（`SessionDetailsTooltip.tsx`、`WorkspaceDetailsTooltip.tsx`）：**
   - 在两个组件的悬停进入回调（`onPointerEnter`）中，当 `openOnClick` 为 `false` 且 `event.pointerType && event.pointerType !== 'mouse'` 时直接忽略。
   - 在 `WorkspaceDetailsTooltip.tsx` 中，同时保护 `onFocus` 键盘对等路径，使触摸点击触发的非 `:focus-visible` 焦点不会触发 `openAfterDelay()`。
   - 防止 iOS / Android 浏览器在轻触时派发合成 hover 或点击焦点事件，导致浮窗在侧栏或 Action Sheet 上方意外一闪。

### 3.6 Web Shell 宿主集成约束（触控滚动、Escape、Z-Index、React 18 与 Portal）

结合 `packages/web-shell/client/App.tsx` 与 `packages/web-shell/client/App.module.css` 的现有实现，落地时**必须**满足以下四项工程约束：

1. **`App.tsx` 文档级 `touchmove` 滚动拦截白名单（`preventScroll`）：**
   - 当 `mobileDrawerOpen` 为 `true` 时，`App.tsx` 会在 `document` 上注册非 passive 的 `touchmove` 监听，拦截 `[data-sidebar-shell]`（不含背景遮罩）和白名单（`[data-web-shell-dialog], [data-web-shell-sidebar-more], ...`）之外的所有触控滚动。
   - 由于 `SessionActionSheet` 通过 `useWebShellPortalRoot()` 传送到 `[data-sidebar-shell]` **外部**，因此在 `App.tsx` 的 `preventScroll` 白名单中加入 `[data-web-shell-session-action-sheet]`，并在 `DrawerContent` 上以内联 `style={{ touchAction: 'pan-y' }}` 覆盖 `vaul` 运行时动态注入的未分层 `[data-vaul-drawer]{touch-action:none}` 规则，使抽屉内部在 iOS/Android 上可顺畅原生纵向滚动。
2. **`App.tsx` 捕获阶段 `Escape` 监听（`onKey`）与焦点恢复：**
   - 当 `mobileDrawerOpen` 为 `true` 时，`App.tsx` 会在 `window` 捕获阶段拦截 `Escape` 并直接关掉整个左侧抽屉（除非目标命中白名单 `[data-web-shell-sidebar-more], ...`）。
   - 在 `onKey` 中加入 `[data-web-shell-session-action-sheet]`（并检测已打开的 `[data-web-shell-session-action-sheet][data-state="open"], [data-slot="dropdown-menu-content"][data-state="open"]`），确保外接键盘按 `Escape` 时先只关闭顶层浮层、保留左侧抽屉打开；同时 `SessionActionSheet` 缓存触发按钮 `returnFocusEl`，按 `Escape`/关闭键退出时精准归还焦点到原 `⋮` 按钮，而点外部遮罩关闭时不强抢焦点。
3. **Z-Index 堆叠层级与 Portal 隔离：**
   - `App.module.css` 中的 `.mobileDrawer` / `.mobileDrawerForced` 位于 `z-index: 50`，与 `ui/drawer.tsx` 默认的 `z-[var(--web-shell-dialog-backdrop-z-index,50)]` 处于同一层。
   - `SessionActionSheet` 显式传入叠加层级类 `z-[calc(var(--web-shell-dialog-backdrop-z-index,50)+2)]`（稳定高于 `50` 的 `.mobileDrawer`，低于 `+10` 的 `ToastHost` 与 `1001` 的 `SESSION_MENU_PORTAL_STYLE` 弹层）。
   - 所有弹层（`DrawerPortal`、`DropdownMenuPortal`、`DialogShell`）继续通过 `useWebShellPortalRoot()` 挂载，保持主题变量、作用域 CSS 与 Shadow DOM 嵌入完全兼容。
4. **React 18 与 React 19 Ref 兼容：**
   - 凡是配合 Radix `asChild` 或 `DrawerTrigger` 使用的新增包装组件，均须使用 `React.forwardRef` 正确透传 ref（由 `react18-ref-compat.test.tsx` 兜底验证）。

---

## 4. 关键设计决策与权衡

| 决策项         | 选定方案                                                                       | 备选方案                                                    | 取舍依据                                                                                                                                                                                                                                              |
| -------------- | ------------------------------------------------------------------------------ | ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 主要触控入口   | 行尾常显单个 `⋮` 按钮 + 450 ms 长按                                            | 仅长按（无可见按钮）                                        | 纯长按对新用户和辅助技术可发现性差；`⋮` 保证一眼可见，长按让拇指无需精准瞄准行尾即可呼出，两者互补。                                                                                                                                                  |
| 行级手势       | 长按（Long Press）                                                             | 左滑显示操作（Swipe-to-Reveal）                             | 左滑与 iOS/Android 边缘返回及侧滑抽屉手势冲突，且容不下 6–8 项操作和详情摘要。                                                                                                                                                                        |
| 触控菜单容器   | 底部 `ui/drawer` Action Sheet（宽屏 iPad 居中限宽 `max-w-md`）                 | 全局仅放大 Radix `DropdownMenu`                             | 底部抽屉落在拇指舒适区，天然承载内嵌 `SessionDetailsContent`，并通过抽屉内二级页彻底取代手工定位的 `.groupMenu`（与 `AddMenu.tsx` 保持一致）。                                                                                                        |
| 触控下行内按钮 | 所有行内按钮（`Pin`、`Export`、`Restore`、`Archive`）收进 `⋮`                  | 保留 `Pin` + `⋮` 常显                                       | 390 px 手机上抽屉宽约 273 px，每多放一个 26–36 px 按钮都会明显截断标题并抬高误触概率。                                                                                                                                                                |
| 触控探测口径   | `(pointer: coarse)` + `.sidebar.mobileOpen` + 事件级 `pointerType === 'touch'` | `(hover: none), (pointer: coarse)` 或 `any-pointer: coarse` | 裸 `(hover: none)` 会在无头 Linux 细指针 Chromium 上误判；`any-pointer: coarse` 会影响带触屏桌面电脑。`(pointer: coarse)` 覆盖手机、平板与 Apple Pencil iPad，事件级 `pointerType === 'touch'` 补齐外接触控板 iPad 的手指点击与长按且不干扰鼠标用户。 |
| 触控端重命名   | 复用 `SessionRenameDialog` 弹窗                                                | 继续行内 `SessionRenameEditor`                              | 侧滑抽屉内拉起软键盘容易遮挡行内输入框或误失焦取消；居中弹窗组件现成且已在 `StandaloneRecents` 验证过。                                                                                                                                               |

---

## 5. 分阶段落地计划（P0 -> P1）

既可以拆成 P0 与 P1 两个递增 PR 分步交付，也可以在同一 PR 中按清晰提交边界推进：

### 阶段 P0 — 触控可达性与纯 Hover 死角修复

1. 新增 `useTouchSidebarActions` hook（`packages/web-shell/client/components/sidebar/use-touch-sidebar-actions.ts`）。
2. 将 `WebShellSidebar.module.css`（及 `ManagedWorkspaceNavigation.tsx`）的触控媒体查询调整为 `@media (pointer: coarse)` 并覆盖 `.sidebar.mobileOpen`；在非 `[data-narrow]` 的触控/抽屉模式下将 `.sessionRow:not(.archivedRow)` 设为 `min-height: 40px`、`.sessionActionButton` 设为 `36px × 36px`；将 `.sessionBackgroundRunning:hover` 规则收紧在 `@media (hover: hover) and (pointer: fine)` 中。
3. 在 `isTouchActions` 模式下，将普通、归档、独立、最近四类会话行统一收敛为单个 `⋮` 按钮（非当前行降低透明度），把被收敛的 `Pin` / `Export` / `Restore` / `Archive` 统一并入菜单。
4. 修复 `WorkspaceSection.tsx` + `WebShellSidebar.tsx` 工作区头部操作：用 CSS 状态（桌面 `hover` / `focus-within` / `data-menu-open`，触控/抽屉常显单个 `⋮`）替换 JS 内联 `visibility`，并在触控下于 `WorkspaceMenu` 顶部呈现工作区路径与分支摘要。
5. 修复 `SessionGroupSection.tsx`：在 `isTouchActions` 模式下提供常显的分组 `⋮` 菜单以触发重命名/删除分组。
6. 更新 `SessionDetailsTooltip.tsx` 与 `WorkspaceDetailsTooltip.tsx`，忽略非鼠标 `pointerType` 的悬停触发；若 P0 单独先发版，则在 P0 下拉菜单中先临时提供「查看详情」项。

### 阶段 P1 — 底部 Action Sheet、长按、抽屉内分组选择与弹窗重命名

1. 从 `SessionDetailsTooltip.tsx` 抽取共享展示组件 `SessionDetailsContent`，同时供桌面悬停浮窗与 Action Sheet 顶部复用。
2. 基于 `ui/drawer` 实现 `SessionActionSheet.tsx`，包含根视图（内嵌详情 + 动作列表）、`'group'` 二级页（颜色、命名分组、新建分组）、`data-web-shell-session-action-sheet` 标记、`closeAndRun` 模态衔接以及 `z-[calc(var(--web-shell-dialog-backdrop-z-index,50)+2)]` 层级。
3. 实现 `useLongPress` hook（`packages/web-shell/client/components/sidebar/use-long-press.ts`），在 `isTouchActions && !selectionMode` 时接入可操作会话行。
4. 在 `WebShellSidebar.tsx` 中将触控触发的重命名路由至 `SessionRenameDialog`，并在 `isTouchActions` 时屏蔽行双击重命名。
5. 更新 `packages/web-shell/client/App.tsx` 的 `preventScroll`（`touchmove` 白名单）与捕获阶段 `Escape` 监听，豁免 `[data-web-shell-session-action-sheet]`。
6. 补齐全部多语言词条文件所需的增量文案键（如抽屉无障碍标题、返回等，优先复用已有 `sidebar.*` 和 `common.*` 键）。

---

## 6. 风险与边界场景

- **外接键鼠/触控板的 iPad：** 在 `(hover: none), (pointer: coarse)` 下，连接触控板的 iPad 视 iPadOS 版本可能仍对主屏上报 `pointer: coarse`，因而保留单按钮 `⋮` 与居中限宽 Action Sheet。这是有意设计：iPad 用户常在手指与触控板之间随时切换，居中 Action Sheet 对指针、触摸和键盘（`Escape` / `Tab`）都友好。
- **既有样式表与视觉合约测试：**
  - `packages/web-shell/client/components/sidebar/WebShellSidebar.css.test.ts` 断言了触控媒体查询下的 `.sessionActions` 与 `[data-narrow]` 换行样式。
  - `packages/web-shell/client/visual-capture-contracts.test.ts` 用正则断言了 `.sessionRow:has(.sessionBackgroundRunning:hover) .sessionActions` 位于 `@media (hover: hover)` 块内。
  - 两套测试同步更新以锁定 `@media (pointer: coarse)` 查询（且断言不存在易误伤的裸 `(hover: none),`）、`:not([data-narrow])` 放大热区及桌面 Hover 规则，同时保持 Settings 的 `ArchivedSessionsPanel` 测试不受影响。
- **Action Sheet 打开期间目标会话被删除或刷新：** 建议以 `{ sessionId, workspaceCwd, scope }` 为主键并结合实时目录数据解析当前会话，而不是只存过期快照；若目标会话消失（如被其他客户端删除或工作区移除），自动关闭 Action Sheet 并将 `page` 重置为 `'root'`。
- **长按与列表滚动/拖拽排序的冲突：** 位移超过 `10 px` 立即取消长按，且不给工作区拖拽把手或 `SelectableSessionRow` 绑定长按。
- **嵌入式宿主与 Shadow DOM：** 严格沿用 `useWebShellPortalRoot()`，避免直接查 `document.body` 做焦点/包含判定，并在 `WebShellSidebar.module.css` 内自带 `-webkit-touch-callout: none` 规则（不只依赖 `standalone.css`）。
- **iOS 聚焦重命名输入框自动放大：** `SessionRenameDialog` 使用 `ui/input`，须确认触控端字号不低于 `16px`（或确保既有防缩放样式生效），防止 iOS Safari 聚焦时自动放大页面。

---

## 7. 验证计划与验收标准

### 自动化验证

1. **单元测试与合约测试（Vitest，在 `packages/web-shell` 内运行）：**
   - `use-touch-sidebar-actions.test.tsx` 与 `use-long-press.test.tsx`：覆盖媒体查询响应、450 ms 触发、`>10 px` 移动取消、`pointerup`/`pointercancel` 取消、鼠标事件忽略、内部按钮点击忽略以及随后的 `click` 抑制。
   - `SessionActionSheet.test.tsx` 与 `WebShellSidebar.touch-actions.test.tsx`：覆盖动作门禁（`sessionActions.items`、`bindPr`、`sessionBlocksDelete`、`busy` 禁用态）、顶部内嵌 `SessionDetailsContent`（标题、工作区、分支、PR 链接、复制 Session ID）、`'group'` 子页切换与分组赋值、长按呼出、`closeAndRun` 衔接 `SessionRenameDialog` 以及 `mobileOpen` 下工作区头部收敛。
   - `WorkspaceSection` / `WorkspaceMenu.test.tsx` 与 `SessionGroupSection.test.tsx`：验证触控模式下无需 hover 即可看到并操作工作区 `⋮` 菜单（含路径/分支摘要）与分组 `⋮` 菜单。
   - `SessionDetailsTooltip.test.tsx` 与 `WorkspaceDetailsTooltip.test.tsx`：验证 `pointerType: 'touch'` 的 `pointerenter`（及触摸聚焦）不会触发悬停浮窗，`pointerType: 'mouse'` 与键盘聚焦保持原有行为。
   - `App.test.tsx`：验证在 `mobileDrawerOpen` 打开时，`[data-web-shell-session-action-sheet]` 与 `[data-slot="dropdown-menu-content"]` 内的 `touchmove` **不会被** `defaultPrevented`，且按 `Escape` 只关闭浮层而不关闭底层侧边栏抽屉。
   - `WebShellSidebar.css.test.ts` 与 `visual-capture-contracts.test.ts`：更新断言以覆盖放宽后的触控媒体查询、单按钮布局、放大热区、保留的 `[data-narrow]` 规则及桌面端 Hover 守卫。
   - `react18-ref-compat.test.tsx` 与 `chat-core/boundary.test.ts`：覆盖 `forwardRef` 兼容性与打包边界守卫。
2. **浏览器 E2E 测试（Playwright）：**
   - `web-shell.sidebar-touch.mobile.spec.ts`（`mobile-chromium` 触控配置）验证：
     - 会话行与 Recent 行仅显示 1 个 `⋮` 按钮，热区 `>= 36×36 px`，行高 `>= 40 px`；
     - 点击 `⋮` 弹出底部 Action Sheet 且不切换当前会话，内嵌会话详情（含复制 Session ID）可见且可用；
     - 长按会话行呼出同一 Action Sheet 且不切换当前会话；
     - 点击「分组」在抽屉内切到分组子页并成功变更分组；点击「重命名」打开 `SessionRenameDialog` 并保存成功；
     - 工作区头部 `⋮` 菜单无需 hover 即可见并展示工作区摘要。
   - `web-shell.archived-settings.spec.ts`（`chromium` 桌面与触控）确认 Settings 归档行零回归。
3. **仓库门禁：** `npm run build`、`npm run typecheck`、`npm run lint` 以及相关单测与 Playwright 测试。

### 验收标准

- [ ] 在 iPhone、iPad（含混合悬停/粗指针配置）与 Android 视口下，所有可操作会话行均只显示 1 个 `⋮` 按钮（热区 `>= 36×36 px`），不再出现挤压标题的多按钮常显排布。
- [ ] 点击 `⋮` 或长按（约 450 ms）会话行均可弹出底部 `SessionActionSheet` 且不切换当前会话；列表滚动时干净取消长按。
- [ ] `SessionActionSheet` 顶部内嵌会话详情（标题、工作区、分支、状态、PR/Issue 链接、可复制的 Session ID），并内置 `>= 44 px` 行高的分组/颜色二级选择页。
- [ ] 触控端重命名会话弹出 `SessionRenameDialog`，不再激活侧栏行内输入框。
- [ ] 工作区头部操作（`WorkspaceMenu` 及其顶部摘要）与分组头操作（重命名/删除分组）无需 hover 即可通过点击触达。
- [ ] `SessionDetailsTooltip` 与 `WorkspaceDetailsTooltip` 不会在触屏轻触时意外闪现。
- [ ] 移动端侧边栏抽屉打开期间，Action Sheet 内部触控滚动与 `Escape` 分层关闭均工作正常。
- [ ] 桌面鼠标交互（Hover 显隐、行内按钮、悬停详情浮窗、下拉菜单、行内重命名）完全无回归。

---

## 8. 后续规划（不在本次范围 / P2）

- **对话页顶栏标题点击看详情与快捷操作（`ChatPane.tsx`）：** 在触控端为 `ChatPane` 标题栏的 `SessionDetailsTooltip` 开启现成的 `openOnClick`（并可选提供当前会话的重命名/置顶/归档快捷入口），避免用户为管理当前会话反复划开左侧栏。
- **托管模式会话 Action Sheet 对齐：** 如后续需要，`ManagedSessionActions` 也可在移动端从 `DropdownMenu` 升级为同一套底部 Action Sheet 形态（超出本次 P0 的触发器/热区改进）。
