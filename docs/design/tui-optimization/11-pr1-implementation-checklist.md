# `PR-1` 实操清单：主屏闪烁基础修复

> 本文档把 [10-issue-oriented-flicker-plan.md](./10-issue-oriented-flicker-plan.md) 里的 `PR-1` 落成可以直接照着做的执行清单。目标是让下一步进入编码时，不需要再重新讨论 scope、文件边界和测试顺序。

## 1. 目标

`PR-1` 只做主屏主路径的基础修复，覆盖两类问题：

1. 普通 assistant 流式输出时的高频抖动
2. `refreshStatic()` 导致的整屏 clear + redraw

这条 PR 允许顺带加入观测与回归基线，因为它们与主屏主路径共用同一组验证场景。

## 2. 非目标

以下内容**不在 `PR-1` 中实现**：

- synchronized output / DECSET 2026
- 窄屏 / interactive shell 修复
- 大工具输出 pre-slicing
- stable height / bounded detail panel
- tool budgeting / `llmContent` 语义变更
- Markdown parser / token cache 重构

## 3. 文件边界

### 3.1 预计会修改的文件

- `packages/cli/src/ui/utils/terminalRedrawOptimizer.ts`
- `packages/cli/src/ui/hooks/useGeminiStream.ts`
- `packages/cli/src/ui/AppContainer.tsx`
- `packages/cli/src/ui/components/MainContent.tsx`
- `packages/cli/src/ui/layouts/DefaultAppLayout.tsx`

### 3.2 可能波及的文件

- `packages/cli/src/ui/components/SettingsDialog.tsx`
- `packages/cli/src/ui/hooks/slashCommandProcessor.ts`
- `packages/cli/src/ui/contexts/UIActionsContext.tsx`
- `packages/cli/src/ui/contexts/UIStateContext.tsx`

### 3.3 预计要补或更新的测试

- `packages/cli/src/ui/utils/terminalRedrawOptimizer.test.ts`
- `packages/cli/src/ui/hooks/useGeminiStream.test.tsx`
- `packages/cli/src/ui/AppContainer.test.tsx`
- `packages/cli/src/ui/components/SettingsDialog.test.tsx`

如果没有合适的 `MainContent` 独立测试，再决定是否新增：

- `packages/cli/src/ui/components/MainContent.test.tsx`

## 4. 建议的实现顺序

### Step 1：补最小观测能力

先在不改行为的前提下补这些 counters：

- `stdout_write_count`
- `stdout_bytes`
- `clear_terminal_count`
- `erase_lines_optimized_count`

要求：

- 不改变现有 `stdout.write()` 语义
- screen reader 路径不误装
- 先只做数据采集，不引入 DECSET 2026

### Step 2：实现 content / thought 流式节流

在 `useGeminiStream.ts` 中：

- 为 content stream 增加 buffer + timer flush
- thought stream 共用同一 flush 模型
- 在这些节点强制 flush：
  - stream end
  - cancel
  - tool call start
  - confirm dialog render 前

要求：

- 保持 `findLastSafeSplitPoint()` 逻辑继续生效
- 不引入 split/promote 双重渲染

### Step 3：拆分 `refreshStatic()` 语义

从当前单一 `refreshStatic()` 拆成：

- `remountStaticHistory()`
- `clearTerminalAndRemount()`

然后逐个清点触发源，优先改这些：

- `MainContent` 的 compact merge
- `DefaultAppLayout` 的 active view switch
- `SettingsDialog` 的局部设置切换
- `AppContainer` 的 resize 处理

要求：

- `/clear` 仍保留旧语义
- 非致命布局变化默认不清屏

### Step 4：把回归场景补齐

最少要补这 3 类测试：

1. `useGeminiStream` 的 flush / cancel / final flush
2. `refreshStatic()` 新旧语义与调用路径
3. 输出 counters 的不退化 smoke test

## 5. 建议的 commit 切分

为了让 reviewer 更容易看，建议一个 PR 里至少拆成 3 个 commit：

1. `test/obs(cli): add redraw counters and baseline assertions`
2. `fix(cli): throttle gemini stream updates on main screen`
3. `fix(cli): split refreshStatic remount from clear terminal`

如果测试改动很多，可以再单独加一个：

4. `test(cli): cover refreshStatic and stream flush regressions`

## 6. 复现与验收清单

### 6.1 固定复现场景

1. 冷启动（无 MCP）
2. 冷启动（含 1 个慢 MCP server）
3. 长 assistant 回答（至少 500 token）
4. thought + content 混合流
5. `/settings` 上下切换
6. compact mode merge
7. active view switch
8. 终端宽高 resize
9. `/clear`

### 6.2 通过标准

- `stdout.write` 频率下降
- `clear_terminal_count` 下降
- 结束 / cancel 不丢尾部内容
- resize / settings / compact merge 不再默认整屏 clear
- `/clear` 保持当前用户语义

## 7. issue 归属提醒

`PR-1` 可以声称解决或显著缓解：

- `#1184`
- `#1491`
- `#3007`
- `#938`
- `#1861`
- `#2924`

`#2748` 在这条 PR 中只应作为 **flicker 子问题样本** 引用，不建议直接在 `PR-1` 里声明完全关闭。

## 8. 提交前命令

建议按这个顺序跑：

```bash
cd /Users/gawain/Documents/codebase/opensource/qwen-code/.claude/worktrees/tui-optimization/packages/cli
npx vitest run src/ui/utils/terminalRedrawOptimizer.test.ts
npx vitest run src/ui/hooks/useGeminiStream.test.tsx
npx vitest run src/ui/AppContainer.test.tsx
npx vitest run src/ui/components/SettingsDialog.test.tsx
```

如果新增了 `MainContent` 独立测试，再补跑对应文件。

## 9. 实施后的下一步

`PR-1` 合并后，优先进入：

1. `PR-2`：大输出与详情展开稳定性
2. `PR-3`：窄屏 / interactive shell 专项

只有在 `PR-1` ~ `PR-3` 主路径收敛后，才推进 `PR-4` 的 synchronized output 灰度。
