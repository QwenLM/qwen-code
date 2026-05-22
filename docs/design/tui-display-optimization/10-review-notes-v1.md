# Review notes (v1 → v2)

两轮独立 review 总结发现，需要在 v2 修订的关键决策：

## Blocker fixes（必改）

### B1. Thinking 入 history（与 transcript 显示统一）

**问题**：v1 §3.1 同时主张"thoughts 不入 history (default)" + "Ctrl+O transcript 始终能看完整 thoughts"，但 transcript 只 slice `history` 数组，自相矛盾。`useThinkingPulse` 订阅的 `appEvents.thinking_chunk` 在代码库中不存在。
**v2 决策**：

- `gemini_thought` / `gemini_thought_content` **始终** 入 history（保持现状）。
- `HistoryItemDisplay` 在 `verbose=false` 时不渲染（用 `useEffectiveVerbose()` gate）。
- Live pulse 状态从 _现有信号_ 派生：`useThinkingPulse` 内部读 `(pendingHistoryItems.last.type === 'gemini_thought*' && streamingState === Responding)`，**不**新增事件总线。
- Transcript overlay 强制 `verbose=true`，thoughts 自然渲染。

### B2. Ctrl+O 在 transcript 内行为 (toggle, 不是 no-op)

**v2 决策**：transcript 中按 Ctrl+O = 退出 transcript（与 CC `useGlobalKeybindings.tsx:118-132` toggle 行为一致）。同时 Esc 也退出（保留 keyboard 习惯）。

### B3. Tool merge 算法措辞

**问题**：v1 声称"CC 风格"但实际算法是 qwen 既有的"连续 tool_group 都合并"，与 CC 的"同 message + 同 tool 名 + ≥2"差距大。
**v2 决策**：保留 qwen 既有 `mergeCompactToolGroups` 算法（侵入小、回归风险低）；文档措辞改为 _"沿用 qwen 既有合并算法，默认始终启用；视觉前缀与 CC 对齐 (`⏺`/`⎿`)"_。不重写算法。

### B4. SubAgent glyph 真实对齐 gemini-cli

**问题**：v1 用 `✔ ✖ ⊷ ⏸`，实际 gemini-cli `SubagentGroupDisplay.tsx:229-243` 用 `✓ ✗ ! ℹ`。`constants.ts:20-27` 是 TOOL_STATUS，不是 subagent glyph。
**v2 决策**：

- 改用 gemini 实际 glyph：`✓ completed`, `✗ failed`, `! running`, `ℹ cancelled`
- 删除 `⏸ paused`（gemini 没这状态；qwen 的 paused 用 `ℹ` 同义代）
- header 文案沿用 gemini 实际格式：`"3 Agents Completed"` / `"3 Agents (1 running, 2 completed)..."`
- 单 agent 仍保留方案的两行结构化布局（这是合理本地强化，文档明示）
- 引用改为 `SubagentGroupDisplay.tsx:229-243`，不再误指 `constants.ts`

### B5. ESC 路由优先级（含 6 个现有分支）

**问题**：v1 §3.7 只描述 3 个 ESC 用途，实际 `AppContainer.tsx:2695-2761` 已有 6 个分支（btw cancel、shell focused、buffer clear/prompt、streaming cancel、double-esc rewind）。
**v2 决策**：transcript active 时短路整条 ESC chain：

```
1. transcript active ──── exit transcript & return
2. dialog open       ──── close dialog
3. btw cancel        ──── cancel btw
4. embedded shell    ──── give to shell
5. buffer.length > 0 ──── clear/prompt
6. streaming         ──── cancel streaming
7. idle + !IDE       ──── double-esc rewind
```

transcript active 永远第一优先级，且不再 fall through。

### B6. turn_summary 渲染位置（独立 history item）

**问题**：v1 §3.5 同时写"渲染在 assistant message 尾部"和"新独立 history item"。
**v2 决策**：独立 `HistoryItemTurnSummary`（解耦干净，VP 路径自动支持），删除"内联到 assistant 尾部"叙述。

### B7. 4 个场景图覆盖（文件读取错误 / 简单项目检查 / Diff / 长流式）

**v2 决策**：新增 `docs/design/tui-display-optimization/11-scenario-coverage.md` 把提案附图 9/10/11/12 一一对照到具体组件改动。

### B8. compactMode 调用点 audit

**v2 决策**：新增 `12-call-site-audit.md`，列出全部 51 个非测试 `compactMode` 调用点 + 每点新语义。

### B9. ToolConfirmationMessage 的 `compactMode` prop

**v2 决策**：始终 compact 后，prop 改为常量 `true` 内嵌；删除 prop 暴露。8 处 layout 常量随之合并简化。

### B10. CompactToolGroupDisplay

**v2 决策**：**删除** 该文件，逻辑并入 ToolGroupMessage 内部 `mode='summary'` 分支。不再"或降级"。

### B11. ToolGroupMessage `width={contentWidth}` 保留

**v2 决策**：保留（Ink 渲染 bug 注释明确警告）；只去 border + dimColor + gap。同时把 `staticHeight = 2 + 1` → `staticHeight = 1`（仅 marginBottom；border 已删）。

### B12. gemini_thought_content

**v2 决策**：与 `gemini_thought` 同等待遇，渲染层一并 gate。文档 §3.1 修订。

### B13. 4 套 glyph 家族收敛

**v2 决策**：

- Tool 行: `⏺` / `⎿`（CC 派，保留）
- SubAgent: `≡ + ✓ ✗ ! ℹ`（gemini 派，校正后保留）
- Thinking: `✻ Thinking… (Ns) · Ctrl+O for details`（混合 — CC redacted glyph + 本地秒数 + hint，明示偏差）
- Turn elapsed: `⏱`（emoji-style，唯一外来；保留但放在独立短行 dim 渲染，视觉占位最小）

明示文档：4 个家族**有意**保留，对应 4 个语义层级（tool/agent/think/timing），用户可学习。

### B14. CC 引用准确性

- Thinking 引用：改为引用 CC 两条路径 `AssistantThinkingMessage.tsx:44 (∴ Thinking <CtrlOToExpand />)` 与 `AssistantRedactedThinkingMessage.tsx:16 (✻ Thinking…)`，并说明我们选 `✻ + 秒数 + Ctrl+O hint` 是混合本地化。

### B15. Tool result 长输出折叠

**v2 决策**：保留现有 `MaxSizedBox` 行为（不引入 CC 的 `CollapsedReadSearchContent` 等价物）；transcript overlay 中强制全展开。文档 §3.3 加一段。

## Minor (清理)

| 处                                                    | v2 决策                                                                                                                         |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `02-spacing-and-borders.md:108` "可能删 width"        | 明确**保留**                                                                                                                    |
| `04-turn-elapsed.md:86` 快速 turn 过滤                | 明确**不过滤**                                                                                                                  |
| `06-ctrl-o-transcript.md:141` onboarding hint         | 明确**不做**（写成 non-goal）                                                                                                   |
| `07-verbose-and-settings.md:98` `TOGGLE_COMPACT_MODE` | **保留 enum + 绑空 + deprecated 注释**；老 keybinding `toggleCompactMode` 加载时 translate 成 `enterTranscript`（保留用户意图） |
| i18n key 估算                                         | v1 说 "≤ 6 条" 与实际 ≈ 18 条不符 — v2 修正为 "≈ 18 条"                                                                         |
| `05-table-inline-code.md` 行内 code                   | **不引入新 theme key**；用 `color={theme.text.secondary}` 单色 fallback                                                         |
| `09-rollout-and-risks.md:21` "Ctrl+O 不可逆" 模糊免责 | 改写为 _breaking change_，列入 changelog                                                                                        |
| Step 0/1 合并                                         | rollout 重排，settings migrator + DisplayModeContext 一同落地                                                                   |

## Out of scope（明示）

- 不抄 CC 的 `groupToolUses.ts` 算法（保留 qwen 现有 merge）
- 不引入 gemini-cli 的 expanded/collapsed subagent 折叠机制（transcript overlay 已覆盖该需求）
- 不引入 `<CtrlOToExpand />` 组件实例（仅在 thinking 行加一句静态 hint 文本）
- 不动 theme 色（fallback 走现有色）
