# Web Shell composer and context readability

[English](2026-09-10-web-shell-composer-context.md) | [简体中文](2026-09-10-web-shell-composer-context.zh-CN.md)

## Problem and scope

The composer reserves 140px even for an empty prompt. Its context ring requires
hovering to read the occupancy. The context sidebar places every name and token
value on separate lines and expands every tool, memory, and skill detail, making
the overview difficult to scan.

This change improves the existing Web Shell presentation. It does not change
prompt submission, context accounting, API routes, session ownership, polling,
or public customization options.

## Design

- Reduce the default composer minimum height to 116px and show a subtle focus
  border while the editor or its toolbar popup is active. Escape restores the
  popup trigger focus; choosing an insertion keeps its existing focus action.
  Preserve automatic growth, existing maximum heights, attachment
  scrolling, and host CSS variables.
- Show the context percentage beside the existing ring when the composer is
  wider than 520px. Narrow composers keep the ring and its accessible label and
  tooltip. Both parts invoke the existing context action (`/context`). Warning
  and error percentages use the same severity as the ring. Unavailable split
  panes suppress stale counts and their unavailable context action.
- Replace the one-line hover text with a structured tooltip showing occupancy,
  a proportional meter, used tokens, the context-window size, and a localized
  hint that clicking displays usage in the conversation. Hover uses existing
  local counters without fetching context or creating a transcript message.
  Assistive technology receives a concise localized used/window description.
- Keep the sidebar overview visible. Align category and detail values to the
  right, allow long names to wrap, and keep token numbers readable.
- Make tool, memory, and skill detail groups native disclosures in compact mode,
  initially collapsed, with item counts. Keyboard activation reveals the same
  complete, sorted details. Transcript detail groups start expanded and can
  also be collapsed. Activating a native summary pauses transcript bottom
  following so expanding details preserves the reading position.
- Render transcript cards with the same proportional meter, responsive columns,
  and complete wrapping names in the interface sans-serif font. Show occupancy
  beside the title; only transcript cards add a named region landmark. A localized
  "View details" button invokes the existing `/context detail` action; read-only
  renderers without a callback retain the command hint. Explicit name length
  overrides remain supported; the default no longer truncates names.

Reuse existing CSS Modules and theme variables. Native details/summary provide
keyboard interaction without adding a dependency or custom disclosure state.
Keep estimated, unavailable, loading, retry, and over-limit states intact.

## Affected files

`ChatEditor.tsx`, `ChatEditor.module.css`, `ContextUsageMessage.tsx`, and
`ContextUsageMessage.module.css`, the pane availability guard, transcript follow
guard, add menu focus handling, localization, plus focused tests and browser
tests under `packages/web-shell/client/`.

## Validation and acceptance

Dry-run with the globally installed `qwen` before editing, then verify the local
build. Check empty and multiline prompts, capped scrolling, attachment layout,
desktop and touch submission, wide/narrow toolbars, and light/dark presentation.
Check disclosure activation, counts, complete long names, sorted token values,
estimated and over-limit readings, hover/focus without requests, and clicking
the ring followed by "View details". Read-only rendering retains the command
hint; explicit detail requests start expanded. Test narrow transcript cards in
both themes. Pin 520/521px composer widths, actual theme colors, keyboard ring
access, menu focus, and alignment on wrapped rows. Tag the focused browser
coverage for the PR smoke lane.
Run build, typecheck, bundle, focused unit and browser tests, then review the
complete diff. Browser fixtures may supply deterministic context readings;
report separately from live daemon verification.

## Risks and open questions

The percentage adds toolbar width; its container breakpoint and existing
measurement logic must preserve access to send and model controls. Long context
names must wrap without forcing horizontal scrolling. No open design questions
remain for this bounded layout improvement.
