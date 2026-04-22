# TUI 优化执行计划与测试矩阵

> 本文档把 `00-09` 的设计与调研进一步压缩成“可以直接排期和拆任务”的执行稿。
> 校准时间点：2026-04-22。若 issue / PR / 上游源码继续变化，需要重新核对后再执行。

## 1. 目标

本执行稿只覆盖当前最值得落地的两层：

1. **P0：先止血**
   - 动态区闪烁
   - `refreshStatic()` 整屏闪烁
   - 大工具输出导致的高 layout 成本
   - 窄屏 / interactive shell 回归缺失
2. **P1：把主风险点结构化**
   - bounded detail panel
   - 通用 tool budgeting
   - main-screen / alternate-fullscreen 分层
   - 长会话滚动的前置基础

不在本阶段承诺：

- 自研 diff renderer
- DECSTBM scroll region
- 全量虚拟滚动切换
- parser 全量替换上线

## 2. 任务切片总览

| Slice | 目标 | 主要文件 | 风险 | 建议周期 |
| --- | --- | --- | --- | --- |
| S1 | 建立可观测性 | `terminalRedrawOptimizer.ts`, `startupProfiler.ts` | 低 | 1-2 天 |
| S2 | 降低内容流重绘频率 | `useGeminiStream.ts` | 低 | 1-2 天 |
| S3 | 拆分 `refreshStatic()` 语义 | `AppContainer.tsx`, `MainContent.tsx`, `DefaultAppLayout.tsx` | 中 | 2-3 天 |
| S4 | 大工具输出 pre-render slicing | `ToolMessage.tsx`, `AnsiOutput.tsx`, shared slicing component | 中 | 2-4 天 |
| S5 | 通用 tool budgeting | `coreToolScheduler.ts`, truncation util 相关路径 | 中 | 2-3 天 |
| S6 | 窄屏 / interactive shell 专项回归与修复 | `shellExecutionService.ts`, `terminalSerializer.ts`, CLI tests | 中高 | 3-5 天 |
| S7 | bounded detail panel + stable height | tool/subagent 相关组件 | 中高 | 3-5 天 |

### 2A. 与 `#3013` 的对应关系

为了方便把 `#3013` 拆成若干小 PR，建议把这些 slice 和真正的 PR 切分对应起来：

| Slice | 对应 PR | 说明 |
| --- | --- | --- |
| S1 | PR-0 | 观测基线，不直接来自 `#3013`，但建议所有后续 PR 先依赖它 |
| S2 | PR-2 | assistant pending render throttle |
| S3 | PR-5 | `refreshStatic()` 语义拆分，是 `#3013` 外的关键补漏 |
| S4 | PR-1 | 大 plain-text 工具输出 pre-slicing |
| S5 | 后续独立 PR | 不在 `#3013` 当前 patch 中，建议后移 |
| S6 | PR-6 | 窄屏 / interactive shell 专项，不建议混入主 UI patch |
| S7 | PR-3 | tool/subagent stable height 与 content budget |

而 `PR-4` synchronized output 灰度接入横跨 S1 之后的输出层验证与 rollout，不单独落在某一个 slice 上，需结合 [10-pr-3013-split-plan.md](./10-pr-3013-split-plan.md) 的约束执行。

## 3. Slice S1：建立可观测性

### 3.1 目标

在不改变产品行为的前提下，拿到后续所有优化都要依赖的指标。

### 3.2 文件落点

- `packages/cli/src/ui/utils/terminalRedrawOptimizer.ts`
- `packages/cli/src/utils/startupProfiler.ts`
- 如需 UI 展示或 debug dump，可补充：
  - `packages/cli/src/gemini.tsx`
  - `packages/cli/src/ui/AppContainer.tsx`

### 3.3 具体任务

1. 为输出层增加 counters
   - `stdout_write_count`
   - `stdout_bytes`
   - `clear_terminal_count`
   - `erase_lines_optimized_count`
   - `bsu_frame_count`
   - `esu_frame_count`
2. 为启动链路增加 checkpoint
   - `first_paint`
   - `input_enabled`
   - `config_initialize_start`
   - `config_initialize_end`
   - `gemini_tools_updated`
3. 明确 profile 输出是否运行在 sandbox child process

### 3.4 测试与验收

- 单测：
  - `packages/cli/src/ui/utils/terminalRedrawOptimizer.test.ts`
  - profiler 相关测试若已有则补齐；若没有至少补 smoke test
- 验收：
  - 指标开启前后不改变可见行为
  - `bsu_frame_count === esu_frame_count`
  - screen reader 路径不被误安装

## 4. Slice S2：流式内容节流

### 4.1 目标

把 content / thought 流从“几乎每个 chunk 都重绘”变成“稳定低频 flush + 关键节点即时刷新”。

### 4.2 文件落点

- `packages/cli/src/ui/hooks/useGeminiStream.ts`

### 4.3 具体任务

1. 为 content stream 增加 buffer + timer
2. 为 thought stream 使用同一 flush 模型
3. 这些场景必须强制 flush：
   - stream end
   - user cancel
   - tool call start
   - confirm dialog render 前
4. 保持现有 `findLastSafeSplitPoint()` 逻辑继续工作

### 4.4 测试与验收

- 单测：
  - `packages/cli/src/ui/hooks/useGeminiStream.test.ts`
- 验收：
  - flush 间隔内 UI 不丢内容
  - 取消与结束时不会遗漏尾部 chunk
  - thought 与 content 不会互相覆盖 pending item

## 5. Slice S3：拆分 `refreshStatic()` 语义

### 5.1 目标

把“静态区 remount”和“整屏 clear + remount”彻底拆开，避免大量非致命变化也整屏闪。

### 5.2 文件落点

- `packages/cli/src/ui/AppContainer.tsx`
- `packages/cli/src/ui/components/MainContent.tsx`
- `packages/cli/src/ui/layouts/DefaultAppLayout.tsx`
- 可能波及：
  - `packages/cli/src/ui/components/SettingsDialog.tsx`
  - `/clear` 所在命令处理路径

### 5.3 具体任务

1. 引入两个明确动作
   - `remountStaticHistory()`
   - `clearTerminalAndRemount()`
2. 检查当前触发源并逐个改道
   - compact merge
   - settings toggle
   - active view switch
   - resize
   - manual clear
3. resize 策略收紧
   - 高度变化默认不整屏 clear
   - 宽度变化仅在必须重排历史时升级为清屏

### 5.4 测试与验收

- 单测：
  - `packages/cli/src/ui/components/MainContent.test.tsx` 若无则建议补
  - `packages/cli/src/ui/AppContainer.test.tsx`
- 验收：
  - `clear_terminal_count` 显著下降
  - `/clear` 仍保留旧语义
  - compact merge 不再默认整屏闪

## 6. Slice S4：大工具输出 pre-render slicing

### 6.1 目标

避免大工具输出在进入 React/Ink 树之后才被裁剪。

### 6.2 文件落点

- `packages/cli/src/ui/components/messages/ToolMessage.tsx`
- `packages/cli/src/ui/components/AnsiOutput.tsx`
- 新增共享组件建议：
  - `packages/cli/src/ui/components/shared/SlicingMaxSizedBox.tsx`

### 6.3 具体任务

1. plain text 工具输出先做字符保护与 logical line slice
2. ANSI 输出进入 React 树前先按 logical line slice
3. `MaxSizedBox` 降级成 width limiter + safety net
4. 保留 markdown 路径，不允许因防闪烁直接退化成纯文本

### 6.4 关键约束

- 不得把 pre-slice hidden line 和 soft-wrap hidden line 双重计数
- alternate/fullscreen 模式下默认不应强裁为主屏摘要语义
- diff 输出单独维持自己的高度策略

### 6.5 测试与验收

- 单测：
  - `packages/cli/src/ui/components/messages/ToolMessage.test.tsx`
  - `packages/cli/src/ui/components/shared/MaxSizedBox.test.tsx`
  - 新增 `SlicingMaxSizedBox.test.tsx`
- 场景：
  - `npm install`
  - `git log`
  - 5000 行纯文本
  - markdown-heavy 工具结果

## 7. Slice S5：通用 tool budgeting

### 7.1 目标

把当前零散分布的 tool output 截断整合成统一入口，区分“模型预算”和“UI 预算”。

### 7.2 文件落点

- `packages/core/src/core/coreToolScheduler.ts`
- `packages/core/src/utils/truncation.ts`
- 已有 shell / MCP 截断接入点

### 7.3 具体任务

1. 在 scheduler 层统一检查 string `llmContent`
2. 超阈值时：
   - 保存完整结果
   - 返回 head/tail preview
   - 附 full output 引用
3. 保持已有 shell / MCP 截断逻辑可兼容通过

### 7.4 测试与验收

- 单测：
  - `packages/core` 下 scheduler / truncation 相关测试
- 验收：
  - `grep` / `glob` / `read_file` / `edit` 都受统一 budget 保护
  - 非字符串结果不受误伤

## 8. Slice S6：窄屏 / interactive shell 专项

### 8.1 目标

把当前最危险但根因仍复合的窄屏问题先“可复现、可回归、可收敛”。

### 8.2 文件落点

- `packages/core/src/services/shellExecutionService.ts`
- `packages/core/src/utils/terminalSerializer.ts`
- interactive / integration tests

### 8.3 具体任务

1. 增加专门回归场景
   - <= 40 列窄终端
   - tmux 多 pane 等效宽度
   - interactive shell（如 `git commit`）
   - 宽度缩小后继续输出
2. 审查当前彩色 shell 路径
   - `serializeTerminalToObject(headlessTerminal)` 的更新频率
   - `headlessTerminal.onScroll()` 与 render 的耦合
   - `JSON.stringify` 整块比较的副作用
3. 先把 live viewport 和 transcript archival 语义区分开

### 8.4 测试与验收

- 优先使用 integration / interactive tests
- 验收：
  - 窄屏不再重复刷旧行
  - interactive prompt 不再顶/底来回跳
  - 文档中不再把 `#1778` 的历史猜测误写成现状根因

## 9. Slice S7：bounded detail panel + stable height

### 9.1 目标

解决 `ctrl+e` / `ctrl+f` 展开 subagent/tool 详情时的高度暴涨和整屏闪烁。

### 9.2 文件落点

- `packages/cli/src/ui/components/subagents/runtime/AgentExecutionDisplay.tsx`
- `packages/cli/src/ui/components/messages/ToolMessage.tsx`
- `packages/cli/src/ui/components/messages/ToolGroupMessage.tsx`
- 如采用 hook：
  - `packages/cli/src/ui/hooks/useStableHeight.ts`

### 9.3 具体任务

1. 对 detail 区采用稳定高度吸收
2. 将 `compact/default/verbose` 展开从“撑大主流式区”改成“进入有边界的 detail 容器”
3. assistant content / tool progress / subagent progress 用不同刷新节奏
4. 保留 force-expand、pending confirmation、focus lock 语义

### 9.4 测试与验收

- 单测：
  - `AgentExecutionDisplay.test.tsx`
  - `ToolGroupMessage.test.tsx`
- 验收：
  - `ctrl+e` / `ctrl+f` 不再导致整屏闪烁
  - confirmation / keyboard focus 行为不退化

## 10. 建议的提交顺序

建议不要把这些 slice 混成一个超大 PR。更稳的顺序是：

1. PR-0：S1 观测
2. PR-1：S4 大工具输出 pre-slicing
3. PR-2：S2 assistant pending render throttle
4. PR-3：S7 bounded detail panel / stable height
5. PR-5：S3 `refreshStatic()` 语义拆分
6. PR-4：synchronized output 灰度接入
7. PR-6：S6 窄屏专项
8. 通用 tool budgeting 另开独立 PR

这样做的好处是：

- 每个 PR 都有独立收益
- 回滚粒度更小
- 便于把 issue 与 PR 一一对应

## 11. 代码审查重点

每个 slice 提交前，review 重点建议固定看这些：

1. **是否把历史猜测写成当前事实**
2. **是否把主屏语义和 fullscreen/alternate 语义混淆**
3. **是否为了性能牺牲了 markdown / confirmation / focus 等产品语义**
4. **是否只优化了冷启动，却漏掉运行期路径**
5. **是否新增了无法回退的高风险逻辑**

## 12. 最终退出标准

当下面这些都满足时，才可以说这套 TUI 优化进入“可默认开启”的阶段：

- main-screen 流式输出可见闪烁明显下降
- `refreshStatic()` 不再成为高频整屏闪烁源
- 大工具输出不会再让 Ink 每次 layout 全量内容
- 窄屏与 interactive shell 有稳定回归样例
- `ctrl+e` / `ctrl+f` 展开不再造成明显闪屏
- tool budgeting 同时保护模型上下文和 UI 渲染
