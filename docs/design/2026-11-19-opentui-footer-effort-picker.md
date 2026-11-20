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
request values are merged last, so they outrank `model.reasoningEffort`. This
PR does not change that escape-hatch semantics: it makes the footer tier
clickable and reuses Ink's `/effort` persistence path, so both renderers keep
the same behaviour and the existing `formatEffortChangeMessage` remains the
single source of override feedback.

## Goals

- Make only the tier run in the status line clickable; the model name and every
  other status-line run stay inert.
- Open the existing effort picker, with the tier currently shown in the footer
  preselected.
- Apply and persist the pick through the same `useEffortCommand` path as Ink's
  `/effort`: `applyReasoningEffort` plus
  `settings.setValue(getPersistScopeForModelSelection(settings), ...)`.
- Coexist with selection auto-copy: dragging text in the footer must not open
  the picker.
- Keep Ink behaviour unchanged.

## Non-goals

- No new effort picker UI; the existing dialog is reused.
- No static effort-knob cleanup, override detection, or extra warning beyond
  the existing `formatEffortChangeMessage`. Provider/global flat and nested
  knobs remain explicit escape hatches.
- No mapping of provider-specific budget knobs (`thinking_budget`,
  `budget_tokens`, `thinkingLevel`) onto the canonical ladder.
- No writing to operator-owned System/SystemDefaults settings.
- No provider model-switch logic.

## Design

### Click target

`useStatusLineState` returns a `reasoningSegment` only when the preset status
line includes `model-with-reasoning`, the displayed reasoning has a tier, and
that displayed tier is one the picker can offer (it belongs to the model's
effort ladder). The footer locates that exact segment in the already-wrapped
status line and wraps only the tier substring in a clickable box.

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

The pick reuses Ink's `/effort` path exactly: `applyReasoningEffort` applies the
tier to the live config, then the dialog persists `model.reasoningEffort` with
`getPersistScopeForModelSelection(settings)`. That is the same scope Ink writes,
so the two renderers cannot drift. No other setting is written or deleted.

Static provider/global knobs therefore remain in place. When they are present
they can still outrank the persisted tier, exactly as they do for Ink's
`/effort`; `formatEffortChangeMessage` is the existing feedback path for a
configured override. The footer picker does not add a second warning or a
settings-rewrite path.

### Model coverage

The entry is available for models with effort tiers: the built-in GPT,
DeepSeek and tiered Qwen families, plus any model declaring
`capabilities.reasoning.efforts`. Toggle-only models, models whose displayed
reasoning has no tier, and a displayed tier outside the model's ladder show no
click target. A model that declares no reasoning capability falls back to the
full ladder (the provider clamps), so it stays clickable whenever a tier is
displayed.

## Constraints and known limitations

- Static provider/global effort knobs are preserved. They can still outrank the
  persisted tier, exactly as they do for Ink's `/effort`; the existing
  `formatEffortChangeMessage` reports an override when the config exposes one.
- System/SystemDefaults settings are operator-owned and are never written by
  this picker.
- Provider-specific budget knobs are not mapped to the canonical ladder.
- The status line is split into three text runs for the click target. A visual
  check after rebasing on the selection-clipboard PR is required.
- A raw persistence error is surfaced as technical text and is not translated.

## Validation

- Unit tests cover segment exposure, toggle-only inertness, footer
  preselection, click vs drag selection, persistence through the same scope and
  call path as Ink, preservation of static provider/global knobs, Workspace vs
  User scope ownership, and failure notification.
- A PTY end-to-end run remains the manual check for clicking the footer tier,
  selecting a different tier, restarting the CLI, and reading the new tier
  back.
- `prettier`, `eslint`, and the CLI TypeScript build pass.

## Acceptance criteria

- Clicking the tier opens the picker; clicking any other status-line run does
  not.
- A drag selection that ends on the tier does not open the picker.
- Choosing a tier persists `model.reasoningEffort` to the same scope Ink uses.
  The footer keeps showing the effective tier, so when a static knob outranks
  the pick the displayed tier does not change.
- After a restart, the chosen tier is still in effect unless a user-configured
  static knob outranks it, exactly as with Ink's `/effort`.
- Provider/global static knobs and provider arrays are left byte-for-byte
  untouched.
- Ink output and interactions are unchanged.

## Follow-up

- If static override cleanup or an extra warning is desired, change `/effort`
  for both renderers in a separate, maintainer-approved change.
- Re-check footer selection copying after the selection-clipboard PR lands.
