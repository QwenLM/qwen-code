# Model defaults in Web Shell settings

[English](web-shell-model-preferences.md) | [简体中文](web-shell-model-preferences.zh-CN.md)

## Behavior

Settings → Models lets users set thinking, effort, and context window defaults for each model. The daemon supplies the conversation model catalog and each model's supported controls. The context window is a whole number of tokens within the displayed model limit. Thinking off keeps the selected effort for when thinking is enabled again.

User and Workspace settings have separate drafts. Workspace fields override User fields individually and can return to their inherited value. Save validates the entire batch before writing the changed fields. A failed save keeps the draft.

## Daemon and settings

The workspace-bound preferences API stores values in `model.preferences` and returns effective values, field sources, and model limits. It reuses the model route identity derived from auth type, model ID, and effective endpoint. Preferences use `contextWindow`, `reasoning.effort`, and an optional `reasoning.enabled`. The provider editor continues to own the provider's window limit.

The daemon resolves the defaults for the task's selected model when creating or restoring a task, switching models, and before the next turn after a save. Idle tasks read the new defaults when the save takes effect. An in-flight turn uses the settings it started with. A task with an explicit override already recognized by the daemon keeps that override. Restored tasks read current settings from disk. The defaults update leaves the current model selection in place.

## Delivery scope

This change ships the settings panel in native Web Shell. DataAgent can connect its settings panel to the same API when its initialization and reset preserve both settings scopes. Changes to the conversation picker and the `/effort` command belong to an independent change.

## Verification

Start a task with a 200K window and low effort. While its request is in flight, save 128K and high effort, then verify both that task's next request and a new task's request. Verify that an idle task follows the new defaults, model selection survives a save, and reopening a recorded task after a daemon restart uses the saved values. Compare actual provider requests and the daemon context limit. Cover field inheritance and batch validation in separate workspaces, and verify numeric entry on desktop and a narrow browser viewport.
