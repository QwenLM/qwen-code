# Default model preferences for new Web Shell tasks

[English](web-shell-model-preferences.md) | [简体中文](web-shell-model-preferences.zh-CN.md)

## Behavior

The Model section gains a new-task preferences table sourced from the daemon's
conversation models. Each row has thinking, effort, and context controls
according to the model's capabilities. The context window field accepts a whole
token count from 1 up to the model's displayed limit. Typing updates the current
scope's draft, and an invalid value disables saving. On narrow panels,
each row stacks its controls below the model name. Turning thinking off keeps the
saved effort available for the next time thinking is enabled. The provider editor
retains its own window-limit operation.

The existing User and Workspace tabs each have their own draft, Save, and
Cancel. Each field shows its source and can return to its inherited value.
Workspace fields override user fields individually. Operator policy and model
defaults continue to apply. Saving publishes a settings change without
reconfiguring current tasks.

## Settings and session state

The workspace-bound daemon API serves the catalog, constraints, scoped values,
and their sources at `GET /workspace/model-preferences`. Its `PATCH` accepts
one scope and changed fields, with `null` used for inheritance. The daemon
validates the batch against the fresh catalog under its settings lock and
writes `model.preferences` in that scope. The daemon owns the route key from
auth type, model ID, and effective endpoint. The new `reasoning.enabled`
field is optional alongside `reasoning.effort` and `contextWindow`.

New recorded local daemon tasks capture the effective preferences at creation,
including when the preference map is empty. The task keeps that snapshot through
model switches and restoration. New task creation surfaces an error if the
daemon cannot save the snapshot. Older recordings without a snapshot use the
existing fallback. Chat reasoning controls, `/effort`, and a session-level
context editor are follow-ups.

Native Web Shell exposes the table on daemons that advertise support. An
embedding host can set `modelManagement.allowPreferences` after its initialization
and reset preserve both scopes of `model.preferences`. A host settings panel can then
use the same daemon API.

## Verification

With an empty preference map, create A at 200K with low effort. Save 128K and
high effort while A is responding, then create B. Check both tasks through
prompts, model switches, and a daemon restart. Cover field inheritance while
other preferences are present, effective endpoints including a proxy, force-on
and toggle-only model capabilities, and a rejected batch that leaves settings
intact.

In a browser, check token entry and the displayed limit on desktop and on a
narrow touch viewport. Verify that out-of-range values stay in the field and
that saving a valid count or resetting inheritance uses the active scope.
