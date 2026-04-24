# 闪屏治理：Issue 驱动的 PR 编排

> 目标：把闪屏优化从“围绕某个大 PR 拆补丁”改成“围绕真实用户问题逐类关闭 issue”。
> 校准时间点：2026-04-23
> 使用方式：`09-pr-3013-gap-analysis.md` 只用于参考 `#3013` 里哪些 patch 被证明有价值；真正的实施排期、PR 粒度和验证矩阵以本文档为准。

## 1. 为什么要改成 Issue 驱动

`#3013` 已经证明三件事：

1. pre-render slicing 能明显降低大工具输出的闪烁
2. stable height 能缓解详情展开时的高度抖动
3. assistant pending throttle 能降低普通流式输出的抖动

但它也同时说明了一个反面事实：

- 一条 PR 一旦同时混入 pre-slicing、stable height、synchronized output、stream throttle、resize guard、content budget，review 很难回答“到底哪一类问题被解决了”

因此，从这一版开始，闪屏治理统一遵循两个原则：

1. **PR 单位是用户可感知的问题类**
2. **每条 PR 都要有固定复现步骤、明确非目标、独立验收信号**

## 2. 证据边界

本文档只使用四类证据：

1. **当前 qwen-code 源码**
2. **真实用户 issue**
3. **Gemini CLI / Claude Code 的可借鉴实现**
4. **`#3013` 中已被证明有价值的 patch**

其中第 4 类只做交叉印证，不作为拆 PR 的主轴。

## 3. 问题类与 PR 总览

| PR | 问题类 | 代表 issue | 主要范围 | `#3013` 可借鉴内容 | 不带什么 |
| --- | --- | --- | --- | --- | --- |
| `PR-Prep` | 观测与回归基线 | 全部 | counters、回归 harness、固定复现场景 | 无需依赖 | 不改用户可见行为 |
| `PR-A1` | 动态流式闪烁 / 滚动条抖动 | `#1184` `#1491` `#3007` `#3144` | content/thought throttle、强制 flush 语义 | pending render throttle | 不带 sync output、不带 tool/detail 高度补丁 |
| `PR-A2` | 终端帧撕裂 / 残余闪烁 | `#2903` `#3144` | synchronized output、frame write 合并、runtime probe | synchronized output 原型 | 不带 `refreshStatic()` 改造、不带 narrow-shell 修复 |
| `PR-B1` | `refreshStatic()` 型整屏闪烁 | `#938` `#1861` `#2924` `#2748` | 语义拆分、resize/view switch/compact merge 触发源收紧 | `AppContainer` 中的 resize 微抖动 guard 仅作思路参考 | 不带 shell serializer、不带 sync output |
| `PR-C1` | 窄屏重复输出 / 无限滚动 | `#2912` `#2972` `#1591` `#1778` | shell serializer、live viewport vs transcript、interactive prompt 回归 | 无直接 patch，可参考 `#1778` 的历史分析但不能照抄结论 | 不带 tool budgeting、不带 detail panel |
| `PR-D1` | 大输出布局抖动 / 工具结果不可读 | `#2748` `#1479` `#2818` | plain text/ANSI pre-render slicing | `SlicingMaxSizedBox` | 不带统一 scheduler budgeting、不带 markdown 降级 |
| `PR-D2` | 通用 tool budgeting 与摘要/详情分离 | `#2818` `#1008` `#355` | scheduler budgeting、summary/detail 语义 | `MAX_TOOL_OUTPUT_LINES` 的“预算”思路 | 不带 synchronized output、不带 narrow-shell 修复 |
| `PR-E1` | 工具 / 子 agent 展开闪烁 | `#1491` `#1861` `#2424` `#2624` `#2924` | stable height、bounded detail panel、展开时钟解耦 | `useStableHeight`、content budget 思路 | 不带全局渲染模式改造、不带 shell serializer |

## 4. 推荐顺序

推荐按下面的顺序推进，而不是按某个大 PR 的 diff 顺序推进：

1. `PR-Prep`
2. `PR-A1`
3. `PR-B1`
4. `PR-D1`
5. `PR-E1`
6. `PR-C1`
7. `PR-A2`
8. `PR-D2`

排序理由：

- `PR-A1` 和 `PR-B1` 先解决主路径上最常见的“普通流式闪烁”和“整屏闪”
- `PR-D1` 先把大输出导致的 layout 风暴压下来，避免后续验证全被大工具结果噪声淹没
- `PR-E1` 单独收 subagent/tool detail 展开问题，不和 `refreshStatic()` 或大输出混在一起
- `PR-C1` 最复杂，等主屏普通链路收敛后再单独处理
- `PR-A2` 放后面，因为终端协议层 rollout 必须建立在应用层已经够稳定的前提上
- `PR-D2` 最后做，是因为它涉及 UI 语义和模型预算双重约束，产品面更广

## 5. `PR-Prep`：观测与回归基线

### 5.1 目标

建立所有闪屏修复共享的观测口径和复现场景。

### 5.2 范围

- `terminalRedrawOptimizer.ts`
- `startupProfiler.ts`
- CLI / interactive regression harness

### 5.3 必备产物

- `stdout_write_count`
- `stdout_bytes`
- `clear_terminal_count`
- `erase_lines_optimized_count`
- `bsu_frame_count`
- `esu_frame_count`
- 固定复现场景脚本或手册：
  - 长 assistant 回答
  - tool detail expand
  - resize / view switch
  - 40 列窄终端
  - interactive shell（`git commit`）

### 5.4 Done 定义

- 不改变用户可见行为
- 所有后续 PR 都能复用同一组统计项
- 至少每个问题类有一个稳定回归入口

## 6. `PR-A1`：动态流式闪烁 / 滚动条抖动

### 6.1 关闭的问题类

主路径上的普通流式闪烁：回答过程中持续抖动、滚动条轻微抽动、thought/content 高频更新导致的密集重绘。

### 6.2 主要范围

- `packages/cli/src/ui/hooks/useGeminiStream.ts`
- 如需抽 hook：`useRenderThrottledStateAndRef.ts`

### 6.3 应包含的改动

- content stream buffer + timer flush
- thought stream 共用同一 flush 模型
- 在以下场景强制 flush：
  - stream end
  - cancel
  - tool call start
  - confirm dialog render 前

### 6.4 明确不带

- synchronized output
- `refreshStatic()` 语义拆分
- tool/subagent stable height
- tool output pre-slicing

### 6.5 借鉴来源

- `#3013` 中 `pendingHistoryItem` 的 render throttle 思路
- Gemini CLI 中“缩小动态区、降低更新频率”的中层治理思路

### 6.6 固定验证场景

1. 长 assistant 回答（至少 500 token）
2. thought + content 混合流
3. 中途取消
4. split point 密集命中

### 6.7 Done 定义

- `stdout.write` 频率显著下降
- 结束和取消不丢尾部内容
- 不引入 split/promote 双重渲染

## 7. `PR-A2`：终端帧撕裂 / 残余闪烁

### 7.1 关闭的问题类

在应用层节流之后仍然存在的可见帧撕裂，尤其是 JetBrains 终端、tmux/SSH、长回答滚动阶段的“画面还在抖”问题。

### 7.2 主要范围

- synchronized output wrapper
- output frame coalescing
- runtime probe / allowlist

### 7.3 应包含的改动

- allowlist + runtime probe
- 必要时对单帧多次 `stdout.write()` 做 frame 内合并
- `bsu_frame_count === esu_frame_count` 守护
- screen reader / unknown terminal fallback

### 7.4 明确不带

- `refreshStatic()` 改造
- narrow-shell 修复
- tool budgeting

### 7.5 借鉴来源

- `#3013` 的 synchronized output 原型
- Claude Code 的 runtime gating 经验

### 7.6 固定验证场景

1. WezTerm
2. kitty
3. JetBrains 终端
4. tmux / SSH
5. Terminal.app 或未命中 allowlist 的终端

### 7.7 Done 定义

- 已支持终端的可见帧撕裂下降
- 未纳入 allowlist 的终端不出现退化
- Buffer / callback 语义不变

## 8. `PR-B1`：`refreshStatic()` 型整屏闪烁

### 8.1 关闭的问题类

`/settings` 上下切换、compact merge、active view 切换、resize 等场景的一整屏 clear + redraw。

### 8.2 主要范围

- `AppContainer.tsx`
- `MainContent.tsx`
- `DefaultAppLayout.tsx`
- 相关触发源

### 8.3 应包含的改动

- `remountStaticHistory()`
- `clearTerminalAndRemount()`
- compact merge / active view / resize 触发源改道
- `clear_terminal_count` 与 `history_remount_count` 分开统计

### 8.4 明确不带

- shell serializer 改造
- synchronized output
- stable height

### 8.5 借鉴来源

- `#3013` 里对 width micro-oscillation 的 guard，只能作为“不要过度清屏”的参考
- Gemini CLI / Claude Code 都说明“减少全屏 reset 次数”比“试图让所有 reset 不可见”更重要

### 8.6 固定验证场景

1. `/settings` 上下切换
2. compact mode merge
3. active view switch
4. 终端宽高 resize
5. `/clear`

### 8.7 Done 定义

- 非致命布局变化不再默认清屏
- `/clear` 语义保留
- `clear_terminal_count` 明显下降

## 9. `PR-C1`：窄屏重复输出 / 无限滚动

### 9.1 关闭的问题类

窄终端、多 pane tmux、interactive shell 场景下的重复打印、顶部/底部来回跳、无限滚动。

### 9.2 主要范围

- `packages/core/src/services/shellExecutionService.ts`
- `packages/core/src/utils/terminalSerializer.ts`
- interactive/integration tests

### 9.3 应包含的改动

- 固定窄屏回归场景
- 审查 `serializeTerminalToObject(headlessTerminal)` 的触发频率
- 分离：
  - live viewport
  - transcript archival
- 收紧 `onScroll()` 与 transcript 更新的耦合

### 9.4 明确不带

- tool budgeting
- detail panel
- synchronized output

### 9.5 借鉴来源

- `#1778` 的历史分析只能作为排查线索，不能直接照抄结论
- Gemini CLI / Claude Code 的滚动容器设计说明“实时 viewport”不应直接回灌主 transcript

### 9.6 固定验证场景

1. 40 列以下窄终端
2. tmux 多 pane
3. 宽度缩小后继续输出
4. `git commit`
5. interactive shell prompt / pager

### 9.7 Done 定义

- 不再重复刷旧 viewport
- 顶/底往返滚动停止
- 文档与实现中不再把 `#1778` 的 one-line fix 当作现状根因

## 10. `PR-D1`：大输出布局抖动 / 工具结果不可读

### 10.1 关闭的问题类

长工具输出导致的 Ink 全量 layout、输出一多就闪、工具结果读不全。

### 10.2 主要范围

- `ToolMessage.tsx`
- `AnsiOutput.tsx`
- shared slicing component

### 10.3 应包含的改动

- plain text pre-render slicing
- ANSI logical line slicing
- `MaxSizedBox` 退回到 safety net 角色
- 明确 hidden lines 统计规则

### 10.4 明确不带

- scheduler 层统一 budgeting
- markdown path 粗暴降级
- synchronized output

### 10.5 借鉴来源

- `#3013` 的 `SlicingMaxSizedBox`
- Gemini CLI 的 plain-text slicing 路线

### 10.6 固定验证场景

1. `npm install`
2. `git log --oneline`
3. 5000 行纯文本
4. ANSI 彩色输出

### 10.7 Done 定义

- 大工具输出不再每次 layout 全量内容
- 短输出行为不变
- hidden lines 统计可解释

## 11. `PR-D2`：通用 Tool Budgeting 与摘要/详情分离

### 11.1 关闭的问题类

只有少数工具有 budget，导致模型上下文和 UI 都被大结果拖垮；同时主 transcript 和完整详情没有明确边界。

### 11.2 主要范围

- `coreToolScheduler.ts`
- truncation / preview utils
- tool summary/detail UI 语义

### 11.3 应包含的改动

- scheduler 层统一 string budget
- 区分：
  - 模型可见预算
  - 用户界面可见预算
- main transcript 显示 summary
- detail 容器显示 full output 引用或完整结果

### 11.4 明确不带

- synchronized output
- shell serializer
- 全量虚拟滚动

### 11.5 借鉴来源

- `#3013` 中 `MAX_TOOL_OUTPUT_LINES` 的预算意识
- 现有 shell/MCP 截断路径

### 11.6 固定验证场景

1. `grep`
2. `glob`
3. `read_file`
4. `edit`
5. MCP / declarative tool 大输出

### 11.7 Done 定义

- 通用工具结果都受统一 budget 保护
- 主 transcript 更短、更稳定
- full output 仍可访问

## 12. `PR-E1`：工具 / 子 agent 展开闪烁

### 12.1 关闭的问题类

`ctrl+e` / `ctrl+f` 展开详情时高度暴涨、布局抖动、整块动态区跟着闪。

### 12.2 主要范围

- `AgentExecutionDisplay.tsx`
- `ToolMessage.tsx`
- `ToolGroupMessage.tsx`
- `useStableHeight.ts` 或等价 hook

### 12.3 应包含的改动

- stable height 吸收层
- bounded detail panel
- assistant / tool progress / subagent progress 的刷新节奏解耦
- 保留 force expand、pending confirmation、focus lock

### 12.4 明确不带

- `refreshStatic()` 清屏语义改造
- shell serializer
- global render mode overhaul

### 12.5 借鉴来源

- `#3013` 的 `useStableHeight`
- Claude Code / Gemini CLI 的滚动详情容器思路

### 12.6 固定验证场景

1. `ctrl+e`
2. `ctrl+f`
3. subagent 执行中展开
4. confirmation 出现时展开 / 收起

### 12.7 Done 定义

- 展开详情不再造成明显闪屏
- 键盘交互和 focus 语义不退化
- 不把主流式区域整体撑爆

## 13. 统一 PR 模板

每条 issue PR 都建议强制使用同一模板：

1. **Problem Class**
   - 本 PR 关闭哪一类用户问题
2. **Linked Issues**
   - 只链接与这一类问题直接相关的 issue
3. **Scope**
   - 明确文件和模块
4. **Non-goals**
   - 明确故意不带什么
5. **Reference**
   - 若借鉴 `#3013` / Gemini CLI / Claude Code，写清楚借鉴点
6. **Validation**
   - 固定复现场景
7. **Rollback**
   - 开关或失败信号

## 14. 最终建议

如果要马上开始实施，我建议第一轮就按下面三条开工：

1. `PR-Prep`
2. `PR-A1`
3. `PR-B1`

这三条做完之后，再推进 `PR-D1` 和 `PR-E1`，闪屏问题的主路径就会先被压住；此时再看 `PR-C1` 和 `PR-A2`，验证噪声也会小很多。
