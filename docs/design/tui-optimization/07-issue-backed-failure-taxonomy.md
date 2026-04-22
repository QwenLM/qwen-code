# TUI 问题分类：基于源码与 Issues 的故障画像

> 本文档把 qwen-code 当前 TUI 问题按“真实用户反馈 -> 当前源码证据 -> Gemini CLI / Claude Code 对照 -> 可执行修复方案”串成一张可实施地图。  
> 校准时间点：2026-04-22。GitHub issue 状态、PR 状态、上游源码实现若后续变更，需要重新核对。

## 1. 方法与事实边界

本文件只混合三类证据，并且明确区分置信度：

1. **当前 qwen-code 源码已确认**
   - `packages/cli/src/ui/AppContainer.tsx`
   - `packages/cli/src/ui/components/MainContent.tsx`
   - `packages/cli/src/ui/components/messages/ToolMessage.tsx`
   - `packages/cli/src/ui/components/subagents/runtime/AgentExecutionDisplay.tsx`
   - `packages/core/src/services/shellExecutionService.ts`
   - `packages/core/src/utils/terminalSerializer.ts`
2. **竞品源码可直接借鉴**
   - Gemini CLI：`ScrollableList`、`VirtualizedList`、`ToolResultDisplay`、`SlicingMaxSizedBox`、`useFlickerDetector()`
   - Claude Code：`writeDiffToTerminal()`、`ScrollBox`、`useVirtualScroll()`、`StreamingMarkdown`
3. **GitHub issue 用户症状与维护者归因**
   - 仅作为症状证据或历史信号
   - 除非能被当前源码再次印证，否则不直接当作现状根因

**特别提醒**：`qwen-code#1778` 评论中“`serializeTerminalToObject()` 因默认 `scrollOffset=viewportY` 导致重复输出”的说法，不能直接当作当前源码事实。当前本地源码里 `scrollOffset` 默认值已经是 `0`。因此这条结论只能当作**历史信号**，不能直接写成今天的根因。

## 2. 总体分类

| 类别 | 典型症状 | 代表 issue | 当前结论 | 优先级 |
| --- | --- | --- | --- | --- |
| A. 动态区重绘闪烁 | 流式输出时闪屏、滚动条抖动、tmux/SSH 下更明显 | #1184 #1491 #2748 #3007 #3144 #2903 | 已确认是 Ink `eraseLines` 路径 + 高频更新共同放大 | P0 |
| B. `refreshStatic()` 整屏闪烁 | resize、compact merge、切 view、展开子 agent 时整屏清空 | #938 #1491 #1861 #2924 #2748 | 已确认是应用层 `clearTerminal` 路径，不应混同于 Ink 自身重绘 | P0 |
| C. 窄屏重复输出 / 无限滚动 | 窄终端、多 pane tmux、上下反复滚动、内容重复打印 | #2912 #2972 #1591 #1778 | 症状确认，根因是复合问题；历史 one-line fix 不能直接套用 | P0 |
| D. 大输出不可读 / 长会话不可滚动 | 长回答读不全、工具输出占满屏幕、上下文过快膨胀 | #1479 #2748 #2818 #1008 #355 | 已确认主问题是“先渲染全量，再裁剪”和缺少统一预算 | P0 |
| E. 工具 / 子 agent 详情展开闪烁 | `ctrl+e` / `ctrl+f` 展开时闪烁、布局跳动、聚焦困难 | #1491 #1861 #2424 #2624 #2924 | 已确认与高度抖动、详情区无边界、实时更新耦合在一起 | P1 |

## 3. 分类 A：动态区重绘闪烁

### 3.1 用户反馈

- `#3144`：流式输出或 agent 执行时，滚动条每秒 10-30 次上下跳动
- `#2748`：启动和视图切换时可见闪烁
- `#1184`、`#1491`、`#3007`：通用“界面频闪”
- `#2903`：JetBrains 终端环境中闪屏

### 3.2 当前源码证据

已确认的事实：

1. qwen-code 仍依赖 Ink 的动态区重绘模型
2. `packages/cli/src/ui/utils/terminalRedrawOptimizer.ts` 的存在，本身就说明当前输出层仍在围绕 `eraseLines` 路径做补丁式缓解
3. `packages/cli/src/ui/hooks/useGeminiStream.ts` 中 content/thought 流会持续更新 pending item，只是通过 `findLastSafeSplitPoint()` 将部分稳定内容提前挪进 history
4. shell 输出虽然已有 `OUTPUT_UPDATE_INTERVAL_MS = 1000` 节流，但 LLM 内容流和 thought 流仍没有统一的低频 flush 模型

### 3.3 Gemini CLI / Claude Code 对照

- **Gemini CLI**
  - 有 `useFlickerDetector()`，把“render 高度超屏”当成事件记录
  - 用 `findLastSafeSplitPoint()` 缩小动态区
  - 在 alternate/fullscreen 路径把长输出放进 `ScrollableList`
- **Claude Code**
  - `writeDiffToTerminal()` 先拼完整 buffer，再单次 `stdout.write()`
  - 对同步输出有明确 runtime gating
  - 接受某些场景必须 full reset，而不是假装所有帧都能优雅 diff

### 3.4 可执行修复方案

**P0.1 观测先行**

- 增加 `stdout_write_count`
- 增加 `stdout_bytes`
- 增加 `erase_lines_optimized_count`
- 增加 `clear_terminal_count`
- 增加 `flicker_frame_count`

**P0.2 流式更新节流**

- content stream 统一缓冲到 50-80ms flush
- thought stream 走同一套 flush 机制
- tool call 开始、confirm prompt 展示、stream end/cancel 前强制 flush

**P0.3 同步输出与单帧 write 合并**

- 默认只在 allowlist + runtime probe 成功时启用 DECSET 2026
- 如果当前每帧有多次 `stdout.write()`，先做帧内合并，再包 BSU/ESU
- tmux / SSH 嵌套默认保守关闭

**P1.4 长期路线**

- 若 Phase 1 无法覆盖足够多场景，再评估 cursor-home/diff 路径
- DECSTBM 继续保持在 Phase 3，不提前承诺

### 3.5 验收

- 同一长回答下 `stdout.write` 次数显著下降
- WezTerm / kitty / iTerm2 中可见闪烁下降
- tmux / SSH 未被默认开启的场景不出现行为退化

## 4. 分类 B：`refreshStatic()` 整屏闪烁

### 4.1 用户反馈

- `#1861`、`#2924`：展开 subagent 详情时闪烁
- `#1491`：处理过程中按 `Ctrl-E` / `Ctrl-F` 闪烁
- `#2748`：启动与切 view 闪烁
- `#938`：设置页上下切换闪烁

### 4.2 当前源码证据

这里已经是**确认根因**，不是猜测：

1. `packages/cli/src/ui/AppContainer.tsx` 的 `refreshStatic()` 直接执行 `stdout.write(ansiEscapes.clearTerminal)`
2. `packages/cli/src/ui/components/MainContent.tsx` 在 compact mode 合并 tool group 时，会因为 `<Static>` 不能替换旧内容而主动 `refreshStatic()`
3. `packages/cli/src/ui/layouts/DefaultAppLayout.tsx` 的注释已明确 `refreshStatic` 语义是“清屏 + remount history”

### 4.3 Gemini CLI / Claude Code 对照

- Gemini CLI 也有 `refreshStatic()` / `clearTerminal`，说明这是主屏模式的已知弱点
- Claude Code 的核心经验不是“永不清屏”，而是把可局部刷新的内容放在自管滚动区里，减少全局无效

### 4.4 可执行修复方案

**P0.1 拆分 API 语义**

当前 `refreshStatic()` 同时承担了两件事：

- 清空主屏
- 强制 `<Static>` 重新挂载

应拆成两个动作：

- `remountStaticHistory()`：只让静态区重新计算
- `clearTerminalAndRemount()`：仅保留给 `/clear`、明确的全屏重置场景

**P0.2 main-screen 不再默认用 `clearTerminal` 处理非致命变化**

优先改掉这些路径：

- compact merge
- settings / active view 切换
- 宽度稳定但内容结构变化不大的局部刷新

**P1.3 用有边界的详情面板替代“整块高度暴涨”**

- subagent 详情
- 长工具结果
- 长 diff

都应优先进入 bounded scroll container，而不是直接撑大主动态区。

### 4.5 验收

- `clear_terminal_count` 显著下降
- resize、compact toggle、subagent expand 不再默认整屏清空
- `/clear` 仍保持当前语义

## 5. 分类 C：窄屏重复输出 / 无限滚动

### 5.1 用户反馈

- `#2912`：终端窗口小于一定宽度或高度会重复输出文字
- `#2972`：context 超过一定比例后遇到 `git commit` 交互，屏幕在顶部/底部之间来回滚
- `#1591`：message duplication
- `#1778`：历史上对重复输出链路做了概念分析

### 5.2 当前源码证据

当前能确认的事实只有这些：

1. `packages/core/src/services/shellExecutionService.ts` 在彩色 shell 路径里，每次 render 都会调用 `serializeTerminalToObject(headlessTerminal)`，重新序列化**当前可见 viewport**
2. `headlessTerminal.onScroll()` 会触发 `render()`
3. 当前 `serializeTerminalToObject()` 默认 `scrollOffset = 0`，说明“遗漏 scrollOffset 参数”已经不是当前源码层面的直接结论
4. 当前比较逻辑使用 `JSON.stringify(output) !== JSON.stringify(finalOutput)`，这意味着窄屏重换行、viewport 变化、滚动事件都可能导致完整 viewport 被视为“整块新内容”

因此，这一类问题目前最准确的说法是：

- **症状确认**
- **当前存在明显高风险路径**
- **但不能把历史 issue 评论里的 one-line fix 直接当成今天的唯一根因**

### 5.3 Gemini CLI / Claude Code 对照

- Gemini CLI 在 alternate/fullscreen 路径会把 ANSI 长输出放入 `ScrollableList` / `VirtualizedList`，不把整个可见 viewport 每次都塞回主 transcript
- Claude Code 把滚动和 mounted range 绑定到 `ScrollBox` / `useVirtualScroll()`，高频滚动不走 React 全量 state

### 5.4 可执行修复方案

**P0.1 先补专门回归场景**

至少新增这些自动化/半自动化用例：

- 40 列以下窄终端
- tmux 5-pane 等效宽度
- 宽度缩小后继续流式输出
- shell 进入 `git commit` / pager / interactive prompt

**P0.2 分离“实时 viewport”与“归档到 transcript 的内容”**

当前彩色 shell 路径更接近“持续重发当前屏幕状态”，而不是“只追加稳定输出”。应把这两者拆开：

- 实时 viewport：只给嵌入 shell / bounded detail panel
- transcript 归档：低频快照或稳定块提交

**P1.3 main-screen 保守策略**

在 main-screen 中：

- 只显示尾部 N 行
- 旧内容进入摘要或折叠块
- 避免把窄屏换行后的完整 viewport 持续回灌到主历史流

### 5.5 验收

- 40 列和 tmux 多 pane 不再复现重复打印
- `git commit`、interactive prompt、滚动回放时不再出现顶部/底部来回跳
- 历史 issue `#1778` 的假设不会再被文档误写成现状根因

## 6. 分类 D：大输出不可读 / 长会话不可滚动

### 6.1 用户反馈

- `#1479`：长回答在 WebStorm 终端中读不全
- `#2748` 评论：生成中无法一边继续输出一边向上滚动查看历史
- `#2818`：只有 shell/MCP 有截断，其他工具没有统一预算
- `#1008`：现有字数/行数截断阈值需要更系统的 golden range
- `#355`：早期 shell 输出被截断且排版错乱

### 6.2 当前源码证据

1. `packages/cli/src/ui/components/messages/ToolMessage.tsx` 的 plain text 路径把原始字符串先交给 React/Ink，再由 `MaxSizedBox` 做视觉裁剪
2. 长工具结果在 `availableHeight` 存在时会强制关闭 markdown 路径，说明当前 markdown 渲染无法稳定服从高度约束
3. `packages/cli/src/ui/components/MainContent.tsx` 仍然是 `<Static>` + pending 主路径，没有独立的长会话滚动容器
4. `compact mode` 可以隐藏工具输出，但它是 coarse-grained 的会话模式，不等于细粒度的预算与滚动策略

### 6.3 Gemini CLI / Claude Code 对照

- Gemini CLI 已经在 `ToolResultDisplay` 中为普通模式使用 `SlicingMaxSizedBox`，先做**字符/行切片，再交给 `MaxSizedBox`**
- Claude Code 则进一步把长会话放进 `ScrollBox` / `useVirtualScroll()` 体系

### 6.4 当前维护者方向信号

`qwen-code#2748` 的维护者评论指向 PR `#3013`。截至 **2026-04-22**：

- `#3013` 仍是 **OPEN**
- reviewDecision 为 **CHANGES_REQUESTED**
- PR 内部已经把问题拆成三阶段：
  1. `SlicingMaxSizedBox`
  2. `useStableHeight`
  3. `MAX_TOOL_OUTPUT_LINES`

这说明维护方向已经与本文件基本一致，但 review 也暴露了两个关键约束：

1. 不能为了防闪烁直接移除 markdown 呈现
2. 预切片之后，hidden lines 统计和软换行仍需严谨处理

### 6.5 可执行修复方案

**P0.1 预裁剪优先于视觉裁剪**

- string/plain text 工具输出：引入 `SlicingMaxSizedBox`
- ANSI 输出：同样在进入 React 树前先做 logical line slice
- 避免 “500 行 -> Ink layout 500 行 -> 只显示 15 行”

**P0.2 通用 tool budgeting**

在 scheduler 层统一接入 `truncateToolOutput()`：

- shell / MCP / grep / glob / read_file / edit / declarative tools 一视同仁
- 将“模型可见预算”和“用户界面可见预算”区分开

**P1.3 为长详情建立单独容器**

- main transcript 只放摘要
- 详细输出放进 bounded scroll container、alternate panel 或 fullscreen detail view
- 支持“生成中继续向上滚动查看历史”

### 6.6 验收

- 大工具输出不会让 Ink 每次重排全部内容
- Markdown-heavy 工具结果仍能保持可读格式
- 生成中可以滚动回看
- 上下文增长速度因统一预算而下降

## 7. 分类 E：工具 / 子 agent 详情展开闪烁

### 7.1 用户反馈

- `#1491`、`#1861`、`#2924`：展开 subagent 时闪烁
- `#2424`：希望看到完整 task/subagent 输出，而不只是工具调用日志
- `#2624`：希望工具输出默认折叠并可展开

### 7.2 当前源码证据

1. `packages/cli/src/ui/components/subagents/runtime/AgentExecutionDisplay.tsx` 的 `compact / default / verbose` 模式会显著改变可见高度
2. 同一组件同时承载：
   - task prompt
   - tool call list
   - pending confirmation
   - 执行总结
3. `ToolMessage.tsx` 和 `AgentExecutionDisplay.tsx` 的更新节奏与主消息流耦合，展开细节时容易把动态区整体撑大

### 7.3 Gemini CLI / Claude Code 对照

- Gemini CLI 倾向于把长工具结果放入专门滚动容器
- Claude Code 把长内容滚动和高频输入从 React state 中抽离

### 7.4 可执行修复方案

**P1.1 稳定高度**

- 为 tool/subagent 详情加 `useStableHeight` 一类的吸收层
- 小幅高度波动不立即改变可见行数

**P1.2 详情区边界化**

- `ctrl+e` / `ctrl+f` 不再直接把主流式区域整体撑大
- 使用 bounded panel、modal、alternate/fullscreen details 之一

**P1.3 更新时钟解耦**

- assistant 文本流
- tool progress
- subagent detail

使用不同节流频率，避免“每个 progress tick 都引发整个详情树抖动”。

### 7.5 验收

- `ctrl+e` / `ctrl+f` 不再导致整屏闪烁
- pending confirmation / focus lock 不退化
- 工具输出默认折叠与 force expand 规则共存

## 8. 推荐实施顺序

1. **P0**
   - 观测与 issue-backed 回归样例
   - content/thought 节流
   - `refreshStatic()` 语义拆分
   - 预裁剪大工具输出
   - 窄屏/interactive shell 回归 harness
2. **P1**
   - stable height
   - bounded detail panel
   - 通用 tool budgeting
   - main-screen 与 alternate/fullscreen 的渲染分层
3. **P2**
   - 虚拟滚动
   - output diff / cursor-home
   - 更深的终端协议/scroll region 优化

## 9. 三轮无方向自审结论

### Pass 1：事实核对

- 已把 `#1778` 的 one-line fix 降级为历史信号
- 已把 `refreshStatic()` 与 Ink `eraseLines` 明确拆开
- 已把 `#3013` 标注为 2026-04-22 时仍未合入

### Pass 2：边界条件核对

- 不再把 tmux 中的 synchronized output 写成默认安全
- 不把预切片误写成 markdown / ANSI / diff 的通解
- 不把“折叠 UI 输出”误写成“模型上下文预算已解决”

### Pass 3：实施可执行性核对

- 每一类问题都给出可落地的 P0/P1 修复动作
- 每一类都带了验收条件
- 与 `02-screen-flickering.md`、`03-rendering-extensibility.md`、`06-implementation-rollout-checklist.md` 的职责不冲突
