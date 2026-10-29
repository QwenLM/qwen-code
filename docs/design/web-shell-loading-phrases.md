# Web Shell loading phrase setting

[English](web-shell-loading-phrases.md) | [简体中文](web-shell-loading-phrases.zh-CN.md)

## Problem and scope

The terminal honors `ui.accessibility.enableLoadingPhrases`, but Web Shell
filters it out of its settings API and always enables main-chat phrases.
An embedded host can customize phrases through `loadingPhrases`, including an
empty array to hide them. Users need the existing setting to override that
customization when disabled.

## Design

Remove this key from the settings routes' terminal-only exclusion list. Reuse
Web Shell's existing effective settings resource, as used by its other UI
preferences, and pass `showPhrase={false}` to the main streaming status when
its effective value is exactly `false`. Missing values retain today's default.

| Effective setting | Host resolver            | Result                |
| ----------------- | ------------------------ | --------------------- |
| `false`           | Any                      | Hide rotating phrases |
| `true` or absent  | Nonempty phrases         | Show host phrases     |
| `true` or absent  | Empty array              | Hide rotating phrases |
| `true` or absent  | Absent or nullish result | Show built-in phrases |

The existing status component already stops the phrase rotation timer when
`showPhrase` is false. Spinner, elapsed time, token metrics, cancellation,
and background task labels remain unchanged. Split panes already suppress
phrases and keep that behavior.

The setting remains a boolean with default `true` and its existing restart
metadata, preserving terminal behavior. Add the `setting:loading-phrases`
presentation alias and English/Chinese labels for the newly exposed settings row.

## Ownership and constraints

No new daemon route is introduced. `/workspace/settings` remains legacy-primary
scoped, and `/workspaces/:workspace/settings` remains selected-runtime scoped,
with existing trust, environment, persistence, and failure handling. The main
Web Shell UI uses its existing settings resource; this change does not migrate
other UI preferences to session-selected workspace settings. Configuration
precedence remains the daemon's existing settings merge.

## Affected areas

- Settings API allowlist and route tests.
- Main Web Shell streaming status wiring and application tests.
- Settings presentation alias, translations, and embedding documentation.

## Validation and acceptance

Run focused route, application, streaming status, and settings alias tests.
Verify disabled, enabled, and missing settings with a custom host phrase, plus
updates during an active response. Verify user/workspace values are exposed
and writes use the existing scope handling. Run build, typecheck, and bundle.

Dry-run the global daemon to confirm the descriptor is currently excluded.
Use browser E2E with a simulated daemon to verify the actual loading UI and
capture enabled/disabled screenshots. Separately check the local daemon's real
settings read/write path; simulated UI evidence does not validate a real model
or Git operation.

There are no open design questions.
