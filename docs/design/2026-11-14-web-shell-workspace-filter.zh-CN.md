# Web Shell 侧边栏工作区筛选

[English](2026-11-14-web-shell-workspace-filter.md) | [简体中文](2026-11-14-web-shell-workspace-filter.zh-CN.md)

**状态：** 已于 2026-11-14 实现并验证。

## 背景

[#17142](https://github.com/QwenLM/qwen-code/issues/17142) 要求在较长的 Web Shell 侧边栏中能够查找工作区。本次明确采用独立的工作区选择器，不改变会话搜索语义，因此同一个查询同时匹配工作区和会话时，不会悄悄切换搜索模式。

侧边栏原本已有持久化的会话排序菜单。新控件将这一入口扩展为显示选项菜单，包含 `Sort by` 和 `Workspace` 两个子菜单，以及 `Restore defaults` 操作。ListFilter 触发图标位于 Workspaces 标题行，与现有工作区操作并列；隐藏该标题的布局保留原操作行回退入口，折叠会话弹层中也仍可访问。

## 目标与范围

- 列出 `All`、`No workspace` 和当前 host 的全部工作区，沿用现有工作区显示名称。
- 将项目、Live、置顶、归档、最近会话和无工作区界面过滤到所选范围。
- 按 host 分别持久化工作区筛选和会话排序。
- 通过一个操作恢复 `All` 和 `Recent activity`。
- 支持键盘导航、radio 语义、长名称、英文和中文。

不修改 composer 的工作区选择器；会话搜索不会根据查询词推断工作区筛选，也不新增分组或活动筛选。

## 交互与持久化

`Workspace` 是单选子菜单。默认值为 `All`，`No workspace` 选择无工作区会话，其余每个 radio 项以 `workspace:<cwd>` 编码一个工作区。触发项显示当前名称，子菜单用勾选标记选中项。

原有排序选项移入 `Sort by`，值保持不变。即使 host 不支持按最后提问时间排序，`Restore defaults` 也始终写入两个默认值。

偏好使用 `web-shell:workspace-filter:<host>` 和现有的 `web-shell:session-sort:<host>` 键。缺失、非法和空工作区值回退到 `all`。状态与所属 host 关联，A → B → A 的导航不会把 B 的筛选应用到 A。

## 过滤模型

未过滤的 `sidebarWorkspaces` 集合提供菜单选项。`displayedWorkspaces` 派生所选范围，并传给现有项目/Live 目录及其下游查询。`All` 保留原来的主会话启用规则；选择具体工作区时，只有主工作区仍可见才启用主会话。

无工作区区域只在 `all` 或 `standalone` 下渲染，其他 host 的项目区域只在 `all` 下渲染。独立 Live pending 区域只在 `all` 下显示；工作区自己的 Live 区域仍处理各自的 pending 行。

包括进行中的乐观置顶在内，所有置顶候选都使用同一工作区谓词。最近会话在 render 阶段同步过滤已加载条目，避免 passive effect 清空状态前，旧范围的行短暂提交一次。切换筛选会退出批量选择模式并清空已选会话，防止修改刚被隐藏的行。

## 无障碍与展示

实现沿用现有 Radix dropdown primitives 和 portal 集成。嵌套菜单保留键盘焦点管理，并暴露 `menuitemradio`/`aria-checked`。工作区长名称会截断，通过 `title` 提供完整名称；子菜单超出最大高度时可滚动。新增文案具有对应的英文和中文条目。

## 验证

- 7 个受影响的 Vitest 文件：320 个测试通过。
- `npm run typecheck`：通过。
- `npm run build`：通过。
- 所有改动的实现、测试和本地化文件的 ESLint 与 Prettier 检查：通过。
- Chromium Playwright 场景覆盖选择、重载持久化、`No workspace` 和 `Restore defaults`：通过。
- 已检查菜单截图中的裁切、选中态对齐和子菜单布局。

## 验收标准

- [x] 无需使用会话搜索即可显式选择工作区。
- [x] `No workspace` 保留无工作区会话并隐藏工作区区域。
- [x] 选择具体工作区会隐藏其他工作区、其他 host 项目、无工作区行、旧范围最近会话行，以及其他范围进行中的乐观置顶。
- [x] 重载后在同一 host 保留筛选，且不会与其他 host 共享。
- [x] `Restore defaults` 同时恢复 `All` 和 `Recent activity`。
- [x] 现有排序和默认 `All` 行为保持不变。
