# Focus mode

[English](focus-mode.md) | [简体中文](focus-mode.zh-CN.md)

## Problem and current state

Compact tool rendering still leaves tool groups and reasoning in the main
transcript. Focus mode provides a persistent, optional reading view that hides
reasoning and summarizes completed tool groups, while retaining the original
history for the full transcript and exports.

## Design

The interactive Ink and OpenTUI UIs expose `/focus` and the boolean `ui.focusMode` setting,
disabled by default. A provider supplies the current state to history rows and
the toggle action to the slash-command processor. Command changes persist at
User scope unless an active workspace or system override controls the setting.
In that case, `/focus` warns without changing the saved User preference. An
untrusted workspace setting does not override the User preference. Settings-dialog
changes and command changes must agree at runtime. The effective merged setting
remains authoritative. Failed command writes preserve both
the previous in-memory setting and the displayed view. Restoring defaults in
the settings dialog updates the view just like an ordinary toggle. The app also
synchronizes the provider when `/config` changes the effective setting.

History rendering hides thought headers and thought continuation rows in focus
mode. A committed, nonempty tool group becomes one translated summary line only
when all tools succeeded, failed or were cancelled, the group was not user initiated, and no tool
contains a subagent execution result, inline images, or omitted-image metadata.
Single tools retain their display name and a bounded file identity when available.
Groups retain counts and identify failed tools without raw commands or output.
Memory read/write counters remain on the same summary line. Running and
confirmation-waiting tools remain visible. User messages and assistant answers are
unchanged.

Ctrl+O uses `fullDetail` and displays the original thoughts and tool groups.
Full detail takes precedence over focus: enabling focus while details are expanded
changes the preference. Press Ctrl+O again to re-apply focus. Session previews
opt out of Focus only, preserving their existing grouping and height limits.
Toggling the reading view must redraw existing history, including the legacy
Ink static-history renderer. The virtual viewport keeps ownership of its screen
and uses the existing refresh mechanism.

## Affected areas

- CLI settings schema and translated UI strings.
- Interactive provider composition, command registration, and command context.
- History-item rendering and transcript refresh.
- Daemon workspace-settings filtering for the TUI-only preference.
- Collocated command, provider, and rendering tests, plus interactive checks.

## Scope boundaries

This MVP changes presentation only. It does not alter prompts, model output,
tool execution, stored history, or exports. Rich turn-level summaries, a new
keyboard shortcut, and model instructions to reduce narration are follow-ups.
The web renderer is outside this feature; it must not advertise a working focus
toggle without implementing its presentation.
The existing TUI-only settings filter excludes focus from both the legacy
primary and selected-runtime workspace settings routes. Their trust, runtime
ownership, and failure behavior are unchanged.

## Verification

The local E2E plan covers toggling existing history, restart persistence,
settings changes, full-detail escape, and visibility of exceptional tool states.
Unit tests exercise these invariants directly. Build, typecheck, localization,
lint, bundle, and the repository preflight provide release checks.

## OpenTUI parity and maintainer review

Both terminal renderers reuse the React Focus provider for persistence and scope
precedence. OpenTUI wires its command context and settings dialog to the same
actions. Its Ctrl+O state is transient and affects presentation only, including
already committed rows and expanded reasoning/results.

A renderer-neutral helper owns compact tool identity and eligibility. Ink adapts
tool groups; OpenTUI adapts tool cards. These renderers need not share layout code.
OpenTUI's event producers and history fold retain the presentation metadata needed
to exempt user-initiated commands, subagent results and images. Resume preserves
tool arguments needed to identify files. Filtering never removes stored items.

Affected files include HistoryItemDisplay, SessionPreview, the Focus command and
locales, plus OpenTUI bootstrap, command wiring, settings mount, transcript,
event adapters and history fold. The daemon workspace-settings route adds focus
to its TUI-only filter for both legacy-primary and selected-runtime requests.
Collocated tests cover each boundary. Authentication, model selection, tool
execution and daemon route ownership are unchanged.

The five maintainer recommendations are accepted: identity-preserving summaries,
native OpenTUI support, accurate Ctrl+O wording, compact terminal cancellations,
and a preview-specific Focus bypass. OpenTUI support does not remove Ink or change
the user's selected renderer.

## Open questions

Upstream maintainers can decide whether a later iteration should aggregate
whole turns or also influence model narration. Neither decision blocks this
presentation-only MVP.
