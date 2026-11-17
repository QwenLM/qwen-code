# TUI visual hierarchy

[English](tui-visual-hierarchy.md) | [简体中文](tui-visual-hierarchy.zh-CN.md)

## Problem and scope

The default CLI has useful compact tool groups and a virtual transcript, but
foreground colors carry most of its visual hierarchy. User prompts, code,
dialogs, and process summaries need consistent surfaces, spacing, and emphasis.
This change implements the approved priorities: color hierarchy, process
summaries, alignment, dialog consistency, and stable dynamic output. Composer
reorganization, a renderer migration, and changes to agent behavior are outside
this first phase. The follow-up [workspace layout design](tui-workspace-layout.md)
covers floating dialogs, bottom input placement, and cross-entry process
summaries. The implementation uses the current main checkout; no previous UI
worktree is a reference.

## Design

- Give Qwen Dark and Qwen Light neutral canvas, surface, and code colors, with
  readable primary and secondary text and restrained violet accents. Add
  optional `background.surface` and `background.code` semantic tokens. Existing
  themes and custom themes without these tokens retain transparent surfaces.
  `NO_COLOR` and screen-reader output remain unpainted.
- Transparent text retains the terminal's native foreground. Painted user
  messages use their theme's own foreground; code already has a paired
  foreground and background. Dialogs contain unstyled text, so their surface
  is painted only when the built-in theme matches the detected terminal
  polarity. This keeps the default dark theme readable on white terminals too.
- Paint user messages as a surface with normal foreground text. Paint fenced
  code consistently during streaming and after completion. Keep the same row
  count and content width so rendering and selection geometry remain aligned.
- Keep single-tool descriptions, but summarize multiple tools using localized
  category counts. Preserve canonical tool-group boundaries and all existing
  error, cancellation, approval, image, and full-detail expansion behavior.
- Keep compact summaries on one row. Put the active-tool hint in the same row,
  dim completed work, and reserve timer width before the timer becomes visible.
  Update the height estimator to match. OpenTUI shares summary semantics and
  keeps its existing live-tool rendering policy.
- Use a shared dialog frame for the model and theme pickers, with the existing
  padding budgets. Apply the same surface to permissions views without changing
  their input routing or permission semantics. Short model pickers omit their
  detail panel and vertical padding; narrow/short theme pickers hide the preview
  and window the list. Permissions tabs, search width, and list capacity adapt
  to the available columns and rows.
- Use the transcript's existing two-column outer gutter for the composer edge
  and suggestions. Recompute input widths from the actual available columns,
  retaining the current composer structure and keyboard behavior.

## Affected areas and constraints

Changes stay in `packages/cli/src/ui` and its focused tests. Theme construction
and custom-theme mapping populate the optional colors; Ink message/code/dialog
components consume them. OpenTUI maps message/dialog surfaces into its existing
palette; its native fenced-code presentation remains unchanged in this change.
Text selection, source-copy indices, history IDs, agent scheduling, terminal
protocols, and synchronized-output framing retain their existing ownership.
No new dependencies, setting, animation loop, or history aggregation layer is
needed. Narrow terminals must retain a visible input and navigable dialogs.

## Validation and acceptance

Compare the global `qwen` baseline with the local bundled CLI using isolated
runtime directories. Exercise a deterministic Chinese/English answer containing
fenced code, a multi-tool read/search group, theme/model/permissions dialogs,
window resize, and full-detail expansion. Cover dark, light, and `NO_COLOR`
output, a 40-column window, and a short terminal. Screenshots use Chrome Canary.
Verify the one-row compact height before and after tool completion and timer
appearance with focused tests; check that errors and approvals stay visible.
Run build, typecheck, bundle, focused tests, lint/format checks, and two clean
self-audit passes before the independent code review.

The result is acceptable when message and code surfaces are coherent, multiple
tools produce short localized summaries, changing hints/timers cannot add rows,
pickers share their frame treatment, and narrow/light/uncolored modes retain
their behavior. Dynamic verification records observed results rather than
claiming that static screenshots prove the absence of flicker.

## Risks and open questions

Background fill must not change measured heights or source-copy text. Theme
changes must invalidate rendered colors normally. ANSI/custom themes need safe
fallbacks when optional surface colors are absent. There are no blocking open
questions; broader cross-history aggregation and composer redesign remain
separate work.
