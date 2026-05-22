# §3.2 + §3.3 Spacing, Borders, Tool Visual

## Goals (from proposal)

- 行间距：内容行间距 0.5–0.6 行高；表格 / 复杂 div 维持 1 行。
- 块间距：不同 block 之间 0.5 行高。
- 问答间距：紧凑模式下 2 → 1 行。
- 输入区域：上方 4–8 px 留白（≈ Ink 1 行）。
- **工具调用去 border**（重要）：用缩进 + 前缀 icon 区分；标题与内容间距 0.5 行高。
- 表格内代码：禁用语法高亮（§3.6 单独）。

## Terminology mapping

- Ink 没有"0.5 行高"概念；它的最小单位是 1 行。我们用以下映射：
  - "0.5 行" → `marginTop=0` + 在相邻 block 内部用 inline padding 营造视觉松紧（依靠 dim/灰度文字的 leading 空格）。
  - "1 行" → `marginTop=1` (用户 turn 边界、文件输出 block 等"硬分隔"才保留)。
- "4-8px 留白" → `marginTop=1` on Composer 外层 Box。

## Current baseline

| 处                                                                     | 现状                                                        | 改后                                                                                             |
| ---------------------------------------------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `HistoryItemDisplay.tsx:105-108`                                       | `gemini_content` / `gemini_thought_content` → 0；其余 1     | 默认 0；**仅** `user` / `user_shell` / `notification` / section 类（about/help/stats/...）保留 1 |
| `ToolGroupMessage.tsx:332` 容器 `marginBottom=1`                       | 1                                                           | 0                                                                                                |
| `ToolGroupMessage.tsx:385-401` `borderStyle="round"` + `gap=1`         | 有 border, gap=1                                            | **去 border**，gap=0                                                                             |
| `CompactToolGroupDisplay.tsx:153-160` `borderStyle="round"`            | 有 border                                                   | **去 border**                                                                                    |
| Memory-only group `ToolGroupMessage.tsx:355-381` `borderStyle="round"` | 有 border                                                   | **去 border**                                                                                    |
| Composer 顶部                                                          | 紧贴                                                        | `marginTop=1`                                                                                    |
| Q&A 间距：user message 与 assistant message 之间                       | user `marginTop=1` + assistant `marginTop=1` = 2 行实际间隔 | user `marginTop=1`，assistant `marginTop=0` ⇒ 实际 1 行                                          |

## Visual spec — Tool group (no border)

Single tool, success（默认）：

```
⏺ Read(packages/cli/src/ui/AppContainer.tsx)
  ⎿  Read 2812 lines · 0.4s
```

Multiple tools merged（连续 2 个 tool_group 合并，4 个调用）：

```
⏺ Bash(npm run typecheck)
  ⎿  0 errors · 4.2s
⏺ Read(src/foo.ts)
  ⎿  Read 120 lines · 0.1s
⏺ Edit(src/foo.ts)
  ⎿  Updated 3 lines · 0.2s
⏺ Bash(npm test)
  ⎿  PASS 14/14 · 6.3s
```

Tool group with confirmation prompt（强制展开）：

```
⏺ Shell(rm -rf node_modules) ─ awaiting confirmation
  ⎿  [y]es  [N]o  [a]llow
```

> 颜色：状态符号 `⏺` 取 `theme.text.accent`（待执行）/`theme.status.success`（成功）/`theme.status.error`（错误）/`theme.status.warning`（执行中、待确认）。文件名 bold。结果行 `theme.text.secondary`。

> 长结果折叠：保留 `MaxSizedBox` 现有逻辑；超过 N 行省略并在 Ctrl+O transcript 中完整展开。

> `⎿` 这个 leading 字符借鉴 CC `figures.ts`。在 macOS 终端能正常显示；在 Windows 控制台用 `└─` 退化（通过 `figures` 包等价；我们在 §3.4 后会增加 utility）。

## Indentation rules

- 每条 tool call 行：左缘 0（与正文齐）；前缀 `⏺ `（占 2 列）。
- 结果行：`  ⎿  `（2 空格缩进 + glyph + 2 空格）。
- subagent 子项（详见 §3.4）：再缩进 2。

## Spacing rules consolidated

```
[user message]              ← marginTop=1 (turn boundary)
✦ <assistant text>          ← marginTop=0
⏺ Tool(a)                   ← marginTop=0
  ⎿ result                  ← marginTop=0
⏺ Tool(b)                   ← marginTop=0
  ⎿ result                  ← marginTop=0
✦ <assistant continuation>  ← marginTop=0
                            (turn ends)
⏱ 3.2s                      ← marginTop=0 (right-aligned dim, see §3.5)
                            ← marginTop=1 ← Composer wrapper
> _                         (input prompt)
```

→ Q&A 之间硬性 1 行；turn 内部所有 chunk 紧贴；最末 elapsed + composer padding 加起来 = 2 行 buffer，视觉清爽不局促。

## Implementation outline

### A. `HistoryItemDisplay.tsx`

```ts
const TOP_MARGIN_TYPES = new Set([
  'user',
  'user_shell',
  'notification',
  'about',
  'help',
  'stats',
  'quit',
  'compression',
  'context_usage',
  'extensions_list',
  'tools_list',
  'skills_list',
  'mcp_status',
  'model_stats',
  'tool_stats',
  'diff_stats',
]);
const marginTop = TOP_MARGIN_TYPES.has(item.type) ? 1 : 0;
```

> 注意 `summary` / `tool_use_summary` / `gemini` / `gemini_content` / `gemini_thought*` / `tool_group` / `info` / `success` / `warning` / `error` / `retry_countdown` → 0。

### B. `ToolGroupMessage.tsx` (v2)

1. **去掉外层 round border**：删除 `borderStyle="round"`, `borderColor`, `borderDimColor`, `gap`；外层用 `Box flexDirection="column"`。
2. **保留 `width={contentWidth}`**（line 389-393 的注释明确：删除 width 触发 ink rendering bug）。width 与 border 独立。
3. **`staticHeight` 重算**：line 332 `staticHeight = /* border */ 2 + /* marginBottom */ 1` → `staticHeight = /* marginBottom */ 1`（border 已去）。
4. **每个 inner tool**：包 `<ToolRow>`（新组件），渲染 `⏺ <name>(<args>)` 标题 + `⎿ <result>` 结果行。
5. **Memory-only group**：同样去 border，改为单行 `⏺ Recalled N memories · Wrote M memories`。
6. **Confirming 强展开**：去 border，但 `⏺` 颜色用 warning，并在标题尾追加 ` ─ awaiting confirmation`（i18n）。
7. **聚合 summary 分支** (取代 `CompactToolGroupDisplay`)：当 `!verbose` 且 tool group 非 force-expand 且 tools.length ≥ 2 时，调用内部 `renderSummaryRow()` 函数：单行 `⏺ <activeName>(<desc>) · × N tools` + `⎿ <status> · <elapsed>`。无 border。

### C. `CompactToolGroupDisplay.tsx` (v2)

**删除** 该组件文件。其等价行为搬到 `ToolGroupMessage.tsx` 内部 `renderSummaryRow()` 函数（见 §B.7）。移除 "Press Ctrl+O to show full tool output" 提示（CC 无此行；用户能通过 Ctrl+O 自然发现 transcript）。

### D. Composer wrapper

定位 composer 容器（grep `InputPrompt`, `BaseTextInput` 父级）。在最外层添加：

```tsx
<Box marginTop={1} flexDirection="column">
  ...composer...
</Box>
```

### E. Tool merging always-on (v2)

`MainContent.tsx` 当前 merge 调用按 `compactMode` 短路。新：

```ts
const mergedHistory = useMemo(() =>
  verbose
    ? history
    : mergeCompactToolGroups(...),
  [verbose, history]);
```

（语义反转：默认 merge，verbose 时不 merge。）

> **算法本身不动**。`mergeCompactToolGroups` 沿用 qwen 既有"连续 tool_group + 非 force-expand 即合并"实现，**不抄** CC 的 `groupToolUses.ts`（同 message + 同 tool 名 + ≥2）。本 PR 把"工具调用合并"的承诺修正为：_视觉前缀对齐 CC (`⏺`/`⎿`)，合并算法沿用 qwen 既有实现并始终启用_。Review 1 中 C1 已记录此 deviation。

## Files touched

- `packages/cli/src/ui/components/HistoryItemDisplay.tsx` — marginTop 重定义
- `packages/cli/src/ui/components/messages/ToolGroupMessage.tsx` — 去 border + 改 inner 渲染
- `packages/cli/src/ui/components/messages/CompactToolGroupDisplay.tsx` — **删除**（逻辑并入 ToolGroupMessage 的 `renderSummaryRow()`）
- `packages/cli/src/ui/components/messages/ToolMessage.tsx` — header / result 行重排，使用新前缀
- `packages/cli/src/ui/components/messages/ToolRow.tsx` — **新**（提取共用 row 渲染）
- `packages/cli/src/ui/components/MainContent.tsx` — merge 语义反转、composer wrapper
- `packages/cli/src/ui/constants.ts` — 新增 `TOOL_PREFIX = '⏺'`, `RESULT_PREFIX = '⎿'`（带 figure 退化）

## Edge cases / risks (v2)

1. **Ink border tearing**（baseline 提到的 ToolGroupMessage 注释 line 389-393）：去 border 后 ink 不会再画 box-drawing 字符，tearing 来源消失。**仍然保留 `width={contentWidth}`**（决策已经定型；它是 layout 约束，与 border 独立）。
2. **`staticHeight` 计算**：删除 border 后 `staticHeight = 2 + 1` → `1`（见 §B.3）。否则每个 tool 的 `availableTerminalHeightPerToolMessage` 会少给 2 行。
3. **截断显示**：去 border 后单行更长，`wrap="truncate-end"` 仍然有效；不会换行破坏布局。
4. **Tool 内部 diff 渲染**：DiffRenderer 自带 frame **保留**（语义性 — `+`/`-` 行需要 frame 锚定）。去外层 ToolGroupMessage border 后视觉更干净。
5. **subagent 嵌套**：见 §3.4 — subagent 内部 tool 列表会再缩进 2 列，前缀同样不带 border。
6. **memory group 紧凑度**：原本 N 个 memory 操作展开为多行；改为单行后省 N-1 行。
7. **Tool 长结果折叠**：保留现有 `MaxSizedBox` 行为（不引入 CC 的 `CollapsedReadSearchContent` 等价物）；transcript overlay 中强制全展开（force-verbose 透传）。
