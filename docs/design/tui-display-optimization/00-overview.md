# TUI Display Optimization — Design Overview

> Branch: `feat/tui-display-optimization` (based on `feat/virtual-viewport-on-ink7`)
> Source proposal: `qwen-code TUI 显示优化提案.md` (ECS-side五-CLI 对比)

## 1. Scope

This PR addresses **display-only** optimisations from the proposal. It does **NOT** touch:

- Brand banner upgrade (wide/narrow Banner art)
- SubAgent brand icon **art** (we _do_ change the title structure / iconography family — see §3.4)
- Theme colours (existing semantic colours are reused)

Everything else in the proposal is in scope:

| #   | Proposal item                                                                | Section |
| --- | ---------------------------------------------------------------------------- | ------- |
| ①   | 默认隐藏思考过程 (≈ `--verbose` 时显示)                                      | §3.1    |
| ②   | 行/块/问答 间距压缩                                                          | §3.2    |
| ③   | 输入框上方留白                                                               | §3.2    |
| ④   | 工具调用去 border                                                            | §3.3    |
| ⑤   | 每 Turn 末尾 `⏱ X.Xs`                                                       | §3.5    |
| ⑥   | 表格内代码禁用语法高亮                                                       | §3.6    |
| ⑦   | SubAgent 标题 + 信息结构（Gemini-CLI 风格）                                  | §3.4    |
| ⑧   | 工具调用自动合并（视觉 CC 风格 / 算法沿用 qwen 既有）                        | §3.3    |
| ★   | **Ctrl+O 语义重写**：从全局 toggle → "冻结快照 + 详情视图"（CC 风格 toggle） | §3.7    |

`★` 是用户口头追加，提升到与 ①–⑧ 同级。

## 2. Guiding Principles

1. **Default = compact**. 用户进 qwen-code 第一眼看到的就是紧凑布局，无需手动 toggle。
2. **Ctrl+O 不再切换全局模式**。它进入一个"冻结快照详情视图"，按 Esc 退回正常。这与 Claude Code 的 `Ctrl+O → transcript screen` 行为完全对齐（已在 baseline 调研中验证 — claude-code `defaultBindings.ts:44 'ctrl+o': 'app:toggleTranscript'`, `REPL.tsx:1325-4189 frozenTranscriptState`）。
3. **`--verbose` 留作"硬性显示偏好"**。需要长期看到思考链/完整工具输出的用户可以通过 CLI flag 或 setting 永久打开。Ctrl+O **不再** 操作这个偏好。
4. **零行为回归**。所有 force-expand 条件（错误、待确认、终态子代理、用户触发）仍然在主视图中强制完整展开，不依赖 Ctrl+O。
5. **与 Virtual Viewport 共存**。VP 路径（`MainContent.tsx:551` 短路）和 Static 路径都必须支持本次所有改动；Ctrl+O 冻结视图复用 VP 的 `ScrollableList`。

## 3. Document Map

- `01-thinking-display.md` — §3.1 思考过程
- `02-spacing-and-borders.md` — §3.2 + §3.3 间距 / 边框 / 工具合并视觉
- `03-subagent-display.md` — §3.4 SubAgent 重塑
- `04-turn-elapsed.md` — §3.5 Turn 耗时
- `05-table-inline-code.md` — §3.6 表格内代码
- `06-ctrl-o-transcript.md` — §3.7 Ctrl+O 重写 + Esc 退出
- `07-verbose-and-settings.md` — `--verbose` flag、settings 迁移、向后兼容
- `08-test-plan.md` — 测试矩阵
- `09-rollout-and-risks.md` — 风险、回滚、副作用清单
- `10-review-notes-v1.md` — v1 评审记录与 v2 决策
- `11-scenario-coverage.md` — 提案附图 1/2/3/4/5/7/9/10/11/12 全部场景对照
- `12-call-site-audit.md` — `compactMode` 全部 51 个非测试调用点改造表

## 4. Decision summary（每节末尾会展开）

| 维度                  | 现状                                                                | 新方案                                                                                                                                                                       |
| --------------------- | ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `compactMode` setting | bool，default false，Ctrl+O 切换；同时控制 thought 隐藏 + tool 合并 | **retire**。换成 `ui.verbose`（default false）。"compact-style" 始终是默认显示。                                                                                             |
| `Ctrl+O`              | `TOGGLE_COMPACT_MODE`：翻转 `compactMode` + `refreshStatic()`       | `TOGGLE_TRANSCRIPT`：进入 transcript overlay，冻结当前 history snapshot，全展开渲染。Esc 退出。                                                                              |
| Tool group border     | 永远 `borderStyle="round"`（compact / full 两路都有）               | **去 border**。视觉用 `⏺` 前缀 + 缩进 + `⎿` 子项分隔。仅"确认中"和"错误"保留警示色（无 border，靠状态符号 + 颜色提示）。                                                    |
| Tool merging          | 仅 `compactMode=true` 时合并                                        | **始终合并** —— 等价于"始终走 compact 路径"。`--verbose` 时不合并。                                                                                                          |
| Thinking (`✦ …`)      | `compactMode=false` 时显示                                          | 默认隐藏；显示前缀指示 `✻ Thinking…`（CC 风格）。`--verbose` 时显示原文。Ctrl+O 详情视图始终显示完整。                                                                       |
| 行/块 marginTop       | 多数 `marginTop=1`                                                  | 默认 `marginTop=0`；仅"用户新 turn 边界"和"section 切换"维持 `marginTop=1`。                                                                                                 |
| 输入框上方            | 紧贴最后一行                                                        | 上方加 `marginTop=1`（≈ 一行 padding，TUI 等效 4-8px）。                                                                                                                     |
| Turn 耗时             | 工具级有 startTime；无 turn 级                                      | gemini 类型 history item 新增 `turnDurationMs?`；在 assistant 末尾 dim 渲染 `⏱ 3.2s`。                                                                                      |
| Table code            | 行内 / 块内代码统一走高亮                                           | 表格上下文（`inTable=true`）跳过 highlightjs，用 `theme.text.secondary` + 等宽。                                                                                             |
| SubAgent header       | `✔ researcher: investigate · 5 tools · 12s` 单条                   | 多 agent 时聚合 "3 Agents Completed" / "N Agents (X running, Y completed)..." (gemini-cli 文案)，glyph `✓ ✗ ! ℹ`；单 agent 两行结构化。Live panel 在 ≥2 时增加聚合 header。 |
| `--verbose`           | 不存在                                                              | 新 CLI flag + `ui.verbose` setting；运行中也可 `/verbose on/off`（不消耗 Ctrl+O）。                                                                                          |

## 5. Non-Goals (this PR)

- 不动 `useTerminalBuffer` (Virtual Viewport) 的底层调度；只复用 `ScrollableList` 作为 transcript overlay 容器。
- 不动 markdown 解析正则；只在已有 `inTable` 状态上加一条 highlight 分支。
- 不动消息序列化协议；`turnDurationMs` 是 UI-only 字段，不进 JSONL。
- 不引入新的 theme 色；新增的"transcript 横幅"复用 `theme.text.accent` / `theme.text.secondary`。
- 新 i18n key 约 18 条（zh/en 同步；详情见 §03 / §06 / §07 各章末 i18n 段）。
- 不抄 CC `groupToolUses.ts` 算法（保留 qwen 现有 merge）。
- 不引入 gemini-cli 的 `expanded/collapsed` subagent 折叠机制（Ctrl+O transcript 已覆盖该需求）。
- 不引入 `<CtrlOToExpand />` 组件实例（仅在 thinking 行加一句静态 hint 文本）。
