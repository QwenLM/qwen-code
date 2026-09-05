# Focus mode

## Problem and current state

Compact tool rendering still leaves tool groups and reasoning in the main
transcript. Focus mode provides a persistent, optional reading view that hides
reasoning and summarizes successful tool groups, while retaining the original
history for the full transcript and exports.

## Design

The interactive Ink UI exposes `/focus` and the boolean `ui.focusMode` setting,
disabled by default. A provider supplies the current state to history rows and
the toggle action to the slash-command processor. Changes persist at User
scope. Settings-dialog changes and command changes must agree at runtime.
The effective merged setting remains authoritative: a workspace override takes
precedence over the saved User preference. Failed command writes preserve both
the previous in-memory setting and the displayed view. Restoring defaults in
the settings dialog updates the view just like an ordinary toggle. The app also
synchronizes the provider when `/config` changes the effective setting.

History rendering hides thought headers and thought continuation rows in focus
mode. A committed, nonempty tool group becomes one translated summary line only
when all tools succeeded, the group was not user initiated, and no tool contains
a subagent execution result. Running, cancelled, failed, and confirmation-waiting
tools remain visible. User messages and assistant answers are unchanged.

Ctrl+O uses `fullDetail` and displays the original thoughts and tool groups.
Toggling the reading view must redraw existing history, including the legacy
Ink static-history renderer. The virtual viewport keeps ownership of its screen
and uses the existing refresh mechanism.

## Affected areas

- CLI settings schema and translated UI strings.
- Interactive provider composition, command registration, and command context.
- History-item rendering and transcript refresh.
- Collocated command, provider, and rendering tests, plus interactive checks.

## Scope boundaries

This MVP changes presentation only. It does not alter prompts, model output,
tool execution, stored history, or exports. Rich turn-level summaries, a new
keyboard shortcut, and model instructions to reduce narration are follow-ups.
The separate OpenTUI and web renderers are outside this MVP; they must not
advertise a working focus toggle without implementing its presentation.
The existing TUI-only settings filter excludes focus from both the legacy
primary and selected-runtime workspace settings routes. Their trust, runtime
ownership, and failure behavior are unchanged.

## Verification

The local E2E plan covers toggling existing history, restart persistence,
settings changes, full-detail escape, and visibility of exceptional tool states.
Unit tests exercise these invariants directly. Build, typecheck, localization,
lint, bundle, and the repository preflight provide release checks.

## Open questions

Upstream maintainers can decide whether a later iteration should aggregate
whole turns or also influence model narration. Neither decision blocks this
presentation-only MVP.
