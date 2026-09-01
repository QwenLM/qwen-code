# Output style picker and mid-session switching

Date: 2026-09-01
Status: implemented
Follows: #9565 (built-in styles and prompt layering), #10282 (per-turn reminder), #10283 (`general.outputStyle` setting and `--output-style` flag)

## Problem

After #10283 a style can be selected, but only at startup: the setting is read once in `loadCliConfig` and there is no way to change or even see the active style from inside a session. The interactive picker and the live hand-off were deliberately split out of #10283 so they could be reviewed on their own. This is that slice.

## Shape

`/output-style` follows the `/effort` pattern exactly — the closest existing command that pairs an argument form with a picker dialog:

- Bare `/output-style` in an interactive session opens a `RadioButtonSelect` dialog listing `default` plus the built-in styles with their one-line descriptions, pre-selected on the active style. In non-interactive and ACP sessions it reports the current style and the options instead.
- `/output-style <name>` applies directly, case-insensitively; `default` selects no style. An unknown name is an error that lists the valid choices — unlike the startup path in `loadCliConfig`, which only warns, because at startup failing would lock the user out while here the user is present to retry.

Applying a choice does three things, shared between the argument form and the dialog (`output-style-utils.ts`):

1. `config.setOutputStyle(style)` — the accessor #9565 shipped, whose docstring already required this slice's follow-up:
2. `LlmClient.refreshSystemInstruction()` — rebuilds and re-binds the system instruction in place, the same mechanism `/language` uses. The style lives in the stable prompt layer recorded by `setStaticSystemPrefix`, so a mid-session switch deliberately invalidates the cached prefix once. The per-turn reminder needs no separate handling: it re-reads `resolveMainSessionOutputStyle(config)` every turn.
3. Persist `general.outputStyle` to user settings.

## Decisions

- **A dedicated dialog, not a `/settings` entry.** Claude Code moved style selection into its config UI, but our `SettingsDialog` is driven by a static schema (`options` lists fixed at build time) while the style list will grow user/project-defined entries in the next slice. The `/effort`-style dialog is the established shape for exactly this kind of dynamic pick list. `showInDialog` stays `false` with a comment saying why.
- **Mid-session switching is allowed** (Claude Code fixes the style at session start for cache stability). The refresh mechanism already exists and `/language` already pays the same one-time cache miss; session-fixing would buy nothing but a restart round-trip.
- **`requiresRestart` flips to `false`**, matching `model.reasoningEffort`: the command applies the change live. A hand edit to `settings.json` still needs a restart, which the settings reference now says explicitly.
- **Clearing persists the literal `default` rather than deleting the key.** `resolveOutputStyle` already treats `default` as "no style", and an explicit user-scope value cannot be silently overridden by a workspace-scope setting on the next start, where a deleted key could.
- **Persistence targets the user scope**, like `/language`. Styles are a personal voice preference, not a project property; a project can still set `general.outputStyle` in workspace settings by hand.
- **Selection reports whether the style is actually in effect.** When `--system-prompt` or `QWEN_SYSTEM_MD` replaces the prompt, `resolveMainSessionOutputStyle` returns nothing; the command still applies and persists the choice but says it has no effect in this session, instead of succeeding silently.

## Out of scope

Custom `.qwen/output-styles/*.md` files, extension-provided styles (the `claude-converter` gap), and surfacing the style in the footer/status line are later slices. The dialog reads `BUILT_IN_OUTPUT_STYLES` directly; the loader slice will swap that for a listing that includes user/project styles without changing the command surface.
