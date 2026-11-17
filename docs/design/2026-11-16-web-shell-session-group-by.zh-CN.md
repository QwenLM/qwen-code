# Web Shell 侧边栏会话分组

[English](2026-11-16-web-shell-session-group-by.md) | [简体中文](2026-11-16-web-shell-session-group-by.zh-CN.md)

**状态：** 已于 2026-11-16 实现并验证。

## 背景

[工作区筛选设计](2026-11-14-web-shell-workspace-filter.zh-CN.md)引入的侧边栏显示选项菜单已经支持会话排序和工作区筛选，但主会话目录始终按工作区分组。工作区较多时，用户需要一种按时间查看的方式，让不同工作区最近活跃的会话集中呈现。

## 目标与范围

- 新增 `Group by` 子菜单，先支持 `Workspace` 和 `Activity date`；默认 `Workspace`，保留现有渲染路径。
- 在 `Activity date` 下，将当前 host 的工作区活跃会话合并到四个互斥的滚动范围：`Today`、`This week`、`Last 30 days` 和 `Older`。
- 保留现有工作区筛选、两种会话排序、完整会话行操作、加载与重试行为，以及按 host 保存偏好的能力。
- 置顶、无工作区、最近会话、Live、归档、其他 host 和自定义 Managed 区域继续使用现有路径。
- 本期不增加 `Custom group`，不修改 daemon API。Activity 待办视图的渲染和数据范围不变，其共享重试现在也会刷新失败或被截断的游标页。

## 交互与持久化

`Group by` 位于显示选项菜单第一项，其后依次是 `Sort by` 和 `Workspace`。触发行显示当前分组名称，子菜单使用 radio 语义。`Restore defaults` 同时将分组恢复为 `Workspace`、排序恢复为 `Recent activity`、筛选恢复为 `All`。

偏好使用 `web-shell:session-group-by:<host>`，取值为 `workspace` 和 `activityDate`。缺失或非法值回退到 `workspace`。与排序和筛选一致，状态记录所属 host，A → B → A 的导航不会把 B 的偏好应用到 A。

只有普通非频道界面（包括来源为 `undefined` 的旧 daemon）具有非空项目列表，且所有可见项目工作区都能通过现有 qualified Activity 目录读取时，才提供分组子菜单。不支持的场景、Managed、纯频道、仅无工作区/Live 和无工作区范围使用 `Workspace`，不替换其现有区域。

## 数据与分组模型

复用现有 `useActivityCatalog` 实例。打开 Activity 待办视图或 Activity date 分组时，都会沿所有可达 `nextCursor` 加载，按工作区和会话 ID 去重，并保留部分失败状态供重试。不支持 live state 的 daemon 上，根页面继续按 30 秒轮询，历史游标页保持订阅但不单独轮询。这样无需新增一套目录实现，也不会受到 Recent 区域 20 行上限或 Activity 视图 7 天截止范围的限制。

活动时间使用 `max(updatedAt, createdAt)`，与 `activityRecency` 一致。`Today` 从本地午夜开始，包含未来时间戳。`This week` 从本地周一 00:00 开始，到今天之前结束。`Last 30 days` 从今天之前 29 个本地自然日开始，到本周之前结束。`Older` 包含所有更早会话。各范围互斥，空范围隐藏，其余范围始终按上述固定顺序显示。每个范围内按当前排序方式排列：最近活动或最后提问；缺少最后提问时间时沿用现有回退，并以工作区/会话 ID 稳定打破并列。

时间列表采用扁平结构，包含子会话，不跨工作区构造父子关系，确保所有已加载会话仍然可见。会话行复用现有完整渲染器。日期条目来自合并乐观置顶/取消置顶后的目录，并通过显式包含子会话的选项应用 Activity eligibility 规则；定时任务运行、实时语音、来源不匹配和归档行会被排除。合并状态为置顶的所有行只留在现有置顶区域。未读和折叠状态追踪使用同一渲染集合，Activity 待办视图仍使用原有完整集合。现有自定义分组和颜色在此模式下不生成额外区域。

每个范围沿用现有分组区域样式，包含数量、折叠控件、5 行预览和逐步 Show more 操作。只有正在重命名的行达到或超过 5 行预览边界时才取消截断，身份比较同时包含工作区和会话 ID。分组按条目、排序方式和当前本地日期 memoize。范围折叠状态仅在当前挂载视图内保留；新增持久化的只有分组偏好。

## 兼容与失败行为

Workspace 模式保留当前工作区区域、拖拽排序、自定义分组、展开控件和数据查询。Activity date 模式只替换当前 host 的 `orderedProjectWorkspaces` 列表。该模式下区域标题变为静态的「最近对话」（Recent conversations），并保留显示选项；仅属于工作区模式的数量、拖拽和全部折叠控件会隐藏。此前折叠的 Workspaces 区域不会隐藏日期分组，其持久化展开偏好会为 Workspace 模式保留。

无工作区会话继续留在独立区域，因为 Activity 目录是 workspace-qualified。其他 host 的项目也保持不变，因为偏好和目录都限定在当前 host。Live、归档、Recent 和置顶区域保持现有行为。

如果任一可见项目工作区未受信任、缺少绝对 qualified 路径，或 organized 目录 / `workspace_qualified_rest_core` 能力不可用，界面不提供 Activity date，并回退到 Workspace，避免静默丢行。部分目录失败时保留已加载的日期行，并提供现有重试操作。重试会立即刷新根查询和失败的游标查询，而不是等待 store 的重试计时器。后续页面自动获取期间显示加载进度。

## 无障碍与展示

沿用现有 Radix 嵌套菜单和 portal primitives，支持键盘导航、`menuitemradio` 和 `aria-checked`。复用现有区域标题和会话行，不引入新的视觉语言。为中英文分别增加 `Group by`、`Workspace`、`Activity date` 以及日期模式下「最近对话」标题文案。

## 验证

- 12 个受影响的 Vitest 文件：339 个测试通过，其中 41 个为 locale 契约测试。覆盖四个滚动范围、周一/30 天边界、DST 跨日、两种排序、仅构建可见行、重命名保护、原有与乐观置顶状态、来源/eligibility 过滤、qualified REST 回退、搜索选择、仅根页面轮询及三种不可用游标状态。
- `npm run build`：通过。
- `npm run typecheck`：通过。
- 所有改动的实现、测试、本地化和文档文件的 ESLint 与 Prettier 检查：通过。
- Chromium Playwright workspace-sidebar 套件：6 个场景通过，覆盖 Activity date 分组、工作区筛选、重载持久化、Restore defaults 及现有工作区排序回归。
- 已检查菜单和 Activity date 截图的裁切、选中态对齐、分组数量、行布局及过期/加载帧。

## 验收标准

- [x] 默认 `Workspace`，现有侧边栏行为不变。
- [x] `Activity date` 将工作区会话合并到互斥的 `Today`、`This week`、`Last 30 days` 和 `Older` 范围，不受 Recent 20 行或 Activity 7 天限制。
- [x] 日期模式下工作区筛选、两种排序、完整行操作和游标分页均可用。
- [x] 不替换置顶、无工作区、Recent、Live、归档、其他 host 和 Managed 区域。
- [x] 分组按 host 持久化；非法值和不支持的范围安全回退；Restore defaults 重置全部显示选项。
- [x] 验证英文、中文、键盘交互、加载、空状态和部分失败状态。
