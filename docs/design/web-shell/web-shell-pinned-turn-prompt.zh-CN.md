# Web Shell 固定显示当前轮次提示

[English](web-shell-pinned-turn-prompt.md) | [简体中文](web-shell-pinned-turn-prompt.zh-CN.md)

状态：已实现 #15683 的首版。日期：2026-11-01。

## 问题与范围

较长的轮次会把提示推到视口上方很远的位置。轮次导航条只在悬停时显示提示，而且当对话宽度加上两侧各 64px 的留白放不下时，导航条会隐藏。在默认侧边栏的 1440px 窗口、全宽模式和窄布局下，转录内容中没有任何信息说明当前可见的输出属于哪条提示。

本次改动在转录视口顶部增加一个紧凑的浮层。它显示正在阅读的轮次的提示，最多两行，在矮视口上最多一行。所有改动都在 `packages/web-shell` 内。没有 daemon 协议改动，也没有新增文案。

本次不包含：关闭该功能的设置项、针对 `legacy` 和 `degraded` 导航模式的回退、Split View、点击跳转。

## 取哪一轮、用哪个标签

浮层读取导航条已在跟随的 `TurnFollowRange` 中的 `current`，因此两者不会不一致。它不自行计算滚动位置。标签来自 `DaemonSessionTurnIndexEntry.label`；对于索引中还没有的轮次，标签来自 `DaemonProvisionalTurn.label`。该规则由 `turn-navigation-store.ts` 中的 `turnLabelForOrdinal` 实现，导航条使用同一个辅助函数。没有标签时，浮层不渲染任何内容。

## 对跟随计算的改动

原有的跟随范围在四个方面不能满足此功能，每一项都需要改动：

- 导航条隐藏时 `updateFollow` 会直接停止，而这正是此功能的主要场景。现在视口带有 `pinnedPrompt` 属性时它也会运行。导航条仍然只在可见时才接收 `follow`，因此隐藏的导航条会保持自己的窗口。
- 块到序号的映射原先只在导航条可以显示时存在（`hideSessionTimeline` 关闭且至少四个轮次）。现在当带有 `pinnedPrompt` 且轮次导航为 `ready` 或 `loading` 时也会存在，因此全宽模式和较短的会话都可以工作。
- `followRangeFromRows` 只从已挂载的行继承轮次。在一个已展开且行数超过虚拟化器 overscan（20）的轮次中，提示行会被卸载，没有已挂载的行能映射到轮次，因此范围为 `undefined`。现在 `turnOrdinal` 按消息顺序为 `messages` 中的每个块赋予其所属轮次的序号。导航条也得到了这个修复，不会再在长轮次中途丢失高亮。`followRangeFromRows` 本身没有改动。
- 若某条用户消息的块不在索引中，它开始的是一个未知轮次，例如在另一个标签页中流式输出的轮次。`turnOrdinal` 把这些块标记为未知，而不是赋予上一轮次的序号。导航条在这些行上仍然沿用上一轮次，与之前一致。浮层以标记了未知行的同一跟随规则读取，当阅读线位于未知轮次时不渲染任何内容。

## 何时显示

当当前轮次的提示行在视口之外时，浮层显示。只有 `msg:` 行才算提示行，因为同一轮次的 `tc:` 折叠行和输出行带有相同的来源块 ID。部分可见的提示行仍算在视口内。

## 浮层约束

这些约束来自 #15426 中为早期 `StickyPlanStrip` 列出的缺陷：

- 定位：浮层在消息列表的 `relative` 容器内使用 `position: absolute`，并且是滚动容器的同级元素。它不使用 `position: sticky`，因此滚动容器的 overflow 不会使其失效。端到端测试会测量滚动前后的位置。
- 行尺寸：它位于滚动容器之外且脱离文档流，因此不会改变行测量值、`scrollHeight`、滚动锚定或返回最新内容的控件。端到端测试会隐藏浮层，并确认 `scrollTop` 和 `scrollHeight` 不变。
- Landmark：它是普通 `div`，不增加 landmark。它不带 `aria-hidden`，因为提示行离开已挂载窗口后，浮层是 DOM 中该提示的唯一副本。提示行仍挂载时，辅助技术可能会读到两次提示，这是可以接受的。
- 历史横幅：历史加载和错误横幅占用同一个顶部居中位置。横幅显示时，浮层下移到 `top: 40px`，因此横幅不会遮住标签。浮层仍位于 `.searchAction` 和 `.navigation`（`z-index: 4`）之下。
- 输入：它设置了 `pointer-events: none`，因此滚轮、触摸、点击和选择都会落到下方的转录内容上。
- 小视口：窗口高度低于 600px 时限制为一行。在 900x480 下高度不超过 30px。

## 决策与理由

点击跳转留作后续工作，尽管有了 `viewport.selectOrdinal`，点击本身的改动很小。浮层不在滚动容器内，可点击的浮层会截获本应滚动转录内容的滚轮和触摸输入。转发这些输入已经不算小改动。

浮层是 `TranscriptViewport` 上需要显式开启的属性，由 `App.tsx` 中的主转录设置。`ChatPane` 同样传入 `hideSessionTimeline`，因此该属性无法区分 Split View 面板和全宽模式。

## 限制

- 只有轮次所在的索引页已加载时，才能知道它的序号。导航条会为自己的窗口加载页面，而隐藏的导航条不跟随阅读位置。在超过一个索引页（200 个轮次）的会话中，导航条隐藏时较旧的行可能没有标签，此时浮层不渲染任何内容。
- 容器宽度约在 760px 到 1050px 之间时，搜索按钮会盖在浮层右边缘上方。标签文字不会被遮挡。

## 验证与验收标准

- `TranscriptViewport.pinned.test.tsx` 中的单元测试覆盖标签选择、阅读线、隐藏、部分可见的提示行、折叠行、已卸载的提示行、索引未知的轮次、临时轮次、缺失标签、历史横幅、不支持的模式，以及没有该属性的面板。
- `web-shell.pinned-prompt.spec.ts` 覆盖定位、标签切换、已卸载的提示行、行尺寸、浮层上的滚轮输入、与导航条一致，以及在 900x900 下换成两行、在 900x480 下限制为一行的标签。其 `/turn-index` 模拟使用 `client/e2e/utils/turnIndexRoute.ts` 中共享的 `installTurnIndexRoute` 辅助函数。
- 现有的 `web-shell.turn-navigation-scroll-follow.spec.ts` 和 `TranscriptViewport` 单元测试仍然通过。

## 后续工作

- 点击跳转。
- 为 `legacy` 或 `degraded` 模式的会话提供标签。
- 导航条隐藏时加载当前轮次所在的索引页。
- Split View（如果窄面板确实需要）。
