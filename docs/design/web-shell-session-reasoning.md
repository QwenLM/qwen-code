# Session reasoning in Web Shell

[English](web-shell-session-reasoning.md) | [简体中文](web-shell-session-reasoning.zh-CN.md)

## Behavior

In a recorded local workspace task, the chat thinking control and `/effort`
apply the same session selection. Choosing `high` enables thinking and uses
that tier. The selection survives switching models and reopening the task.
New tasks continue to use the configured defaults.

## Protocol and persistence

The daemon advertises `session_reasoning_persistence`. Native Web Shell uses
the capability for workspace tasks. The configuration request can set
`persistToSession: true` and a prompt can set
`_meta["qwenCode/persistSessionReasoning"]: true` to scope its effort command
to the task. Both requests use the same ACP configuration handler with model
capability checks and a required transcript write. The daemon reports a write
failure to the caller. The old shared-setting request remains available to
clients that use the existing `persist` option.

The selection is stored in the existing session model record and restored
with the session. A task created before this feature can record its first
selection after it is reopened. A selection that a different model does not
support is kept for compatible models. The independent terminal command and
embedded clients continue to use their existing behavior unless the client
opts in.

## Verification

Start with thinking disabled and set `high` from each entry point. Check the
configuration, the next model request, and the task after a daemon restart.
Repeat on a task created before the feature and compare the settings files and the next new task's effective thinking. Verify the
unsupported model and failed transcript write cases.
