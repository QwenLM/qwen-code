# Web Shell 全局轮次导航：滚动跟随当前轮次

[English](web-shell-turn-navigation-scroll-follow.md) | [简体中文](web-shell-turn-navigation-scroll-follow.zh-CN.md)

状态：提议中
日期：2026-09-14
相关：[web-shell-global-turn-navigation.md](web-shell-global-turn-navigation.md)（其 Phase 3 将 scroll-following selection 列为可选后续项）

## 问题

当 daemon 声明 `session_turn_navigation` 能力时，由 daemon 驱动的全局轮次导航（`GlobalTurnNavigation`）取代了消息列表内嵌的会话时间轴。内嵌时间轴会实时高亮阅读位置所在的轮次；而全局时间轴只高亮最近一次点击的刻度，因为 turn-navigation store 里的 `selected` 仅由 `locateOrdinal` 写入。切换之后，滚动 transcript 不再带动时间轴高亮——这是日常阅读流中的体验回归，而不是代码缺陷。

## 现状

- `GlobalTurnNavigation` 为冻结活跃链上的每个轮次渲染刻度（虚拟化，16 px 行高），并用 `sessionTimelineButtonCurrent` 样式标记 `state.selected?.ordinal`；除此之外没有任何路径写入 `selected`。
- `MessageList` 中的内嵌 `SessionTimeline` 在每个滚动帧（rAF 节流）根据 transcript 视口计算 `{startIndex, endIndex, currentIndex}` 区间，弱化显示区间内刻度（`sessionTimelineButtonInRange`），高亮当前刻度（`sessionTimelineButtonCurrent`、`aria-current`），并在当前项变化时让轨条自动居中。
- 两版时间轴共享 `MessageList.module.css` 中的刻度样式。

## 目标

- 滚动 transcript（实时视图或历史视图）时，时间轴高亮阅读线（视口顶部往下三分之一处）上方最近行所属的轮次——使标记在滚动两端能到达第一轮和最后一轮——并把可见行跨越的轮次标记为 in-range，与内嵌时间轴行为一致。
- 高亮轮次离开轨条可视窗口时，轨条仅贴边滚动到刚好可见（不再居中），向上阅读时标记可以一直走到轨条顶部边缘，在实时尾部则停在下边缘。
- `aria-current` 跟随同一个有效当前轮次。

## 非目标

- 不改 daemon 协议、turn-index store 或历史页表：滚动跟随完全从现有 snapshot 派生。
- 不改点击跳转行为（`locateOrdinal`）、键盘导航和 tooltip。
- 不给轨条视口加渐变遮罩：全局轨条使用边到边的绝对定位虚拟行，遮罩会淡化边缘刻度的点击区域。轨条保留 #11208 的 360 px 紧凑高度上限。
- 内嵌时间轴（legacy 兜底）保持不变。

## 方案

`TranscriptViewport` 根据 DOM 与导航 snapshot 计算跟随区间，以 `follow?: { start: number; end: number; current: number }` 传给 `GlobalTurnNavigation`。

行到序号的映射：反转 snapshot 的 `locations` 映射（`turnId → blockId`），再由 index page 得到 `turnId → ordinal`；provisional 轮次映射为 `totalTurns + index`。每个已渲染 transcript 行带有 `data-source-block-ids`；行的序号取其 block id 中最小的已映射序号。块未映射的行（助手输出、工具卡片）自上而下继承上一个已映射行的序号；位于首个已映射行之前的行属于其前一个轮次（`first - 1`，下限为 0）。这与内嵌时间轴把当前 turn id 传播到同一轮次各行的做法一致。

跟随区间在以下时机重算：

- transcript 滚动时（rAF 节流；恢复阅读锚点或定位跳转期间跳过，恢复循环结束时补算一次），
- `messages`、view key 或序号映射变化后的布局阶段（流式增长、历史页载入、视图切换），
- transcript 滚动容器尺寸变化时（浮动面板、窗口调整），经容器上的 `ResizeObserver` 触发。

轨条在宽度阈值以下隐藏时，跟随重算与 `follow` prop 同时关闭：无盒模型元素会丢弃 `scrollTop` 写入，未被绘制的轨条不允许被重开窗。

`GlobalTurnNavigation` 计算有效当前序号：点击选择仍在加载时取 `selected?.ordinal`，否则取 `follow?.current ?? selected?.ordinal`。选中刻度还会丢弃过时的跟随区间，让被点序号在整个跳转期间持有标记；跳转落地后由阅读线接管。当前刻度沿用现有 `sessionTimelineButtonCurrent` 样式并接管 `aria-current`。落在 `follow.start..end` 内的序号额外附加 `sessionTimelineButtonInRange`（及 `data-in-current-range`），与内嵌时间轴完全一致。仅当当前刻度离开可视窗口时，布局副作用才让轨条视口贴边滚动到刚好可见，因此用户浏览轨条本身永远不会被争抢。

覆盖能力是自愈的：滚动到深处历史时，若某轮的 index page 尚未加载，行到序号的映射会出现空洞，高亮只是暂时停住；轨条现有的缺页加载器会为可见刻度拉取 index page，回填 `locations` 后跟随即恢复。

## 约束

- 序号映射只在 snapshot 发布（事件驱动）时重建，绝不在滚动帧内重建；滚动处理器只遍历已渲染的行。
- jsdom 单测必须能在无布局条件下驱动映射，因此行到序号的推导放在纯函数里。

## 风险

- 块 id 跨轮次边界的行会解析到较早的轮次；视觉误差最多一个刻度。
- 点击选择进行期间，高亮显示被点击的刻度而非阅读位置；这是有意的点击反馈，跳转落地后即一致。由于跳转会把目标行居中，短于视口三分之一的目标行会让阅读线落在其上方，阅读线接管后标记可能停在前一轮；把落地行对齐到阅读线是可选的后续项。

## 验证计划

- 单测：纯函数覆盖行映射（直接映射、继承、首个之前、边界钳制）；`GlobalTurnNavigation` 渲染跟随当前项/in-range/aria-current，并在点击选择加载期间保持其可见。
- E2E（mock daemon，开启 turn navigation 能力）：滚动实时 transcript 时轨条高亮移动；点击远处刻度仍正常跳转且高亮落到该刻度；滚动历史页时保持跟随。

## 验收标准

- 任一视图中滚动 transcript 都会实时移动轨条高亮，且轨条只把当前刻度保持在窗口内而不对其居中。
- 点击刻度有即时高亮反馈，现有跳转行为不变。
- legacy 内嵌时间轴路径渲染的 DOM 与之前逐字节一致。

## 待解问题

无。
