# Web Shell 侧边栏会话分组

[English](2026-11-16-web-shell-session-group-by.md) | [简体中文](2026-11-16-web-shell-session-group-by.zh-CN.md)

**状态：** 已于 2026-11-16 实现并验证。

## 背景

[工作区筛选设计](2026-11-14-web-shell-workspace-filter.zh-CN.md)引入的侧边栏显示选项菜单已经支持会话排序和工作区筛选，但主会话目录始终按工作区分组。工作区较多时，用户需要一种按时间查看的方式，让不同工作区最近活跃的会话集中呈现。

## 目标与范围

- 新增 `Group by` 子菜单，先支持 `Workspace` 和 `Activity date`；默认 `Workspace`，保留现有渲染路径。
- 在 `Activity date` 下，按本地活动日期对当前 host 的工作区活跃会话分组，并将不同工作区的会话合并到同一日期区域。
- 保留现有工作区筛选、两种会话排序、完整会话行操作、加载与重试行为，以及按 host 保存偏好的能力。
- 置顶、无工作区、最近会话、Live、归档、其他 host 和自定义 Managed 区域继续使用现有路径。
- 本期不增加 `Custom group`，不修改 daemon API，也不改变独立的 Activity 待办视图。

## 交互与持久化

`Group by` 位于显示选项菜单第一项，其后依次是 `Sort by` 和 `Workspace`。触发行显示当前分组名称，子菜单使用 radio 语义。`Restore defaults` 同时将分组恢复为 `Workspace`、排序恢复为 `Recent activity`、筛选恢复为 `All`。

偏好使用 `web-shell:session-group-by:<host>`，取值为 `workspace` 和 `activityDate`。缺失或非法值回退到 `workspace`。与排序和筛选一致，状态记录所属 host，A → B → A 的导航不会把 B 的偏好应用到 A。

只有普通非频道界面（包括来源为 `undefined` 的旧 daemon）具有非空项目列表，且所有可见项目工作区都能通过现有 qualified Activity 目录读取时，才提供分组子菜单。不支持的场景、Managed、纯频道、仅无工作区/Live 和无工作区范围使用 `Workspace`，不替换其现有区域。

## 数据与分组模型

复用现有 `useActivityCatalog` 实例。打开 Activity 待办视图或 Activity date 分组时，都会沿所有可达 `nextCursor` 加载，按工作区和会话 ID 去重，并保留部分失败状态供重试。这样无需新增一套目录实现，也不会受到 Recent 区域 20 行上限或 Activity 视图 7 天截止范围的限制。

活动时间使用 `max(updatedAt, createdAt)`，与 `activityRecency` 一致。会话按本地自然日分桶，日期区域按最新到最旧排列，标题为 `Today`、`Yesterday` 或本地化的星期/月份/日期。每个区域内按当前排序方式排列：最近活动或最后提问；缺少最后提问时间时沿用现有回退，并以工作区/会话 ID 稳定打破并列。

时间列表采用扁平结构，包含子会话，不跨工作区构造父子关系，确保所有已加载会话仍然可见。会话行复用现有完整渲染器。日期条目来自合并乐观置顶/取消置顶后的目录；合并状态为置顶的所有行只留在现有置顶区域，不在日期区域重复显示。现有自定义分组和颜色在此模式下不生成额外区域。

每个日期区域沿用现有分组区域样式，包含数量、折叠控件、5 行预览和逐步 Show more 操作。包含正在重命名编辑器的日期区域关闭预览截断，避免重排序卸载编辑器；身份比较同时包含工作区和会话 ID。日期区域的折叠状态仅在当前挂载视图内保留；新增持久化的只有分组偏好。

## 兼容与失败行为

Workspace 模式保留当前工作区区域、拖拽排序、自定义分组、展开控件和数据查询。Activity date 模式只替换当前 host 的 `orderedProjectWorkspaces` 列表。Workspaces 标题仍承载显示选项和整体展开状态；仅属于工作区模式的数量、拖拽和全部折叠控件在日期模式下隐藏。

无工作区会话继续留在独立区域，因为 Activity 目录是 workspace-qualified。其他 host 的项目也保持不变，因为偏好和目录都限定在当前 host。Live、归档、Recent 和置顶区域保持现有行为。

如果任一可见项目工作区未受信任、缺少绝对 qualified 路径，或 organized 目录能力不可用，界面不提供 Activity date，并回退到 Workspace，避免静默丢行。部分目录失败时保留已加载的日期行，并提供现有重试操作。重试会立即刷新根查询和失败的游标查询，而不是等待 store 的重试计时器。后续页面自动获取期间显示加载进度。

## 无障碍与展示

沿用现有 Radix 嵌套菜单和 portal primitives，支持键盘导航、`menuitemradio` 和 `aria-checked`。复用现有区域标题和会话行，不引入新的视觉语言。为中英文分别增加 `Group by`、`Workspace` 和 `Activity date` 文案。

## 验证

- 8 个受影响的侧边栏 Vitest 文件：261 个测试通过，覆盖偏好、本地日期分桶、两种排序、重命名保护、原有与乐观置顶状态、能力回退、搜索选择及三种不可用游标状态。
- Locale 契约测试：40 个测试中英文字符串用例通过。
- `npm run build`：通过。
- `npm run typecheck`：通过。
- 所有改动的实现、测试、本地化和文档文件的 ESLint 与 Prettier 检查：通过。
- Chromium Playwright workspace-sidebar 套件：6 个场景通过，覆盖 Activity date 分组、工作区筛选、重载持久化、Restore defaults 及现有工作区排序回归。
- 已检查菜单和 Activity date 截图的裁切、选中态对齐、分组数量、行布局及过期/加载帧。

## 验收标准

- [x] 默认 `Workspace`，现有侧边栏行为不变。
- [x] `Activity date` 将工作区会话合并到本地日期区域，不受 Recent 20 行或 Activity 7 天限制。
- [x] 日期模式下工作区筛选、两种排序、完整行操作和游标分页均可用。
- [x] 不替换置顶、无工作区、Recent、Live、归档、其他 host 和 Managed 区域。
- [x] 分组按 host 持久化；非法值和不支持的范围安全回退；Restore defaults 重置全部显示选项。
- [x] 验证英文、中文、键盘交互、加载、空状态和部分失败状态。
