# PR #3013 闪屏补漏分析

> 分析对象：[`QwenLM/qwen-code#3013`](https://github.com/QwenLM/qwen-code/pull/3013)  
> 校准时间点：2026-04-22  
> 目标：回答三个问题
>
> 1. 这条 PR 已经修掉了哪些闪屏问题
> 2. 它还没覆盖哪些根因
> 3. 如果继续做，最合理的拆分方案是什么

## 1. 结论摘要

`#3013` 不是“无效 PR”，相反，它已经覆盖了**闪屏问题里最容易被用户看到的一块**：

- 大工具输出超过 15 行后，Ink 还在 layout 全量内容，导致明显闪烁
- tool/subagent 展开后，高度小幅波动反复触发重排
- pending assistant 内容高频更新导致短周期重复渲染

但它**不是完整修复**，原因也很明确：

1. 这条 PR 的核心收益集中在**大工具输出与高度抖动**
2. qwen-code 当前还有两条更底层的闪屏源没有被真正解决：
   - `refreshStatic() -> clearTerminal` 的整屏清除路径
   - 窄屏 / interactive shell 下的 viewport 序列化与重复输出问题
3. PR 自己也已经长到跨越多个主题：
   - pre-render slicing
   - stable height
   - assistant stream throttle
   - synchronized output
   - tool/subagent expand budget
   - resize micro-oscillation guard

这也是为什么作者在 **2026-04-22** 的最新评论里明确表示：**准备取消这条 PR，并拆成多条更小的 PR 来分别修复闪屏问题。**

## 2. 基于 PR 页面可确认的事实

截至 **2026-04-22**，`#3013` 的状态是：

- `OPEN`
- `CHANGES_REQUESTED`
- 最近更新时间：`2026-04-22T11:28:48Z`

而且 PR 评论里已经出现两类强信号：

1. **用户侧验证**
   - 有测试者上传了前后对比视频，指出“原版在输出超过 15 行后明显闪烁，而 PR 版本平滑很多”
2. **作者侧判断**
   - 作者确认这条 PR 已经混入过多提交和问题修复
   - 计划拆成多条 PR 分别解决各类 flicker 问题

这意味着本分析文档不应把 `#3013` 当成“一个待 merge 的完整修复”，而应把它当成：

- 一组已经被验证有价值的 patch
- 外加一组尚未收敛的风险和未覆盖范围

## 3. PR 已经修复的部分

### 3.1 大型 plain-text 工具输出的 layout 闪屏

这是 `#3013` 最扎实、也最值得保留的一部分。

从 PR diff 可以确认：

- `ToolMessage.tsx` 把 plain text 路径从 `MaxSizedBox` 切到 `SlicingMaxSizedBox`
- `SlicingMaxSizedBox` 在 React render 前就进行：
  - 字符截断
  - logical line slicing
  - 再交给 `MaxSizedBox` 作为安全网

这能直接缓解当前源码中的一个坏路径：

```text
500 行工具输出
  -> Ink 先 layout 500 行
  -> 只显示 10-15 行
  -> 每次增量更新仍然重新 layout 全量
```

这一点和 Gemini CLI 的 `SlicingMaxSizedBox` 路线是一致的，也是当前最明确能带来体感改进的 patch。

### 3.2 工具 / 子 agent 展开时的高度抖动

PR 中新增了两类高度稳定策略：

1. `useStableHeight.ts`
   - 对 streaming 中的小幅高度下降进行吸收
   - 对高度上升立即接受
   - 对显著下降或超时 stale 的情况再同步
2. `AgentExecutionDisplay.tsx` / `ToolGroupMessage.tsx`
   - 为 subagent 展开态引入 content budget
   - 为 tool output 引入 `MIN_TOOL_OUTPUT_HEIGHT`
   - 在低高度下自动限制 verbose/default 展示量

这部分解决的不是“所有闪屏”，而是**布局高度抖动引发的那一类闪屏**。对 `#1861`、`#2924`、`#1491` 这类“展开就抖”的问题是有效方向。

### 3.3 assistant pending 内容的高频重绘

PR 在 `useGeminiStream.ts` 中引入了：

- `useRenderThrottledStateAndRef`
- 对 `pendingHistoryItem` 的约 16ms render throttle
- 在 split/promote 场景中显式 `flushPendingHistoryItem()`

这说明 `#3013` 并不只是动了 tool output，也开始碰：

- assistant 内容流
- split 到 `<Static>` 时的瞬时重复渲染

这部分是有价值的，因为它正面覆盖了“流式内容更新过快 -> Ink 帧写出过密”的问题。

### 3.4 小范围的 resize 微抖动保护

PR 在 `AppContainer.tsx` 中增加了一个保守判断：

- 对 1-3 列左右的小宽度抖动不触发 `refreshStatic()`
- 目的是避免滚动条显隐、终端微抖动造成的 `clearTerminal` 黑屏

这个 patch **对症但范围很窄**：

- 它缓解的是“微小宽度震荡触发清屏”
- 不是在解决 `refreshStatic()` 这条路径本身的架构问题

### 3.5 synchronized output 原型

PR 还加入了：

- `packages/cli/src/utils/synchronizedOutput.ts`
- `gemini.tsx` 在 Ink render 前安装 `installSynchronizedOutput()`

这表明作者也在尝试用 DECSET 2026 来降低“clear -> redraw”中间态的可见性。

不过，这一块目前更像**原型接入**，不是最终可默认上线的版本。原因放到第 4 节展开。

## 4. PR 还没修掉的部分

### 4.1 `refreshStatic()` 仍然是未解主根因

当前本地源码里，`refreshStatic()` 仍然是：

- `stdout.write(ansiEscapes.clearTerminal)`
- `setHistoryRemountKey(...)`

并且 `MainContent.tsx` 在 compact merge 时仍会主动触发 `uiActions.refreshStatic()`。

`#3013` 虽然对“宽度微抖动”加了 guard，但没有从语义上拆开：

- `仅 remount static history`
- `clear terminal + remount`

这意味着下面这些场景依然没有被真正解决：

- compact merge 触发的整屏闪
- active view 切换触发的整屏闪
- 明显宽度变化下的整屏 clear
- 任何未来继续调用 `refreshStatic()` 的路径

换句话说，PR 解决的是 `refreshStatic()` 的**一个症状分支**，不是这条问题链路本体。

### 4.2 窄屏重复输出 / 无限滚动没有被覆盖

`#2912`、`#2972` 这类问题的当前高风险路径仍然存在：

- `shellExecutionService.ts` 在彩色 shell 路径里每次 render 都重新 `serializeTerminalToObject(headlessTerminal)`
- `headlessTerminal.onScroll()` 会触发 render
- 结果比较仍然是 `JSON.stringify(output) !== JSON.stringify(finalOutput)`

`#3013` 没有改这些文件的相关逻辑：

- `packages/core/src/services/shellExecutionService.ts`
- `packages/core/src/utils/terminalSerializer.ts`

所以它对下面这些问题基本没有覆盖：

- 窄终端重复打印
- tmux 多 pane 重复输出
- `git commit` / interactive shell 顶部与底部来回跳

这一类问题仍然需要单独处理，不能把 `#3013` 视为“闪屏大盘已基本修完”。

### 4.3 Markdown-heavy 工具输出仍然没有真正削峰

review 里已经明确指出了一个关键问题：

- plain text 路径有 `SlicingMaxSizedBox`
- 但 markdown path 只有字符截断，没有 block/line 级 pre-render slicing

如果工具输出是：

- `web_fetch`
- markdown-heavy MCP result
- 默认 `isOutputMarkdown: true` 的 declarative tool

那么 `MarkdownDisplay` 仍然可能吃下一个很大的字符串，再在内部完整解析。

这意味着：

- PR 对“长纯文本工具输出”很有效
- 对“长 Markdown 工具输出”只做了部分缓解
- 这也是 reviewer 明确不接受“直接砍掉 markdown 渲染”的原因

### 4.4 synchronized output 接入还太粗

PR 的 synchronized output patch 有两个明显问题：

1. **安装粒度过大**
   - 直接在 `gemini.tsx` 里全局安装
   - 没有先用 counters 验证每帧 write 形态
2. **没有和现有输出优化层统一**
   - qwen-code 现在已有 `terminalRedrawOptimizer.ts`
   - PR 又新增一层全局 `stdout.write` 包装
   - 两层 monkeypatch 未来如何共存、谁先谁后、如何回退，没有在 PR 中彻底收口

再加上它当前仍是 env/terminal allowlist，而不是产品级 rollout：

- 没有和 screen reader / fallback 语义一起设计
- 没有和 `clearTerminal` / `eraseLines` 指标统一
- 没有和 main-screen / fullscreen / alternate 模式做分层

所以这一块更适合作为**后续小 PR 单独灰度**，不宜和 pre-slicing / stable height 混在一起。

### 4.5 PR 里还混入了临时诊断代码

从 `AppContainer.tsx` patch 可以直接看到：

- 启动时往 `stderr` 写 `[AppContainer mounted]`
- `refreshStatic()` 时无条件打印 stack

这说明 PR 当前分支里还夹着临时诊断逻辑。即使这些只是为了定位 flicker，也说明它现在还没收敛到可直接 merge 的质量状态。

### 4.6 长会话滚动与 detail panel 仍然缺位

PR 虽然做了：

- `MAX_TOOL_OUTPUT_LINES = 15`
- tool/subagent 的 content budget

但它本质还是“把主界面里的东西截短”，而不是建立一套正式的 detail 容器。

所以 `#1479`、`#2748` 评论里那类更完整的需求依然没有解决：

- 生成时继续向上滚动查看历史
- 需要时进入完整详情视图
- 长会话可读、可回看、可聚焦

这也是为什么后续路线不能停在“所有东西都裁到 15 行”。

## 5. review 暴露出的设计风险

### 5.1 不能用“牺牲 markdown”换性能

这是 reviewer 最明确的一条约束。

工具输出里有大量内容天然依赖 markdown 呈现：

- `web_fetch`
- MCP docs/search 类工具
- declarative tools

如果为了防闪而把它们都降级成纯文本，虽然帧稳定了，但产品语义会倒退。

### 5.2 hidden lines 统计要区分 logical line 与 visual wrap

`SlicingMaxSizedBox` 预切片后，如果 inner `MaxSizedBox` 又因为软换行继续裁切，就会出现：

- 逻辑行隐藏
- 视觉包裹隐藏

被一起加总的情况。这个问题不只是显示文案不准，它还会让“到底裁了多少内容”变得不可解释。

### 5.3 `useStableHeight` 适合战术补丁，不适合作为全局模式

作者自己也在评论里解释了：

- 它依赖 Ink 当前同步渲染模型
- 在 render 中读写 ref / `Date.now()`

这在当前环境下可以作为战术补丁，但不应该被写成“以后所有高度稳定问题都这么做”的通用模式。

## 6. 建议如何拆成后续 PR

结合 PR 作者 2026-04-22 的最新评论，最合理的拆法大概是：

### PR-A：大工具输出 pre-render slicing

只保留：

- `SlicingMaxSizedBox`
- `ToolMessage` plain text path
- 必要的测试

不混入：

- synchronized output
- stable height
- debug diagnostics

### PR-B：tool/subagent stable height 与 content budget

只保留：

- `useStableHeight`
- `ToolGroupMessage`
- `AgentExecutionDisplay`
- 相关测试

目标是单独验证：

- 它对 `ctrl+e` / `ctrl+f` 展开闪烁的收益
- 它对 confirmation / focus 行为的影响

### PR-C：assistant pending render throttle

只保留：

- `useRenderThrottledStateAndRef`
- `useGeminiStream` 的 throttle / flush 行为

这样可以单独看清楚：

- 对普通 assistant 流式闪烁的收益
- 是否引入 split/promote 的重复渲染副作用

### PR-D：synchronized output 灰度接入

只保留：

- `synchronizedOutput.ts`
- render 前安装逻辑
- counters / 回退开关 / 更完整测试

并且必须和现有 `terminalRedrawOptimizer.ts` 的职责统一，否则后面会变成双层 stdout monkeypatch。

### PR-E：`refreshStatic()` 语义拆分

这条不在 `#3013` 当前 patch 里，但它是补漏时最该单独开的 PR：

- `remountStaticHistory()`
- `clearTerminalAndRemount()`
- 替换 compact merge / view switch / resize 中不必要的清屏

### PR-F：窄屏 / interactive shell 专项

单独处理：

- `shellExecutionService.ts`
- `terminalSerializer.ts`
- live viewport vs transcript archival

这条是 `#3013` 完全没碰到、但用户影响很重的一类问题。

如果要看更细的“每条 PR 带哪些文件、故意不带哪些 patch、先后顺序怎么排”，请直接参考 [10-pr-3013-split-plan.md](./10-pr-3013-split-plan.md)。本文件保留拆分结论，`10` 负责执行方案。

## 7. 推荐新增的分析结论

基于当前 PR 与现有源码，我会建议团队在后续所有文档和讨论里统一使用这句话：

> `#3013` 已证明“预裁剪大工具输出 + 稳定高度”能显著缓解一部分闪屏，但它不是完整修复。  
> qwen-code 当前剩余的主风险仍包括 `refreshStatic()` 清屏链路、窄屏 / interactive shell 重复输出链路，以及 markdown-heavy 输出与长会话滚动问题。

这句话能防止两个常见误判：

1. 误以为“这条 PR 一 merge，闪屏问题基本结束”
2. 误以为“这条 PR 没有完整修复，所以里面没有可复用价值”

## 8. 落地建议

如果只选一个最值得继承的 patch，我会选：

- `SlicingMaxSizedBox` 这一类 pre-render slicing 思路

如果只选一个最值得单独继续做的小 PR，我会选：

- `refreshStatic()` 语义拆分

如果只选一个最值得新增的专项文档 / 回归矩阵，我会选：

- 窄屏 + interactive shell 的专项测试矩阵

因为从当前问题分布看：

- 大工具输出闪屏已经被 `#3013` 证明“有解”
- 但真正还会反复咬人的，是那些**不属于大工具输出**的闪屏链路

## 9. 自审结论

### Pass 1：PR 事实核对

- 已按 2026-04-22 重新核对 PR 状态
- 已纳入作者“准备拆 PR”的最新评论
- 未把评论中的计划性表述写成已落地事实

### Pass 2：与当前源码对照

- 已确认 `refreshStatic()` 主路径仍未被架构性修复
- 已确认窄屏 / shell duplication 路径相关文件未被本 PR 实质覆盖
- 已确认当前源码中大工具输出 plain text path 仍是 `MaxSizedBox` 主导

### Pass 3：补漏可执行性

- 已把补漏点整理成可拆分 PR
- 已区分“可直接继承的 patch”和“应单独灰度的 patch”
- 结论与 [07-issue-backed-failure-taxonomy.md](./07-issue-backed-failure-taxonomy.md) 和 [08-execution-plan-and-test-matrix.md](./08-execution-plan-and-test-matrix.md) 保持一致
