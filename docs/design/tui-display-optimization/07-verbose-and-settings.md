# §3.8 `--verbose` Flag, Settings, Migration

## Goal

把"显示完整 thoughts / 工具输出 / 不合并 tool group"集中为单一 `verbose` 偏好，与 Ctrl+O（transcript）彻底解耦。同时保证老用户的 `compactMode` 设置无缝过渡。

## New surface

### CLI flag

```sh
qwen --verbose          # 启动即 verbose
qwen -v
```

存到 `argv.verbose`，初始 setting 值 = `argv.verbose ?? settings.ui.verbose ?? false`.

### Settings

`packages/cli/src/config/settingsSchema.ts`：

```ts
verbose: {
  type: 'boolean',
  label: 'Verbose Display',
  category: 'UI',
  requiresRestart: false,
  default: false,
  description: 'Show thinking output and full tool details inline. When off (default), thoughts are hidden and tool batches are merged for a compact view. Ctrl+O always shows the full transcript regardless of this setting.',
  showInDialog: true,
},
```

### Slash command

`/verbose [on|off|toggle]`：

```
> /verbose on
✓ Verbose display enabled.
```

注册位置：`packages/cli/src/ui/commands/verboseCommand.ts`（新）

### Context

新 React context（替代 `CompactModeContext`）：

```ts
// packages/cli/src/ui/contexts/DisplayModeContext.tsx
type DisplayMode = {
  verbose: boolean;
  /** True while Ctrl+O transcript overlay is rendering — force-verbose. */
  transcript: boolean;
};
```

便捷 hook：

```ts
export const useDisplayMode = () => useContext(DisplayModeContext);

// shorthand
export const useEffectiveVerbose = () => {
  const { verbose, transcript } = useDisplayMode();
  return verbose || transcript;
};
```

> 所有原本读 `useCompactMode().compactMode` 的地方 → 改读 `useEffectiveVerbose()` 的反面：
> `const compact = !useEffectiveVerbose();`

## Migration

### Setting key

- 新 key：`ui.verbose`
- 老 key：`ui.compactMode`

迁移在 settings 加载时：

```ts
// packages/cli/src/config/settings.ts (or schema migrators)
if (
  typeof raw.ui.verbose === 'undefined' &&
  typeof raw.ui.compactMode === 'boolean'
) {
  raw.ui.verbose = !raw.ui.compactMode; // compact=true → verbose=false (今天的 compact 等价于新默认)
  delete raw.ui.compactMode;
  log.info('Migrated ui.compactMode → ui.verbose');
}
```

- 实际迁移**默认结果**：
  - 老用户 `ui.compactMode = true` → 新 `ui.verbose = false` → 看到新紧凑布局（**他们已经在用紧凑**，所以视觉变化最小，符合预期）。
  - 老用户 `ui.compactMode = false`（即明确 verbose 用户）→ 新 `ui.verbose = true` → 仍 verbose（无视觉变化）。
  - 老用户从未设置 → 新 default = `verbose=false` → 看到新紧凑布局（提案目标）。

### Keybinding config

`Command.TOGGLE_COMPACT_MODE` 在 enum 保留，但在 `defaultKeyBindings` 中绑空数组（不再吃 Ctrl+O）：

```ts
[Command.TOGGLE_COMPACT_MODE]: [], // deprecated, kept for backward-compat with user keybinding configs
[Command.ENTER_TRANSCRIPT]: [{ key: 'o', ctrl: true }],
[Command.EXIT_TRANSCRIPT]: [{ key: 'escape' }],
```

并加 deprecation 注释。

### Settings dialog

`SettingsDialog.tsx` 的 compactMode 行 → 替换为 verbose 行。文案更新。

## Compatibility checklist

| 场景                                                          | 行为                                                                                                              |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| 老用户 keybindings.json 自定义 `ctrl+o` → `toggleCompactMode` | 兼容性 fallback：keybinding 加载时把 `toggleCompactMode` 翻译成 `enterTranscript`（更接近用户意图）。加迁移注释。 |
| 老用户 settings.json 含 `ui.compactMode`                      | migrator 自动转换为 `ui.verbose`                                                                                  |
| 用户脚本调用 `/compact on`（如果存在）                        | grep 确认；不存在则无影响                                                                                         |
| jsonl 历史回放含 `gemini_thought` items                       | verbose=false 时不渲染；verbose=true / transcript 时渲染                                                          |
| 自动化测试期望 compactMode 关键字                             | 改测试名 + 更新 fixtures                                                                                          |

## Files touched

- `packages/cli/src/config/settingsSchema.ts`
- `packages/cli/src/config/settings.ts` — migrator
- `packages/cli/src/config/keyBindings.ts`
- `packages/cli/src/ui/contexts/CompactModeContext.tsx` — **删除** 或重命名 + 兼容 re-export
- `packages/cli/src/ui/contexts/DisplayModeContext.tsx` — **新**
- `packages/cli/src/ui/commands/verboseCommand.ts` — **新**
- `packages/cli/src/ui/AppContainer.tsx` — 注入新 context，移除 compactMode toggle
- `packages/cli/src/ui/components/SettingsDialog.tsx`
- `packages/cli/src/ui/components/KeyboardShortcuts.tsx`
- 所有 `useCompactMode()` 使用点（baseline 已 grep 15 个文件）

## Test

- migrator unit test (covers all 4 quadrants: 老 user 有/无 compactMode × verbose 有/无)
- `/verbose` command test
- keybinding migration test (`toggleCompactMode` → `enterTranscript`)
