# PR #3013 拆分计划

> 目标：把 [`QwenLM/qwen-code#3013`](https://github.com/QwenLM/qwen-code/pull/3013) 拆成若干更小、更容易验证、边界更清晰的 PR。  
> 校准时间点：2026-04-22  
> 本文档是行动计划，不重复 `09-pr-3013-gap-analysis.md` 的全部论证；若要看“为什么要拆、哪些问题仍未覆盖”，先读 [09-pr-3013-gap-analysis.md](./09-pr-3013-gap-analysis.md)。

## 1. 拆分原则

拆分时遵守四条硬规则：

1. **每个 PR 只解决一种主闪屏机制**
   - 不把“大工具输出 pre-slicing”和“synchronized output”混进一条 PR
2. **每个 PR 都有单独可复现的验证场景**
   - reviewer 不需要同时验证 5 种变化
3. **每个 PR 都有清晰非目标**
   - 明确哪些问题故意留给下一条 PR
4. **禁止带入临时诊断代码**
   - `stderr` diagnostics、一次性 debug 输出、实验性钩子不进正式 PR

## 2. 拆分总览

| PR | 类型 | 主要目标 | 关联 issue | 主要文件 | 非目标 |
| --- | --- | --- | --- | --- | --- |
| PR-0 | 前置 | 建立闪屏观测基线 | 全部 | `terminalRedrawOptimizer.ts`, profiler | 不改行为 |
| PR-1 | 从 `#3013` 拆出 | 大 plain-text 工具输出 pre-render slicing | `#2748` `#2818` | `ToolMessage.tsx`, `SlicingMaxSizedBox.tsx` | 不碰 markdown / sync output |
| PR-2 | 从 `#3013` 拆出 | assistant pending render throttle | `#1184` `#1491` `#2748` | `useGeminiStream.ts`, `useRenderThrottledStateAndRef.ts` | 不碰 tool/subagent 高度 |
| PR-3 | 从 `#3013` 拆出 | tool/subagent stable height 与 content budget | `#1491` `#1861` `#2924` | `useStableHeight.ts`, `ToolGroupMessage.tsx`, `AgentExecutionDisplay.tsx`, `AppContainer.tsx` | 不碰 sync output / narrow-shell |
| PR-4 | 从 `#3013` 拆出 | synchronized output 灰度接入 | `#3007` `#3144` `#2903` | `synchronizedOutput.ts`, `gemini.tsx` | 不碰 `refreshStatic()` 语义 |
| PR-5 | `#3013` 外补漏 | `refreshStatic()` 语义拆分 | `#938` `#1861` `#2924` | `AppContainer.tsx`, `MainContent.tsx`, `DefaultAppLayout.tsx` | 不碰 shell serializer |
| PR-6 | `#3013` 外补漏 | 窄屏 / interactive shell 重复输出专项 | `#2912` `#2972` `#1591` | `shellExecutionService.ts`, `terminalSerializer.ts` | 不碰 tool budgeting |

## 3. 推荐顺序

建议顺序不是按代码依赖排，而是按**验证难度和收益比**排：

1. PR-0 观测基线
2. PR-1 大 plain-text 工具输出 pre-slicing
3. PR-2 assistant pending render throttle
4. PR-3 tool/subagent stable height 与 content budget
5. PR-5 `refreshStatic()` 语义拆分
6. PR-4 synchronized output 灰度接入
7. PR-6 窄屏 / interactive shell 专项

这个顺序的好处是：

- 前 4 条都是主 UI 层 patch，容易快速验证
- `refreshStatic()` 语义拆分提前，能防止后续 patch 被整屏 clear 抵消
- synchronized output 放在更后面，避免两层 monkeypatch 还没观测就上线
- 窄屏 / interactive shell 最后独立推进，不把最复杂的 bug 混进常规 UI PR

## 4. PR-0：观测基线

### 4.1 为什么先做

`#3013` 里已经混入了 synchronized output、render throttle、stable height 等高风险逻辑；如果没有统一指标，后面的 review 只能靠“视频更稳了”这种主观判断。

### 4.2 范围

- `stdout_write_count`
- `stdout_bytes`
- `clear_terminal_count`
- `erase_lines_optimized_count`
- `bsu_frame_count`
- `esu_frame_count`
- `flicker_frame_count`

### 4.3 验证

- 现有行为不变
- `git diff --check` / 单测通过
- 指标可在固定场景下重复采样

## 5. PR-1：大 plain-text 工具输出 pre-render slicing

### 5.1 保留内容

- 新增 `SlicingMaxSizedBox`
- `ToolMessage.tsx` plain text path 切到 pre-slicing
- 必要的 `ToolMessage` / `SlicingMaxSizedBox` / `MaxSizedBox` 测试

### 5.2 明确不带内容

- 不带 `useStableHeight`
- 不带 synchronized output
- 不带 `useRenderThrottledStateAndRef`
- 不带 `stderr` diagnostics

### 5.3 关键 review 点

- hidden lines 统计不能双重计算
- `maxHeight` 与 `maxLines` 的职责要写清楚
- plain text path 优化后，短输出行为不能变

### 5.4 验证场景

- `npm install`
- `git log --oneline`
- 5000 行纯文本
- compact mode

## 6. PR-2：assistant pending render throttle

### 6.1 保留内容

- `useRenderThrottledStateAndRef.ts`
- `useGeminiStream.ts` 的 pending item throttle / flush

### 6.2 明确不带内容

- 不带 tool output pre-slicing
- 不带 stable height
- 不带 synchronized output

### 6.3 关键 review 点

- split/promote 到 `<Static>` 时不能出现临时重复渲染
- flush 时机要覆盖：
  - stream end
  - cancel
  - tool call start
  - confirm dialog 前

### 6.4 验证场景

- 长 assistant 回答
- thought + content 混合
- 中途取消
- split point 密集命中

## 7. PR-3：tool/subagent stable height 与 content budget

### 7.1 保留内容

- `useStableHeight.ts`
- `ToolGroupMessage.tsx`
- `AgentExecutionDisplay.tsx`
- `AppContainer.tsx` 中 raw/stable height 分离

### 7.2 明确不带内容

- 不带 synchronized output
- 不带 pre-slicing
- 不带 `refreshStatic()` 语义拆分

### 7.3 关键 review 点

- `useStableHeight` 是战术补丁，不应被包装成全局渲染模式
- raw height 必须继续传给 shell PTY
- `ctrl+e` / `ctrl+f`、confirmation、focus lock 不能退化

### 7.4 验证场景

- subagent 展开 / 收起
- 工具数从 2 -> 3 -> 1 波动
- 小终端高度
- shell 正在执行时的 layout 稳定性

## 8. PR-4：synchronized output 灰度接入

### 8.1 保留内容

- `synchronizedOutput.ts`
- `gemini.tsx` 安装逻辑
- 与 output counters 配套的 feature flag / rollback

### 8.2 明确不带内容

- 不带 pre-slicing
- 不带 stable height
- 不带 `refreshStatic()` 语义改造

### 8.3 关键 review 点

- 不能和现有 `terminalRedrawOptimizer.ts` 形成不可控的双层 monkeypatch
- 必须有 allowlist / probe / fallback
- screen reader、tmux、SSH、Buffer/callback 语义必须单独验证

### 8.4 验证场景

- WezTerm / kitty / iTerm2
- tmux / SSH
- Terminal.app / 未命中的终端
- screen reader

## 9. PR-5：`refreshStatic()` 语义拆分

### 9.1 这条为什么单独开

这不是 `#3013` 现有 patch 的一部分，但它是最关键的补漏项之一。没有它，前面任何 patch 都可能被 `clearTerminal` 一把抹掉。

### 9.2 范围

- `remountStaticHistory()`
- `clearTerminalAndRemount()`
- compact merge、view switch、resize 的触发源重定向

### 9.3 关键 review 点

- `/clear` 语义必须保留
- 高度变化默认不清屏
- 宽度变化只在必须重排历史时才升级为 clear

### 9.4 验证场景

- compact mode merge
- active view switch
- terminal resize
- `/clear`

## 10. PR-6：窄屏 / interactive shell 重复输出专项

### 10.1 这条为什么最后做

它最复杂，而且和 `#3013` 的主收益几乎不是同一类 bug。应该单独推进、单独验证，不要拖慢前面更容易落地的 patch。

### 10.2 范围

- `shellExecutionService.ts`
- `terminalSerializer.ts`
- live viewport 与 transcript archival 的职责分离

### 10.3 关键 review 点

- 不要把 `#1778` 的历史 one-line fix 直接当成当前结论
- 先把窄屏场景做成稳定回归，再改实现
- 避免“继续往主 transcript 回灌完整 viewport”

### 10.4 验证场景

- 40 列以下窄终端
- tmux 多 pane
- `git commit`
- interactive shell prompt

## 11. 每条 PR 的统一模板

为防止后续又长成一个“大杂烩 PR”，建议每条 PR 都遵守同一模板：

1. **Problem**
   - 只描述这一类闪屏机制
2. **Scope**
   - 明确涉及文件
3. **Non-goals**
   - 明确不包含哪些 patch
4. **Validation**
   - 至少 2-4 个可复现场景
5. **Rollback**
   - 开关、回退策略或失败信号

## 12. 最终建议

如果现在就要开始真正拆分 `#3013`，我建议从这三条先动：

1. **PR-1 大 plain-text 工具输出 pre-slicing**
   - 收益最直接
   - 用户体感最明显
   - 最容易用视频和基准验证
2. **PR-2 assistant pending render throttle**
   - 影响面小
   - 易于单测
   - 能立刻降低普通流式输出抖动
3. **PR-5 `refreshStatic()` 语义拆分**
   - 不是 `#3013` 现成 patch
   - 但它是所有后续闪屏修复的地基

如果把这三条先做好，再继续推进 PR-3 / PR-4 / PR-6，整个闪屏治理路线会清晰很多，也更适合 reviewer 验证。
