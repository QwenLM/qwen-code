# `PR-3` 实操清单：窄屏 / interactive shell 专项

> 本文档把 [10-issue-oriented-flicker-plan.md](./10-issue-oriented-flicker-plan.md) 里的 `PR-3` 落成可以直接照着做的执行清单。`PR-3` 必须独立于 `PR-1` / `PR-2`，因为它处理的是 shell viewport 序列化和窄屏重换行问题，不是普通 React/Ink layout 问题。

## 1. 目标

`PR-3` 只解决窄终端、tmux 多 pane、interactive shell 中的重复输出 / 无限滚动：

1. 彩色 shell 输出不会在窄屏下重复刷旧 viewport。
2. interactive prompt / pager / `git commit` 不会顶底来回跳。
3. live viewport 与 transcript archival 的职责被拆开，主历史不持续回灌完整 viewport。

## 2. 与前序 PR 的连续性

- 继承 `PR-1` 的 redraw counters，用于观测是否仍有异常高频 stdout writes。
- 不修改 `PR-2` 的大输出 pre-slicing 逻辑；shell serializer 修复不应依赖 UI 层裁剪遮掩。
- 不引入 synchronized output；终端协议层留给 `PR-4`。

## 3. 非目标

- 大工具输出 pre-slicing
- bounded detail panel
- `refreshStatic()` 语义改造
- DECSET 2026 / synchronized output
- tool budgeting / `llmContent` 语义变更

## 4. 文件边界

预计会修改：

- `packages/core/src/services/shellExecutionService.ts`
- `packages/core/src/utils/terminalSerializer.ts`
- shell execution / terminal serializer 相关测试

可能波及：

- `packages/cli/src/ui/components/AnsiOutput.tsx`
- `packages/cli/src/ui/components/messages/ToolMessage.tsx`
- integration interactive fixtures

## 5. 建议实现顺序

### Step 1：复现 harness

先补失败用例，再改实现：

- <= 40 列宽度的彩色输出 fixture
- `showColor=true` + 窄屏组合
- interactive prompt fixture，例如 `git commit` / pager 等效场景
- tmux 多 pane 等效宽度，至少在 serializer 层模拟

### Step 2：拆分 live viewport 与 transcript

当前风险路径是完整 viewport 被反复序列化并作为“新输出”回灌。修复方向：

- live viewport 只用于当前交互显示。
- transcript 只追加新稳定内容。
- viewport resize / rewrap 不应被当作新 transcript。

### Step 3：比较逻辑从整块 JSON 变成增量语义

避免继续依赖：

```ts
JSON.stringify(output) !== JSON.stringify(finalOutput)
```

改成更明确的比较：

- cursor / viewport 变化只更新 live display。
- 新增稳定文本才追加 transcript。
- ANSI token 属性变化不应制造重复纯文本行。

## 6. 测试清单

优先运行 core 层单测：

```bash
cd packages/core
npx vitest run src/services/shellExecutionService.test.ts
npx vitest run src/utils/terminalSerializer.test.ts
```

如果新增 integration：

```bash
npm run build && npm run bundle
npm run test:integration:interactive:sandbox:none
```

## 7. Done 定义

- 40 列以下 shell 输出不重复打印旧 viewport。
- 宽度缩小后继续输出不会无限滚动。
- interactive prompt 保持可交互，不被 transcript 追加逻辑破坏。
- 文档和测试不再把 `#1778` 的历史 one-line fix 写成当前源码根因。

## 8. Review 重点

- 是否混入了 UI detail panel / budgeting 改动。
- 是否破坏 `showColor=false` 的普通 shell transcript。
- 是否保留用户需要的最终输出，而不是为了防重复丢掉真实新增内容。
- 是否能解释 live viewport 与 persisted transcript 的边界。

