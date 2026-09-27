# Web Shell 输入框上下文 chip：工作区与 git 的位置

[English](web-shell-composer-context-chip-placement.md) | [简体中文](web-shell-composer-context-chip-placement.zh-CN.md)

Status: implemented
Date: 2026-09-20
Related: [web-shell-composer-workspace-selector.md](web-shell-composer-workspace-selector.md)（本设计要搬动的那个输入框下拉）、[web-shell-pane-header-actions.md](web-shell-pane-header-actions.md)（分屏 pane header 上的工作区 tag，新 icon 沿用它的位置口径）

## Problem

输入框工具条里带着两个描述"这条 prompt 发往哪里"、而不是"它怎么运行"的控件：工作区选择器，以及首条 prompt 之前的 git 分支 chip。它们夹在 `+` 菜单与模式/模型控件之间，让整条工具条读起来像一列互不相干的动作。在有会话时这比观感问题更麻烦：工作区选择器只会作用于**下一个**会话，却和一堆作用于当前会话的控件混在一起。

## Current state

- `ChatEditor` 把这两个 chip 渲染在输入框工具条里，由 `visibleToolbarActions` 门控。工作区选择器需要 `workspace` 动作，外加"注册了不止一个工作区"或"具备创建工作区能力"；git chip 需要 `gitBranch`，而只有空会话的默认工具条会打开它。
- `ChatContextHeader` 渲染会话标题与右侧面板动作；它的左侧区域只有标题。
- 分屏 pane 的 header 早已展示一个只读的工作区 tag；`App` 只在对话不再为空之后才渲染主 header。

## Goals

- 会话还不存在时，工作区和 git 两个 chip 落在紧贴输入框外框下方、自己单独的一行里，让输入框本身只关于 prompt。
- 会话存在之后，对话 header 用**一个**前置 icon 报告该会话的工作区，hover 时给出文件夹名，且不提供点击行为。
- 这个 header icon 在主对话 header 中常驻：有工作区、没工作区都用同一个文件夹字形，差别只在 hover 出来的内容。

## Non-goals

- 不改变控件是否可用：宿主仍通过 `composerToolbarActions` 选择，且**没有**向 `header.items` 定制契约新增条目。父层可见性判断仅对齐选择器已有的无工作区切换回调要求，避免空底栏。
- 不新增 daemon 路由、协议字段或持久化。icon 完全由 shell 已持有的工作区状态推导。
- 不动分屏输入框及其工作区 chip —— 那里的 chip 是用来区分 pane 的。共享工作区菜单在所有位置（含嵌入宿主）统一优先向上弹出。
- 不在 header icon 上做工作区切换。为已存在的会话选择工作区仍然是侧边栏的职责。
- 不新增 i18n key：icon 复用 `workspace.paneLabel` 与 `sidebar.noWorkspace`。

## Proposal

`ChatEditor` 新增 `contextChipPlacement: 'toolbar' | 'below' | 'header'`，默认 `toolbar`。

- `toolbar` 保持今天的排布，供分屏和自行配置输入框的宿主使用。
- `below` 把两个 chip 移到输入框外壳内、紧贴边框盒子之后的一行里。这一行**始终显示文字标签**，因为它有自己的宽度预算 —— 工具条那套标签自适应测量管不到工具条之外。底栏使用柔和背景和底部圆角，背景向上延伸至输入框背后，形成相连的整体。底栏 Git 控件使用中性色文字，去掉边框、彩色填充和右侧箭头，并加宽水平留白。悬停 Git 时使用共享 tooltip 展示完整分支名，长连续名称自动换行；工作区菜单与 Git 一样向上弹出。
- `header` 从输入框里去掉工作区选择器、把 git 留在工具条，因为工作区归 header 管。

`App` 在对话为空（`isChatEmptyState`）时传 `below`，否则传 `header`，因此任一时刻只有一个位置在报告工作区。

`ChatContextHeader` 新增 `workspaceName` / `workspacePath`，并在 content 之前渲染一个 `role="img"` 的文件夹 icon。hover 它时弹出应用自己的 tooltip（就是 pane 上那个工作区 chip 用的同一套），展示工作区名与完整路径 —— 只有一个 icon 的触发点没法自己说出工作区是谁；无障碍名用 `workspace.paneLabel`。无工作区态**用的是同一个字形**，只把 tooltip 与无障碍名换成 `sidebar.noWorkspace`：这个 icon 是"这条会话属于哪个工作区"的常驻答案，所以它不挪位置。该 icon 不是按钮，因此不给 header 增加任何动作。其颜色与标题一致，悬停时显示圆角强调背景；暂不支持键盘触发。

## Design decisions

- **切换点跟随空会话，而不是消息条数。** header 只在对话非空时渲染，用同一个标志位驱动两个位置，才能保证工作区不会被同时报告两次。
- **header icon 无条件显示，输入框里的 chip 不是。** 打开 `workspace` 输入框动作的宿主会拿到整套行为，但 icon 不再要求"多工作区"或"具备创建能力"：只有一个注册工作区时，报告工作区本身就有用，而"可切换"是它过去唯一隐藏的理由。
- **只读 icon。** hover 报告工作区，没有任何可点项，因此 header 保持既有动作集合，工作区切换仍属于"会话创建前"的动作。
- **自行渲染 header 的宿主保留其 header。** `renderChatHeader` 本就收到 `workspaceCwd`，所以这类宿主同样自己负责这个指示，不会被注入 icon。

## Constraints

- 底栏仅在至少一个入口实际可用时渲染。无工作区选择需同时提供支持标记和切换回调；保留受控可见性、选中值、回调及禁用状态。

- placement 是纯新增属性且默认等于今天的行为，因此分屏输入框与既有测试都不受影响。
- 两个 chip 在两种位置下必须是同一批组件：一个 chip 一个渲染器、以"是否紧凑"为参数，而不是复制一份 markup。

## Risks

- 只有一个工作区、又不具备创建工作区能力时，输入框仍会隐藏工作区选择器，而 header 会显示工作区 icon —— 两个位置在"控件是否出现"上可能不一致，尽管报告的是同一个工作区。
- 完全没有工作区概念的 shell（standalone、Live）也会出现这个 header icon，hover 内容为「无工作区」，这对那些 shell 是一处新的视觉元素。

## Validation plan

- 单测：`ChatEditor` 默认把两个 chip 留在工具条；`below` 时把它们移入输入框下方那一行（工具条里不再留任何一个）；`header` 时 git 仍留在工具条；两个 chip 都不可用时整行不渲染。`ChatContextHeader` 报告工作区名/路径、缺路径时回退到名字、报告无工作区态，且不新增按钮。
- 类型检查、lint、格式化，以及既有的 `App`、`ChatEditor`、`ChatContextHeader` 测试套件。

## Acceptance criteria

- 新建对话时，工作区与 git 两个 chip 出现在输入框正下方，且不再出现在工具条里。
- 会话中，header 只显示一个文件夹 icon，hover 时给出工作区名，且输入框里不再有工作区控件。
- 没有工作区的会话在同一位置显示同一个文件夹 icon，只是 hover 内容说明没有工作区。
- 分屏与自行配置输入框的宿主保持原有排布。

## Open questions

None.
