# Clickable reasoning effort in the OpenTUI footer

[English](2026-11-19-opentui-footer-effort-picker.md) | [简体中文](2026-11-19-opentui-footer-effort-picker.zh-CN.md)

- Status: Implemented, awaiting review
- Date: 2026-11-19
- Scope: OpenTUI interactive renderer only; Ink is unchanged

## Problem

The OpenTUI footer already shows the active reasoning tier next to the model
name (`<model> <effort>`), but the tier is plain text. Changing it requires
remembering the `/effort` command and typing it, even though the same effort
picker is one click away in other desktop UIs.

A second problem appears with models whose provider entry carries a static
effort knob (`generationConfig.extra_body.reasoning_effort` or
`generationConfig.samplingParams.reasoning_effort`, flat or nested). Those raw
request values are merged last, so they outrank `model.reasoningEffort`. A
picker that writes only the global setting can report success while the wire
and a later restart keep the static tier.

## Goals

- Make only the tier run in the status line clickable; the model name and every
  other status-line run stay inert.
- Open the existing effort picker, with the tier currently shown in the footer
  preselected.
- Persist the pick across sessions.
- Leave one source of truth after the pick: remove the active provider entry's
  static effort keys, so the global tier is not shadowed after restart.
- Coexist with selection auto-copy: dragging text in the footer must not open
  the picker.
- Keep Ink behaviour unchanged.

## Non-goals

- No new effort picker UI; the existing dialog is reused.
- No changes to provider-specific budget knobs (`thinking_budget`,
  `budget_tokens`, `thinkingLevel`). They remain explicit escape hatches.
- No writing to operator-owned System/SystemDefaults settings.
- No provider model-switch logic.

## Design

### Click target

`useStatusLineState` returns a `reasoningSegment` only when the preset status
line includes `model-with-reasoning`, the displayed reasoning has a tier, and
the model exposes at least one tier. The footer locates that exact segment in
the already-wrapped status line and wraps only the tier substring in a
clickable box.

A line containing ANSI escapes, or a line where wrapping split the model
segment, is left inert. This avoids cutting an escape sequence or guessing a
column.

### Click vs drag

OpenTUI starts a selection on left mousedown over selectable text and returns
before dispatching `onMouseDown`, so a mousedown anchor cannot distinguish a
tap from a drag. On `mouseUp` the footer checks whether the renderer's current
selection contains text:

- empty selection: a tap; open the picker
- non-empty selection: a drag that may be auto-copied; do not open

This also matches PR 16799's selection auto-copy behaviour.

### Footer-opened picker

The footer opens the effort dialog with `openedFromFooter: true`. The dialog:

- preselects the tier reported by the display path, so the highlighted row
  matches the footer even when the tier comes from a static provider knob;
- applies the tier immediately;
- records the result in the transcript but does not record it as a typed
  `/effort` command.

Direct `/effort` keeps its existing preselect and recording behaviour.

### Persistence

The pick writes `model.reasoningEffort` to the scope that owns
`modelProviders` and clears the key only in higher-precedence writable scopes
that carry it. A lower-precedence scope cannot shadow the write, so its value
is preserved (a Workspace pick does not erase the user's global default).

The active provider entry is selected by protocol + model id, with the live
base URL first and the persisted `model.baseUrl` second. If no unique entry can
be identified, the static rewrite is skipped rather than touching a sibling
provider.

For the identified entry, the static effort keys are removed from
`extra_body` and `samplingParams`. A nested `reasoning` object is removed as a
unit, because the OpenAI pipeline can treat the object's presence as an
override regardless of its `effort`; any sibling keys (for example
`budget_tokens`) are removed with it and reported in the UI rather than
silently lost. Flat `reasoning_effort` is removed on its own.
`model.generationConfig` is handled the same way for its global fallback copy.
Removal is written as per-path `undefined` values so the JSONC writer emits
delete operations; a whole-object write would deep-merge and leave the old key
behind.

The provider-array write goes through the same placeholder preservation as the
provider-install adapter: raw `${VAR}` placeholders are restored before saving,
so no env-expanded secret is written to `settings.json`. Writes use
`throwOnWriteFailure`, and the dialog reports a persistence failure instead of
a success message.

Live and registry copies are cleaned for the current session as well, so
same-model sub-agents do not inherit the old static knob before restart.

### Model coverage

The entry is available for models with effort tiers: the built-in GPT,
DeepSeek and tiered Qwen families, plus any model declaring
`capabilities.reasoning.efforts`. Toggle-only models, models without reasoning
capabilities, and a displayed tier that is not in the model's ladder show no
click target.

## Constraints and known limitations

- System/SystemDefaults settings are operator-owned; static effort keys there
  still outrank the persisted tier and cannot be rewritten by the picker.
- Provider-specific budget knobs are not mapped to the canonical ladder.
- A provider id containing `.` cannot be addressed by the settings dot path;
  its static key removal is skipped to avoid corrupting the tree.
- Rewriting `modelProviders.<key>` is a whole-array write; a concurrent edit to
  that same provider array between load and save can be overwritten.
- The status line is split into three text runs for the click target. A visual
  check after rebasing on the selection-clipboard PR is required.
- A raw persistence error is surfaced as technical text and is not translated.

## Validation

- Targeted unit tests cover segment exposure, toggle-only inertness, footer
  preselection, click vs drag selection, provider-entry matching (custom key,
  live/persisted base URL, sibling untouched), flat/nested static removal,
  global `model.generationConfig` removal, workspace tier clearing, placeholder
  path shape, and failure notification.
- A real temporary settings file test covers per-path JSONC deletion, nested
  whole-object removal, sibling preservation, and `${VAR}` placeholder
  retention without writing the resolved secret.
- A PTY end-to-end run clicks the footer tier, selects a different tier,
  verifies `model.reasoningEffort` and the removal of the provider static knob,
  restarts the CLI, and reads the new tier back.
- `prettier`, `eslint`, and the CLI TypeScript build pass.

## Acceptance criteria

- Clicking the tier opens the picker; clicking any other status-line run does
  not.
- A drag selection that ends on the tier does not open the picker.
- Choosing a tier updates the footer and the effective request configuration.
- After a restart, the chosen tier is still in effect and no provider static
  knob shadows it for writable scopes.
- Ink output and interactions are unchanged.

## Follow-up

- Decide whether System-owned static knobs should produce a user-visible
  warning.
- Re-check footer selection copying after the selection-clipboard PR lands.
