# §7 compactMode Call-site Audit

Exhaustive grep result of `compactMode | CompactMode | TOGGLE_COMPACT` excluding test files.

## Source files (10)

| file:line                                                | usage                                                                        | v2 action                                                                                                                                                                                 |
| -------------------------------------------------------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ | ----------- | --- | ----------------------------- |
| `AppContainer.tsx:120`                                   | `import { CompactModeProvider }`                                             | → `DisplayModeProvider`                                                                                                                                                                   |
| `AppContainer.tsx:2022-2023`                             | `useState(settings.merged.ui?.compactMode ?? false)`                         | → `useState(...ui?.verbose ?? argv.verbose ?? false)` (NB: 默认翻转)                                                                                                                      |
| `AppContainer.tsx:2812-2815`                             | Ctrl+O 写 `compactMode` + refreshStatic                                      | **删除** 整块 (Ctrl+O 改挂 `ENTER_TRANSCRIPT`)                                                                                                                                            |
| `AppContainer.tsx:2912-2913`                             | `compactMode, setCompactMode` 暴露 ui state                                  | → `verbose, setVerbose`                                                                                                                                                                   |
| `AppContainer.tsx:3396-3398`                             | `compactModeValue = useMemo({ compactMode, setCompactMode })`                | → `displayModeValue = useMemo({ verbose, setVerbose, transcript: transcriptOverlay.isActive })`                                                                                           |
| `AppContainer.tsx:3415,3423`                             | Provider 标签                                                                | → `DisplayModeProvider`                                                                                                                                                                   |
| `contexts/CompactModeContext.tsx`                        | 整文件                                                                       | **删除**；新建 `DisplayModeContext.tsx`；保留 re-export shim `useCompactMode = () => ({ compactMode: !useDisplayMode().verbose })` 一段过渡（CHANGELOG 标记 deprecated；下一个 minor 删） |
| `utils/mergeCompactToolGroups.ts:118-122`                | `isHiddenInCompactMode` 注释 + 函数名                                        | 注释更新 ("hidden when verbose=false")，函数名保持（语义仍是"compact mode 下隐藏" = "verbose 关闭时隐藏"）；行内文档 update                                                               |
| `utils/mergeCompactToolGroups.ts:132-135`                | `compactToggleHasVisualEffect` 注释                                          | 注释 update 或函数 deprecate（不再有 toggle，但 transcript enter/exit 也涉及 verbose 切换路径，函数仍有用）                                                                               |
| `utils/mergeCompactToolGroups.ts:242`                    | `if (isHiddenInCompactMode(next))` 逻辑                                      | 不变 — thoughts 仍入 history，verbose=false 时仍隐藏，合并行为不变                                                                                                                        |
| `components/SettingsDialog.tsx:32,66`                    | `useCompactMode` import + 解构                                               | → `useDisplayMode().verbose / setVerbose`                                                                                                                                                 |
| `components/SettingsDialog.tsx:195-198`                  | settings dialog 特殊 sync compactMode 回 context                             | → 改为 `if (key === 'ui.verbose' && newValue !== verbose) setVerbose(newValue)`                                                                                                           |
| `components/HistoryItemDisplay.tsx:59,110`               | useCompactMode import + 解构                                                 | → `useEffectiveVerbose()` (一句话 hook)                                                                                                                                                   |
| `components/HistoryItemDisplay.tsx:155,165`              | `!compactMode &&` gate thoughts                                              | → `verbose &&` gate (语义反转)                                                                                                                                                            |
| `components/HistoryItemDisplay.tsx:237-256`              | tool_use_summary `(!compactMode                                              |                                                                                                                                                                                           | !summaryAbsorbed)` | → `(verbose |     | !summaryAbsorbed)` (语义反转) |
| `components/MainContent.tsx:19,109`                      | import + 解构                                                                | → `useEffectiveVerbose()`                                                                                                                                                                 |
| `MainContent.tsx:139,168,187,211`                        | 4 处 `if (!compactMode)` 短路（absorbed CallIds 计算 + merged history calc） | 全部翻转为 `if (verbose)`                                                                                                                                                                 |
| `MainContent.tsx:276,291`                                | useEffect deps + `if (!compactMode)` 早返                                    | 翻转                                                                                                                                                                                      |
| `MainContent.tsx:92` 注释                                | "where compactMode is false"                                                 | 注释 update                                                                                                                                                                               |
| `components/messages/ToolGroupMessage.tsx:18,159`        | import + 解构                                                                | → `useEffectiveVerbose()`                                                                                                                                                                 |
| `ToolGroupMessage.tsx:300`                               | `showCompact = compactMode && ...`                                           | → `showCompact = !verbose && ...`                                                                                                                                                         |
| `ToolGroupMessage.tsx:466`                               | 注释 `!compactMode \|\| forceShowResult ? ...`                               | update                                                                                                                                                                                    |
| `components/messages/ToolMessage.tsx:35,656`             | import + 解构                                                                | → `useEffectiveVerbose()`                                                                                                                                                                 |
| `ToolMessage.tsx:313`                                    | `compactMode={true}` 显式传给 ToolConfirmationMessage                        | **删除 prop**（按 ToolConfirmationMessage 处置见下）                                                                                                                                      |
| `ToolMessage.tsx:658`                                    | `!compactMode \|\| forceShowResult`                                          | → `verbose \|\| forceShowResult`                                                                                                                                                          |
| `components/messages/ToolConfirmationMessage.tsx:45,56`  | `compactMode?: boolean` prop + default                                       | **删除 prop**；所有内部 layout 视为 `compactMode = true` 常量（始终紧凑）                                                                                                                 |
| `ToolConfirmationMessage.tsx:142-487` (8 处 layout 常量) | `compactMode ? A : B`                                                        | 全部固定 `A`（紧凑常量） — 具体即 `PADDING_OUTER_Y=0, MARGIN_BODY_BOTTOM=0, MARGIN_QUESTION_BOTTOM=0, HEIGHT_OPTIONS=3, outerPadding=0, sectionMargin=0, outerWidth=undefined`；删除三元  |
| `config/settingsSchema.ts:813-822`                       | `ui.compactMode` schema                                                      | **保留** 作为 deprecated 字段（schema 可选）；新增 `ui.verbose` schema (default false)                                                                                                    |
| `config/keyBindings.ts:58`                               | `TOGGLE_COMPACT_MODE = 'toggleCompactMode'` enum                             | **保留** + add `ENTER_TRANSCRIPT = 'enterTranscript'`, `EXIT_TRANSCRIPT = 'exitTranscript'`                                                                                               |
| `config/keyBindings.ts:217`                              | `[Command.TOGGLE_COMPACT_MODE]: [{ key: 'o', ctrl: true }]`                  | 改为空数组 + add `[Command.ENTER_TRANSCRIPT]: [{ key: 'o', ctrl: true }]`, `[Command.EXIT_TRANSCRIPT]: [{ key: 'escape' }]`                                                               |

## Test files (6) — update后

| file                                                                                     | 修改                                                                                                                                                 |
| ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ui/keyMatchers.test.ts:64,286`                                                          | 把 `Command.TOGGLE_COMPACT_MODE` 测试替换为 `ENTER_TRANSCRIPT` / `EXIT_TRANSCRIPT`；保留一条 deprecated 断言确保 `TOGGLE_COMPACT_MODE` 不再绑 Ctrl+O |
| `SettingsDialog.test.tsx:136,486`                                                        | `compactMode: false` → `verbose: false`；`'ui.compactMode'` → `'ui.verbose'`                                                                         |
| `MainContent.test.tsx` 6 处 `<CompactModeProvider value={{ compactMode: false }}>`       | → `<DisplayModeProvider value={{ verbose: false, transcript: false }}>`；视测试意图调整 verbose true/false                                           |
| `ToolMessage.test.tsx` 5 处 + helper                                                     | 同上                                                                                                                                                 |
| `ToolGroupMessage.test.tsx` `renderCompact` helper                                       | provider 切换 + 语义反转 (compactMode=true ↔ verbose=false)                                                                                         |
| `ToolConfirmationMessage.test.tsx` `describe('compactMode')` + 3 处 `compactMode={true}` | 测试整组删除（始终紧凑后无需测）；改测 layout 常量直接断言                                                                                           |
| `mergeCompactToolGroups.test.ts`                                                         | 测试函数仍调用 `isHiddenInCompactMode` — 不变；新增"verbose=true (不 merge)"用例                                                                     |

## CompactToolGroupDisplay (separate audit)

`components/messages/CompactToolGroupDisplay.tsx`：

| 现状                                         | v2                                                                  |
| -------------------------------------------- | ------------------------------------------------------------------- |
| 独立组件，被 `ToolGroupMessage.tsx:310` 引用 | **删除文件**；逻辑移到 `ToolGroupMessage` 内部 `renderSummaryRow()` |
| 测试文件 (如有)                              | 同步删除                                                            |
| import 引用                                  | `ToolGroupMessage.tsx:14` 单点；删除                                |

## 总结

新文件：

- `packages/cli/src/ui/contexts/DisplayModeContext.tsx`
- `packages/cli/src/ui/hooks/useTranscriptOverlay.ts`
- `packages/cli/src/ui/components/TranscriptOverlay.tsx`
- `packages/cli/src/ui/components/ThinkingPulse.tsx`
- `packages/cli/src/ui/hooks/useThinkingPulse.ts`
- `packages/cli/src/ui/components/messages/SubagentSummary.tsx`
- `packages/cli/src/ui/components/messages/SubagentGroupSummary.tsx`
- `packages/cli/src/ui/constants/subagentGlyphs.ts`
- `packages/cli/src/ui/commands/verboseCommand.ts`

删除：

- `packages/cli/src/ui/contexts/CompactModeContext.tsx`（保留 1 段 re-export shim 文件以免 import 报错；下一个 minor 删）
- `packages/cli/src/ui/components/messages/CompactToolGroupDisplay.tsx`

修改：上表 10 + 6 = 16 个文件 + i18n (zh, en) + settings migrator。

净增 / 净删行数估计：+1200 / -700。
