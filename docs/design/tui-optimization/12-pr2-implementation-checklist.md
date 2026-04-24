# `PR-2` 实操清单：大输出与详情展开稳定性

> 本文档把 [10-issue-oriented-flicker-plan.md](./10-issue-oriented-flicker-plan.md) 里的 `PR-2` 落成可以直接照着做的执行清单。`PR-2` 必须建立在 `PR-1` 的真实落点之上：复用 redraw counters 和 stream throttle，不继续扩大 `refreshStatic()` 语义改造。

## 1. 目标

`PR-2` 只解决“大输出 / 详情展开导致 layout 风暴、闪烁和不可读”的 UI surface 问题：

1. 大型 plain text / ANSI 工具输出不再先进入 React/Ink 全量 layout 后才视觉裁剪。
2. 工具 / 子 agent 详情展开时可见高度有边界，不把主动态区整体撑到剧烈跳动。
3. hidden lines / bytes 的提示可解释，用户知道哪些内容被折叠。

## 2. 与 `PR-1` 的连续性

- 继续使用 `PR-1` 的 `getTerminalRedrawStatsSnapshot()` / `clearTerminalCount` / `stdoutWriteCount` 作为观测口径。
- 不修改 `useGeminiStream` 的 60ms content/thought throttle，避免把普通 assistant streaming 与大输出 surface 混在一起。
- 不改 compact merge、active view switch、resize 的 `refreshStatic()` 触发源；这些属于后续 static replacement / renderer 架构问题。
- `PR-2` 的收益应主要来自减少 React/Ink 需要 layout 的大节点数量，而不是靠终端协议隐藏中间帧。

## 3. 非目标

以下内容不在 `PR-2` 中实现：

- synchronized output / DECSET 2026
- 窄屏 / interactive shell serializer 修复
- `refreshStatic()` 主链架构性改造
- core 层 `llmContent` / 模型可见预算语义变更
- Markdown parser / token cache 重构
- 全量虚拟滚动或 fullscreen detail view

## 4. 文件边界

### 4.1 预计会修改的文件

- `packages/cli/src/ui/components/messages/ToolMessage.tsx`
- `packages/cli/src/ui/components/messages/ToolMessage.test.tsx`
- `packages/cli/src/ui/components/AnsiOutput.tsx`
- `packages/cli/src/ui/components/AnsiOutput.test.tsx`
- `packages/cli/src/ui/components/shared/MaxSizedBox.tsx`
- `packages/cli/src/ui/components/shared/MaxSizedBox.test.tsx`

### 4.2 可能波及的文件

- `packages/cli/src/ui/components/messages/ToolGroupMessage.tsx`
- `packages/cli/src/ui/components/subagents/runtime/AgentExecutionDisplay.tsx`
- `packages/cli/src/ui/components/subagents/runtime/AgentExecutionDisplay.test.tsx`
- `packages/cli/src/ui/utils/CodeColorizer.tsx`

## 5. 建议实现顺序

### Step 1：plain text pre-slicing

先为 `StringResultRenderer` 增加逻辑行预裁剪：

- 仅在 `availableHeight` 存在时启用。
- 默认保留尾部内容，和现有 `MaxSizedBox` 的 `overflowDirection="top"` 行为一致。
- 将被裁掉的逻辑行数传给 `MaxSizedBox.additionalHiddenLinesCount`。
- `MaxSizedBox` 仍作为 safety net 处理 wrapping 后的残余 overflow。

验收点：

- 5000 行 plain text 进入 React 树前只保留和可见高度相关的尾部窗口。
- output 中仍出现 `... first N lines hidden ...`。
- 非 shell 工具、shell completed string 路径都不丢最后几行。

### Step 2：ANSI output hidden count 对齐

检查 `AnsiOutputText` 当前 `data.slice(-height)` 路径：

- 如果 `AnsiOutputDisplay.totalLines` 存在，`ShellStatsBar` 已能显示 hidden lines。
- 如果没有 stats，考虑给 `AnsiOutputText` 增加 `additionalHiddenLinesCount` 或在调用侧补 stats。
- 不改变 ANSI token 的颜色、inverse、dim、underline 等样式语义。

验收点：

- 5000 行 ANSI 输出不会把全量 token rows 交给 `MaxSizedBox`。
- hidden lines 统计与 visible height 一致。

### Step 3：详情展开稳定性

在不做 fullscreen / virtual scroll 的前提下，先收住高度抖动：

- `ToolGroupMessage` 给单个 tool 的 `availableTerminalHeightPerToolMessage` 保持稳定下限。
- `AgentExecutionDisplay` 的 compact/default/verbose 切换不应让 pending confirmation 丢焦点。
- `ctrl+e` / `ctrl+f` 的展开路径应有测试覆盖。

验收点：

- 展开详情不会导致主区域一次性 layout 巨量工具输出。
- pending confirmation / force expand / focus lock 规则保持原语义。

## 6. 最小推荐实现

`PR-2` 的第一版可以只做 Step 1，并补齐测试后提交。这是当前风险最低、和 `PR-1` 延续最自然的切片：

- 影响面小：只碰工具结果 string 渲染路径。
- 可验证：大 plain text fixture 能稳定断言 hidden line banner 和尾部内容。
- 不会抢占 `PR-3` / `PR-4` 的职责。

Step 2 / Step 3 如果源码审计确认改动范围变大，应拆到同一 PR 的后续 commit 或单独 follow-up，不要为了“一次做完 PR-2”引入无关行为变更。

## 7. 测试清单

优先运行：

```bash
cd packages/cli
npx vitest run src/ui/components/messages/ToolMessage.test.tsx
npx vitest run src/ui/components/AnsiOutput.test.tsx
npx vitest run src/ui/components/shared/MaxSizedBox.test.tsx
```

如果触及子 agent 展开：

```bash
cd packages/cli
npx vitest run src/ui/components/messages/ToolGroupMessage.test.tsx
```

提交前再跑：

```bash
npm run typecheck --workspace=packages/cli
npm run lint --workspace=packages/cli
git diff --check
```

## 8. issue 归属提醒

`PR-2` 可以声称解决或显著缓解：

- `#1479`
- `#2424`
- `#2624`
- `#1491` / `#1861` / `#2924` 的详情展开子问题

`#2818` `#1008` `#355` 属于 tool budgeting / 上下文预算 follow-up，不应在 `PR-2` 中声明关闭。

## 9. Review 重点

- 是否有任何路径把 markdown-heavy 输出直接降级成不可读纯文本。
- hidden lines 数量是否与实际预裁剪方向一致。
- shell focused / `forceShowResult` 是否仍能显示用户需要的输出窗口。
- 是否把 `MaxSizedBox` 从 safety net 误改成唯一裁剪层。

