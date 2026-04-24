# TUI 闪烁 / 重复输出彻底闭环方案

> 校准时间点：2026-04-24  
> 本文目标：在 `PR-1` 到 `PR-4` 的实施基础上，继续审计剩余 TUI 闪烁、重复输出、长输出不可读、工具输出抖动、窄屏滚动等 issue，给出“可以真正关闭 issue”的后续方案，并评估是否应直接拷贝 Claude Code 的魔改 Ink。

## 1. 结论先行

当前 `PR-1` 到 `PR-4` 是正确的基础层，但还不能宣称“彻底解决所有 TUI 闪烁 / 重复输出问题”。

已经基本闭环的部分：

- 普通流式输出的高频重绘被节流与观测指标覆盖
- `/clear` 已清屏路径的重复 clear 被削减
- 大型 plain text / ANSI 工具输出进入 Ink 前已经按视觉高度预裁剪
- shell viewport 比较已经覆盖默认 `showColor=false` 与 `showColor=true` 的软换行语义
- synchronized output 已按保守终端 allowlist 灰度

仍未彻底闭环的部分：

- `refreshStatic()` 仍会在 resize、view switch、settings toggle、compact merge 等“替换旧 Static 内容”的场景整屏 clear
- 工具详情、subagent 详情、长会话历史还没有统一的 bounded detail / virtual scroll 容器
- markdown-heavy 长输出仍可能让 parser、syntax highlight、React reconciliation 形成新热点
- shell 逻辑已改善，但还缺少 40 列、tmux 多 pane、`git commit` / pager、JetBrains / Windows / cmux 的自动化与手工验证闭环
- synchronized output 只是“终端协议层缓解”，不是所有终端、所有场景的兜底 renderer

对 Claude Code 魔改 Ink 的判断：

- **不建议直接拷贝 Claude Code 的 `src/ink` 实现**。本地源码目录没有发现 `LICENSE` 或 `package.json` 中的授权信息，存在明确的许可证与合规风险；技术上也与 Claude 自己的 DOM、renderer、event、selection、ScrollBox、virtual scroll、terminal probe 深度耦合。
- **可以借鉴架构，不应复制代码**。最可取路线是实现 qwen-code 自己的 `TerminalFrameRenderer`、managed screen、bounded detail surface、virtual scroll，并把 Claude 的 screen diff / synchronized output / ScrollBox 作为设计参考。
- 如果目标是真正关闭剩余 issue，必须接受一个工程事实：**vanilla Ink `<Static>` + main-screen scrollback 模式无法同时做到“历史可替换、无清屏、完整 scrollback 语义、低 layout 成本”。** 要彻底解决，需要把“当前可见 viewport”从终端 scrollback 中剥离出来，由 qwen-code 自己管理。

## 2. 当前 PR1-4 的真实边界

| PR | 已覆盖 | 仍未覆盖 | 不能宣称关闭的 issue 口径 |
| --- | --- | --- | --- |
| `PR-1` 主屏闪烁基础修复 | counters、stream throttle、`/clear` 重复 clear 削减 | resize / view switch / settings / compact merge 的替换型 `refreshStatic()` 仍会整屏 clear | `#938`、`#2378`、`#1861`、`#2924`、`#2748` 不能完全关闭 |
| `PR-2` 大输出与详情稳定性 | plain text / ANSI 结果进入 Ink 前按视觉高度预裁剪，覆盖超长单行 | 还不是统一 detail panel；markdown-heavy parser / highlighter 仍可能高峰；subagent 详情仍缺 virtual surface | `#1479` 可部分缓解；`#2424`、`#1861`、`#2924` 还不能完全关闭 |
| `PR-3` 窄屏 shell viewport | `showColor=false` 与 `showColor=true` 都按逻辑软换行比较，最终 transcript 与 live viewport 语义更一致 | 缺少完整 E2E 验证矩阵；interactive shell / pager / tmux / resize 的运行时表现还需实测 | `#2912`、`#2972`、`#1591`、`#1778` 需要验证后才能关闭 |
| `PR-4` synchronized output | WezTerm / iTerm2 / kitty 默认启用，tmux / SSH / JetBrains 保守关闭 | 不等于 frame diff renderer；不覆盖所有终端；microtask burst 合并不是完整 frame ownership | `#2903`、`#3330`、`#3144` 只能作为缓解，不应自动关闭 |

## 3. 当前 issue 重新分类

使用 `gh issue view/list` 在 2026-04-24 复核后，和 TUI 闪烁 / 重复输出 / 交互体验直接相关的问题如下。

| 分类 | Issue | 当前状态 | 用户症状 | 当前 PR 覆盖度 | 彻底关闭所需能力 |
| --- | --- | --- | --- | --- | --- |
| 普通流式闪烁 | `#1184`、`#1491`、`#3007` | open | 回答时频闪、界面 flickering | `PR-1` + `PR-4` 覆盖主路径 | frame write 指标、终端矩阵、无超屏动态区 |
| Windows / 窗口抖动 / 输入区重复 | `#2378` | open | Windows 上窗口抖动、输入区重复 | 当前 PR 只能间接缓解 | Windows ConPTY 验证、managed viewport、输入区稳定高度 |
| settings / view switch 清屏 | `#938` | open | `/settings` 上下切换必闪 | `PR-1` 只减少重复 clear | 移除替换型 `refreshStatic()` 清屏 |
| subagent / detail 展开闪烁 | `#1861`、`#2924` | open | `ctrl+e` / `ctrl+f` 展开时闪烁 | `PR-2` 只处理部分 tool result 大输出 | bounded detail panel、focus mode、稳定高度 |
| subagent 完整输出可读性 | `#2424` | open | 希望查看完整 Tasks / subagent 输出 | 当前 PR 未完整实现 | raw output artifact、scrollable detail、search/copy |
| 长回答 / 长会话不可读 | `#1479`、`#2748` | open | WebStorm 终端读不全、生成时无法回看 | `PR-2` 只防止大 tool output layout 风暴 | virtualized transcript、sticky-to-bottom、copy/scroll mode |
| 工具输出预算 | `#2818` | open | 需要通用 tool result budgeting | 不在 4 PR 主线内 | core-level summary/detail budget |
| 窄屏重复 / 无限滚动 | `#2912`、`#2972`、`#1591`、`#1778` | open | 窄屏重复输出、`git commit` 时上下滚动 | `PR-3` 覆盖核心 serializer | 40 列/tmux/pager E2E + bounded shell surface |
| JetBrains / cmux / 终端特异闪屏 | `#2903`、`#3330`、`#3144` | `#2903` open，`#3330` duplicate closed，`#3144` closed | JetBrains、cmux、agent streaming 闪烁 | `PR-4` 只覆盖 allowlist 终端 | runtime probe、denylist、manual matrix、fallback |
| 非 TUI 根因但需防回归 | `#2121`、`#1008`、`#355` | closed | 重复 tool call / 输出截断 | 不是当前 TUI renderer 根因 | 作为回归 fixture，不作为 flicker closure 主轴 |

## 4. 根因分层

### 4.1 L1：动态区高频重绘

这是 Ink 动态区域的基本问题：React state 高频更新时，Ink 会擦除旧动态区再写入新内容。`PR-1` 的 throttle 与 counters、`PR-4` 的 synchronized output 能降低症状。

剩余风险：

- 如果动态区高度超过终端高度，仍会触发明显闪烁
- 如果 markdown parser / highlighter 每帧重新处理大块内容，节流只能延后不能消除峰值

彻底方案：

- 流式内容必须有稳定前缀提升到 immutable history
- pending tail 必须限制在可见高度以内
- markdown 应按 block/token 缓存，不应每帧全量解析

### 4.2 L2：`refreshStatic()` 替换型整屏 clear

这是当前最大未闭环根因。`packages/cli/src/ui/AppContainer.tsx` 仍保留：

```tsx
const refreshStatic = useCallback(() => {
  stdout.write(ansiEscapes.clearTerminal);
  remountStaticHistory();
}, [remountStaticHistory, stdout]);
```

同时 `MainContent.tsx` 已明确说明 Ink `<Static>` 是 append-only，因此 compact merge 等“旧 history item 内容变化”场景只能 clear 后 remount。

关键判断：

- 这不是一个能靠“把 clear 删掉”修复的问题
- 不 clear 会产生重复历史、旧 view 残留、scrollback 污染
- 要彻底修复，必须引入 qwen-code 自管的可替换可见区域

### 4.3 L3：工具 / detail / subagent 无边界

`PR-2` 解决了 plain text / ANSI 进入 Ink 前的视觉高度预裁剪，但 detail 展开仍不是完整的 bounded surface 体系。

彻底方案必须做到：

- 主 transcript 只显示摘要与稳定高度 preview
- `ctrl+e` / `ctrl+f` 进入固定高度 detail panel 或 fullscreen detail view
- detail 内部可以滚动、搜索、复制，但不会改变主 transcript 高度
- subagent 的实时输出与最终 transcript 分离，避免每个子任务进度都驱动主布局重排

### 4.4 L4：窄屏 shell viewport 与 transcript 语义

`PR-3` 已经把默认 `showColor=false` 与 `showColor=true` 的 soft-wrap 比较补上，这是正确方向。剩余问题不再是“缺一行 unwrap”，而是验证和交互边界：

- 40 列以下的视觉行重排
- tmux 多 pane 宽度变化
- `git commit`、pager、交互 prompt 会改变 cursor / alternate screen 语义
- live viewport 应只服务 UI，transcript 应只服务上下文与历史

彻底方案：

- shell 输出进入 `ShellViewportController`
- UI 只接收 bounded viewport diff
- transcript 由 serializer 生成稳定文本，不反向驱动 live viewport
- E2E 以 `git commit`、`less`、`npm install`、彩色 diff、resize 为固定 fixture

### 4.5 L5：终端协议与 frame ownership

`PR-4` 的 synchronized output 是必要缓解，但不是完整 renderer。

彻底方案必须增加：

- frame-level write ownership：同一 React/Ink frame 的多次 stdout write 合并成单个 terminal transaction
- terminal runtime probe：不要只靠 `TERM_PROGRAM`
- tmux / SSH / JetBrains / Windows ConPTY 的 denylist 与 opt-in
- BSU/ESU 平衡计数、writes/frame、bytes/frame 指标

### 4.6 L6：长会话 scrollback 与 virtual scroll

`#1479` 和 `#2748` 的用户诉求不是“少闪一点”，而是“生成时仍能阅读历史、长输出可回看、不会被终端滚动带走”。

这要求从“终端 scrollback 是 UI 状态”转向“qwen-code 管理 transcript viewport”：

- 可见区域由 UI 状态决定
- terminal scrollback 不再作为唯一阅读能力
- 用户进入 scroll/copy mode 后，新内容不强制抢回底部
- 回到底部后恢复 sticky streaming

## 5. 后续闭环实施包

为了避免再拆成过多小 PR，建议把剩余工作收敛为两个大型但边界清楚的 closure PR，再加一个验证矩阵 PR。它们不是替代 `PR-1` 到 `PR-4`，而是在其基础上完成 issue 关闭口径。

### Closure-A：Managed viewport + Static replacement

目标 issue：

- `#938`
- `#2378`
- `#2748` 的 view switch / startup flicker 子问题
- `#1861`、`#2924` 中由 `refreshStatic()` 触发的整屏闪烁部分

核心修改：

1. 新增 `ManagedMainScreen` 或 `HistoryViewport`，把“当前可见 transcript”从终端 scrollback 中剥离出来。
2. 把 `refreshStatic()` 拆成三种显式语义：
   - `remountStaticHistory()`：只 remount，不清屏
   - `replaceVisibleHistory()`：在 managed viewport 中局部替换
   - `resetTerminalScreen()`：只有 `/clear`、fatal reset、legacy fallback 可以整屏 clear
3. settings、view switch、compact merge 不再直接调用 `clearTerminal`。
4. legacy main-screen scrollback 模式保留 feature flag fallback，避免一次性改变所有用户体验。

关键文件：

- `packages/cli/src/ui/AppContainer.tsx`
- `packages/cli/src/ui/components/MainContent.tsx`
- `packages/cli/src/ui/layouts/DefaultAppLayout.tsx`
- `packages/cli/src/ui/components/SettingsDialog.tsx`
- 新增 `packages/cli/src/ui/rendering/ManagedMainScreen.tsx`
- 新增 `packages/cli/src/ui/rendering/StaticReplacementController.ts`

验收：

- `/settings` 上下移动 30 秒，`clearTerminalCount === 0`
- terminal resize 20 次，不能出现旧 view 残留或重复 history
- compact mode toggle 不重复打印历史
- Windows Terminal / PowerShell / JetBrains terminal 至少各手工验证一次
- screen reader layout 继续走原有安全路径，不被 managed viewport 破坏

副作用风险：

- 改变主屏 scrollback 语义。必须提供 legacy fallback 与迁移说明
- 如果 managed viewport 一次渲染过多 history，会把 `<Static>` 性能优势吃掉。因此必须和 virtual scroll 配合

### Closure-B：Bounded detail + virtualized long output

目标 issue：

- `#1479`
- `#2424`
- `#2818`
- `#1861`
- `#2924`
- `#2748` 的长输出与生成时回看子问题

核心修改：

1. 建立统一 `ToolOutputBudget`：
   - `summary`：给主 transcript
   - `preview`：固定高度、固定宽度、可稳定 diff
   - `detailRef`：完整原文或 artifact 引用
   - `llmContent`：进入模型上下文的预算版本
2. 主 transcript 不直接展开完整 tool result / subagent result。
3. `ctrl+e` / `ctrl+f` 打开 bounded detail panel：
   - 高度固定为 terminal rows 的比例
   - 内容内部滚动
   - search/copy mode 不驱动主 transcript 重排
4. Markdown 渲染升级为 block/token 缓存：
   - stable prefix 不重复 parse
   - streaming incomplete block 只重算尾部
   - syntax highlight 异步预热或下一帧增强，不阻塞当前帧
5. subagent 输出分层：
   - live progress：短摘要
   - detail stream：bounded panel
   - final transcript：稳定摘要 + detailRef

关键文件：

- `packages/cli/src/ui/components/messages/ToolMessage.tsx`
- `packages/cli/src/ui/components/messages/ToolGroupMessage.tsx`
- `packages/cli/src/ui/components/subagents/runtime/AgentExecutionDisplay.tsx`
- `packages/cli/src/ui/components/AnsiOutput.tsx`
- `packages/cli/src/ui/components/MarkdownDisplay.tsx`
- `packages/cli/src/ui/hooks/useGeminiStream.ts`
- 新增 `packages/cli/src/ui/components/shared/BoundedOutputPanel.tsx`
- 新增 `packages/cli/src/ui/rendering/VirtualScrollBox.tsx`
- core 侧新增 tool result budget / artifact metadata

验收：

- 5000 行 stdout、10MB 单行 JSON、base64/minified log 不触发 full layout storm
- markdown-heavy response 生成 2 分钟，UI 可继续输入、可进入 detail、无明显闪屏
- `ctrl+e` / `ctrl+f` 展开 subagent 详情不改变主 transcript 高度
- 生成过程中向上滚动不会被新 token 强行拉到底部；回到底部后恢复 sticky
- 完整输出仍可复制或打开，不因 UI 预算丢失

副作用风险：

- tool result summary 与 `llmContent` 不能混淆。UI 预算不能改变模型收到的必要信息
- 搜索/复制必须能访问完整 detailRef，否则用户会认为“输出被吞”

### Closure-C：Shell E2E + terminal frame renderer

目标 issue：

- `#2912`
- `#2972`
- `#1591`
- `#1778`
- `#2903`
- `#3330`
- `#3144`

核心修改：

1. 在 `PR-3` 的 serializer 基础上补 E2E：
   - 40 列 / 24 行
   - tmux 5 pane
   - `git commit`
   - `less` / pager
   - ANSI 彩色 diff
   - resize reflow
2. 新增 `TerminalFrameRenderer`：
   - 收集同一 frame 的 stdout writes
   - 合并后统一输出
   - 可选 BSU/ESU 包裹
   - 记录 writes/frame、bytes/frame、BSU/ESU 平衡
3. runtime probe 替代单纯 env allowlist：
   - WezTerm / iTerm2 / kitty 默认启用
   - tmux / SSH / JetBrains / Windows 默认保守，允许 opt-in
   - 探测失败必须自动回退 legacy output
4. 对 cmux / JetBrains 建立“已知不默认启用”的说明与验证矩阵。

关键文件：

- `packages/core/src/services/shellExecutionService.ts`
- `packages/core/src/utils/terminalSerializer.ts`
- `packages/cli/src/ui/utils/synchronizedOutput.ts`
- `packages/cli/src/ui/utils/terminalRedrawOptimizer.ts`
- `packages/cli/src/gemini.tsx`
- 新增 `packages/cli/src/ui/rendering/TerminalFrameRenderer.ts`
- integration 或 interactive test harness

验收：

- `#2912` fixture：小于 40 列时不重复输出
- `#2972` fixture：context > 30% 后触发 `git commit` 不再上下无限滚动
- tmux 5 pane 下 2 分钟 streaming 无重复旧 viewport
- JetBrains terminal 不因误启 BSU/ESU 退化；若未启用同步输出，文档和指标应明确仍走 fallback
- `#3330` cmux 场景至少完成手工视频对比

副作用风险：

- stdout monkeypatch 必须保留 callback / backpressure 语义
- frame 合并不能吞掉非 string / Buffer 写入
- terminal probe 不能在不支持查询的终端阻塞启动

## 6. Claude Code 魔改 Ink 迁移评估

### 6.1 Claude Code 源码事实

本地 Claude Code 源码中，TUI 底层不是普通 Ink patch，而是一整套自定义渲染栈：

- `src/ink/screen.ts`：typed-array screen buffer、char/style pool、damage region、cell diff
- `src/ink/log-update.ts`：diff 到 terminal patch 的输出层
- `src/ink/terminal.ts`：synchronized output、terminal capability、diff patch 写出
- `src/ink/render-node-to-output.ts`：prevScreen blit、scroll hint、DECSTBM 相关优化
- `src/ink/components/ScrollBox.tsx`：DOM node 持有 `scrollTop`，滚动绕开 React 高频 state
- `src/hooks/useVirtualScroll.ts`：height cache、overscan、resize freeze、quantized snapshot、sticky bottom

这套系统的收益很大，但它的收益来自“从 React tree 到 terminal write 的完整 ownership”，不是某个单文件补丁。

### 6.2 直接复制的可行性

| 维度 | 评估 |
| --- | --- |
| 法务 / 许可证 | 本地 `claude-code` 目录未发现 `LICENSE` 或 `package.json` 授权字段。未经明确授权不应复制实现代码 |
| 技术适配 | 低。Claude Ink 与自己的 DOM、renderer、layout、event、selection、ScrollBox、terminal probe 深度耦合 |
| 迁移规模 | 极高。不是复制 `screen.ts` 即可，需要连带 renderer、output、event、focus、input、terminal、virtual scroll |
| 对 qwen issue 的覆盖 | 不完整。它能改善底层闪烁，但不能自动解决 qwen 的 `refreshStatic()` 语义、tool budgeting、subagent detail、shell transcript 语义 |
| 可维护性 | 低。会形成一个无法自然跟随 upstream Ink，也无法自然跟随 Claude 内部演进的第三套 fork |
| 回滚风险 | 高。底层 renderer 一旦出问题，会影响所有交互路径、TTY、screen reader、Windows、CI snapshot |

结论：**不建议直接拷贝 Claude Code 的魔改 Ink。**

### 6.3 推荐迁移方式

推荐只迁移“设计原则”，不迁移“代码文本”：

1. 先在 qwen-code 内实现 `TerminalFrameRenderer`
   - 保持当前 Ink 输出字符串为输入
   - 只接管 write 合并、BSU/ESU、指标、fallback
   - 不立即替换 React / Ink renderer
2. 再实现 qwen-owned managed screen
   - 只覆盖主 session viewport 与 detail panel
   - 不一次性替换所有 Ink component
3. 最后评估是否需要 cell-level diff
   - 如果 Closure-A/B/C 后仍有大面积闪烁，再实现 qwen 自己的 screen buffer + diff
   - 这时也应新写实现，而不是复制 Claude 代码

### 6.4 什么时候才值得 fork Ink

只有同时满足下面条件，才建议进入 Ink fork / renderer rewrite：

- Closure-A 已证明 vanilla `<Static>` 无法满足 managed viewport
- Closure-B 已证明 virtualized content 仍被 Ink output 层拖累
- Closure-C 的 frame renderer + synchronized output 无法覆盖主要终端
- 已有自动化 capture harness 可以比较 frame output
- 已明确 license / ownership / maintenance 责任
- 可以接受一个 4-6 周以上的 renderer hardening 周期

否则，直接 fork Ink 会把问题从“几个用户可见 issue”扩大成“所有 TUI 路径都要重新证明正确”。

## 7. Issue 关闭口径

| Issue | 关闭前必须通过的验收 |
| --- | --- |
| `#1184`、`#1491`、`#3007` | 普通长回答 2 分钟无明显频闪；writes/sec、eraseLines、clearTerminal 指标下降；终端矩阵覆盖 |
| `#2378` | Windows Terminal / PowerShell / cmd 至少验证正常聊天、输入区、resize、agent streaming；输入区不重复 |
| `#938` | `/settings` 上下移动与切换选项不调用 `clearTerminal`，无整屏闪 |
| `#1861`、`#2924` | `ctrl+e` / `ctrl+f` 展开 subagent 详情高度稳定，焦点不丢，主 transcript 不重排 |
| `#2424` | subagent 完整输出可进入 detail view 阅读、搜索、复制；主屏只显示摘要 |
| `#1479` | WebStorm / JetBrains 终端长回答可回看，生成中不会抢滚动到底部 |
| `#2748` | 启动、view switch、长输出、生成中回看四个子问题分别验收，不用一个 PR 笼统关闭 |
| `#2818` | tool result 有统一 summary/detail/llmContent 预算，完整原文可取回 |
| `#2912` | 40 列以下重复输出 fixture 通过，resize reflow 不重复旧 viewport |
| `#2972` | context > 30% + `git commit` / pager 场景不再上下无限滚动 |
| `#1591`、`#1778` | message duplication 与窄屏渲染说明中的复现场景均有 regression |
| `#2903` | JetBrains terminal 明确通过或明确 fallback，不因误启 terminal protocol 退化 |
| `#3330`、`#3144` | cmux / agent streaming 场景以视频或 frame log 对比确认无重复词、无明显闪烁 |

## 8. 多轮无方向 review 结论

### Review 1：源码边界

结论：`PR-2` 与 `PR-3` 已补上此前最危险的两个 P1 缺口：超长单行 visual slicing、默认 shell `showColor=false` soft-wrap comparison。当前最大风险不在这两处，而在未改造的 `refreshStatic()`、detail surface 和 terminal matrix。

### Review 2：issue 覆盖

结论：搜索结果新增了两个必须纳入口径的信号：

- `#2378`：Windows 上窗口抖动与输入区重复，不能只用 macOS / tmux 证明修复
- `#3330`：cmux 中 agent streaming 闪烁和重复词，虽然已作为 duplicate closed，但应纳入 `#3144` / terminal matrix 的验证样本

`#2121`、`#1008`、`#355` 当前已关闭，不能继续作为“open flicker issue”描述；但它们适合作为 tool output / duplicate execution 的回归 fixture。

### Review 3：Claude 迁移

结论：Claude Code 的优势是完整 renderer ownership，而不是某段可复制补丁。直接复制会带来 license、耦合、维护、回滚四类高风险，并且不能自动解决 qwen-code 的应用层问题。

### Review 4：副作用

结论：彻底闭环必然触及主屏 scrollback 语义。最安全策略是 feature flag + legacy fallback + 明确指标，而不是在现有 `<Static>` 架构下继续尝试删除 `clearTerminal`。

## 9. 推荐下一步

1. 继续完成并合并 `PR-1` 到 `PR-4`，但 PR 描述中不要宣称已彻底关闭所有 flicker issue。
2. 以 `Closure-A` 开始移除替换型 `refreshStatic()` 清屏，这是当前最核心的剩余根因。
3. 紧接着实施 `Closure-B`，把 tool/detail/subagent/long response 统一纳入 bounded + virtualized surface。
4. 最后实施 `Closure-C`，把窄屏 shell、terminal protocol、JetBrains、Windows、cmux 验证闭环。
5. 暂不复制 Claude Ink。只有在 Closure-A/B/C 后仍证明 Ink output 层无法满足目标时，才启动 qwen-owned renderer rewrite。
