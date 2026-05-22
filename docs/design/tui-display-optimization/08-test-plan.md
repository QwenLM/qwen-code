# §4 Test Plan

## Unit tests

| 模块                                  | 新增/修改用例                                                                    |
| ------------------------------------- | -------------------------------------------------------------------------------- |
| `mergeCompactToolGroups.test.ts`      | 已存在，新增"verbose=true 不合并"用例                                            |
| `HistoryItemDisplay.test.tsx`         | thoughts 在 verbose=false 不渲染；turn_summary 渲染                              |
| `ToolGroupMessage.test.tsx`           | 无 border 渲染；force-expand confirmation 显示 `─ awaiting`；group 内单 row 摘要 |
| `SubagentGroupSummary.test.tsx`（新） | 多 agent 聚合：counts、glyph 切换                                                |
| `SubagentSummary.test.tsx`（新）      | 单 agent 两行显示；reason 截断                                                   |
| `InlineMarkdownRenderer.test.tsx`     | inTable=true 跳过 highlight                                                      |
| `useTranscriptOverlay.test.ts`（新）  | enter/exit 状态机；多次 enter 幂等                                               |
| `TranscriptOverlay.test.tsx`（新）    | snapshot slice 行为；force-verbose 透传                                          |
| `settings migrator test`              | compactMode↔verbose 4 quadrant                                                  |
| `verboseCommand.test.ts`（新）        | on/off/toggle/no-arg 行为                                                        |
| `useThinkingPulse.test.ts`（新）      | 仅 thinking chunk 时 active；text/tool chunk 来到立即非 active                   |
| `formatTurnDuration.test.ts`（新）    | 三档边界值                                                                       |

## Integration / TUI snapshot tests

`packages/cli/src/ui/__tests__` 现有 snapshot：

- `app.test.tsx` 长会话 snapshot — 重新基准化（无 border、紧凑间距）
- `tool_groups.test.tsx` — 重新基准化
- 添加新的 transcript-overlay snapshot：模拟按 Ctrl+O 后渲染

## Manual smoke (Mac)

按以下脚本依次验证（在 worktree 内 `npm run dev` 或 `npm start`）：

1. **默认紧凑布局**：
   - 输入 `tell me about this project`
   - 期望：思考过程不显示；tool calls 单行；无 border；末尾 `⏱ X.Xs`；composer 上方有 1 行 padding。
2. **`--verbose` 启动**：
   - `qwen --verbose`
   - 同一 prompt：思考链 `✦` 可见；tool calls 完整展开；无 border 仍生效（border 与 verbose 解耦）；末尾耗时仍显示。
3. **Ctrl+O transcript**：
   - 流式响应中按 Ctrl+O → 进入 transcript overlay，看到 frozen header；底部 footer 提示 Esc。
   - 滚动到顶/底；按 Esc → 回 live view；后台已 stream 完成的新内容立即出现。
4. **SubAgent 聚合**：
   - 触发 spawn 多个 subagent（e.g. `task` tool 多 entry），观察：
     - LiveAgentPanel ≥2 时顶部 `≡ Agents (N running)` 聚合行
     - 完成后历史中显示 group summary 4 行格式
5. **`/verbose toggle`**：
   - 命令行切换 verbose；下条 turn 立即生效；老 thoughts 在 history 中不重渲染。
6. **表格内代码**：
   - 输入 `make a table comparing strings.split vs strings.tokenize, include code in cells`
   - 观察表格 cell 内 ` `code` ` 不再彩色，灰色单色。
7. **Esc 路由**：
   - Streaming 中 → Esc 取消（既有行为不变）
   - Streaming 中按 Ctrl+O 进 transcript，Esc 退 transcript（不取消 streaming）
   - 任意 dialog 打开 → Esc 关 dialog（既有行为不变）

## Regression matrix

- 长会话（>300 items）打开/退出 transcript 不能 freeze（VP 已经能撑住，复用即可）。
- 老 jsonl 含 thoughts 的会话 resume，verbose=false 不渲染，verbose=true 渲染。
- Windows console 退化字符（`>` `!` `+` `x` `i` 替代 `≡` `!` `✓` `✗` `ℹ`）—— smoke test via mocked `figures` only。
- Subagent confirmation 走 force-expand 路径 —— group summary 不吞 confirm UI。

## Cleanup verification

- 检查 `grep -rn "compactMode" packages/cli/src` 仅留下 deprecation re-export 和 migrator。
- 检查 `grep -rn "TOGGLE_COMPACT_MODE" packages/cli/src` 仅在 keybindings.ts deprecated 注释处。
