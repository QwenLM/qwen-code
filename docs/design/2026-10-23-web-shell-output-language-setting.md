# Model Output Language in the Web Shell Settings Panel

[English](2026-10-23-web-shell-output-language-setting.md) | [简体中文](2026-10-23-web-shell-output-language-setting.zh-CN.md)

Date: 2026-10-23

## Background

The Web Shell settings panel exposes the UI language through
`general.language`, rendered as an `en` / `zh-CN` select and applied with
`/language ui <lang> [--project]`. The model output language
(`general.outputLanguage`, labelled "Language: Model" in the schema) has no
row at all, so hosts cannot see or change it from the panel even though the TUI
settings dialog and the `/language output` command both support it.

The gap is deliberate on the daemon side: `general.outputLanguage` is listed in
`TUI_ONLY_SETTINGS` (`packages/cli/src/serve/routes/workspace-settings.ts`), so
`GET /workspace/settings` does not serve its descriptor. The reason is that
persisting the key through `POST /workspace/settings` would only rewrite
`settings.json`; it would not rewrite `~/.qwen/output-language.md` and would not
refresh running sessions. That is the "persistence is not synchronization"
rule documented in
[User-Level Language Sync for the Daemon](2026-08-29-user-level-language-sync.md).

## Goals

- Show the effective model output language in the Web Shell settings panel.
- Let the user change it from the panel with the same semantics as the TUI:
  empty means `auto` (follow the user's input language), and the change applies
  to the running session immediately.
- Keep `/language output` as the only write path, so
  `output-language.md` and the session system instruction stay consistent.

## Non-goals

- No workspace-scoped output language: the command persists at user scope and
  writes the global rule file, so the panel does not offer a workspace row.
- No new route and no change to the `POST` request schema.
- No change to the TUI settings dialog or `initializeLlmOutputLanguage()`
  preservation behavior.

## Design

### Read path: a read-only descriptor

`GET /workspace/settings` now serves `general.outputLanguage` from a new
`READ_ONLY_SETTINGS` set. The set is unioned into the GET key list only;
`getAllowedKeys()` and the `POST /workspace/settings` validation are unchanged,
so a write still fails with `400 disallowed_key`. This keeps the TUI-only write
restriction intact while giving hosts the effective value (user scope merged
over defaults), including its `values.user` and `values.workspace` fields for
the generic scope hints.

The descriptor also carries `options`: the names from `SUPPORTED_LANGUAGES`
as `{ value: fullName, label: "nativeName (fullName)" }`. They are suggestions,
not a whitelist; the setting keeps accepting any language name.

Older daemons simply do not serve the descriptor; the panel then renders no
row, which degrades cleanly.

### Write path: the language command

The Web Shell renders the row as a combobox rather than a fixed select. The
value is free-form (a language name such as `中文`, `English`, `日本語`, or
`auto`), so the input still accepts typed text; the popover exposes the
served suggestions for discoverability. An empty input, or picking the first
suggestion, means `auto` (follow the user's input language).

Committing a value sends `/language output <value>` (an empty value sends
`auto`) through the same session command channel used by `/language ui`. The
daemon command writes the `output-language.md` the session actually reads (the
project file when one exists, otherwise `~/.qwen/output-language.md`), persists
`general.outputLanguage` at user scope, refreshes hierarchical memory, and
rebuilds the live system instruction. The panel then reloads
`/workspace/settings` so the row reflects the persisted value.

The panel skips the generic `POST /workspace/settings` writer for this key, so
no `requiresRestart` banner is shown: the command takes effect on the next turn
without a restart.

### Scope

Output language is user-level. The row is only rendered on the User scope tab:
the command has no workspace target, and showing the row under Workspace would
imply an override that the write path cannot honor. A workspace
`.qwen/output-language.md` continues to override the global file per project,
independently of this row.

## Failure matrix

| Scenario                                           | Behavior                                                   |
| -------------------------------------------------- | ---------------------------------------------------------- |
| Daemon without the read-only descriptor            | No row rendered                                            |
| Commit while streaming or while a prompt is active | Command blocked by the shared session gate                 |
| `/language output` fails                           | Error reported; the stored value and input stay unchanged  |
| Empty input                                        | `/language output auto` (follow the user's input language) |
| Workspace tab                                      | Row hidden by design                                       |

## Compatibility

Additive on both sides. The daemon serves one more descriptor on an existing
route; hosts that ignore unknown keys are unaffected. The Web Shell tolerates a
daemon that does not serve the key.

## Change surface

| Layer     | Location                                                            | Change                                                                   |
| --------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Daemon    | `packages/cli/src/serve/routes/workspace-settings.ts`               | `READ_ONLY_SETTINGS` unioned into both GET key lists                     |
| Web Shell | `packages/web-shell/client/settings.ts`                             | `setting:output-language` alias                                          |
| Web Shell | `packages/web-shell/client/components/messages/SettingsMessage.tsx` | Combobox with language suggestions, free-form input, user-scope-only row |
| Web Shell | `packages/web-shell/client/App.tsx`                                 | `/language output` dispatch and settings reload                          |
| Web Shell | `packages/web-shell/client/constants/localCommands.ts`              | `output` subcommand completion                                           |
| Tests     | daemon route and settings panel tests                               | Read-only descriptor, write rejection, control behavior                  |

## Validation plan

- `workspace-settings.test.ts`: the descriptor is served with the effective
  value and `POST` rejects the key with `disallowed_key`.
- `SettingsMessage.dom.test.tsx`: the row is absent on the Workspace tab; on the
  User tab `auto` renders as an empty input, a fixed value renders as-is, and a
  commit calls the language callback instead of the generic settings writer.
- `settings.test.ts`: the published alias map includes the new alias.
- Manual: change the value in the panel during a session and confirm the next
  reply uses the new language without a restart.

## Acceptance criteria

1. The User tab of the Web Shell settings panel shows the effective model
   output language and allows changing it.
2. The change writes `output-language.md` and refreshes the running session.
3. `POST /workspace/settings` still refuses `general.outputLanguage`.
4. A daemon without the read-only descriptor renders no row.
