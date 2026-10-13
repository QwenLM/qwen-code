# Session prompt regeneration metadata

[English](session-prompt-regeneration-metadata.md) | [简体中文](session-prompt-regeneration-metadata.zh-CN.md)

Status: code implemented; automated checks and runtime validation are not complete.

## Problem

Regenerating by appending a prompt leaves two canonical turns after refresh.
Local answer-version state has no durable relationship. Text-block `_meta` is
not persisted; rewind removes old turns from active replay, and branch creates
another session.

## Contract

Pre-flight `session_prompt_regenerate_of` in `/capabilities.features`. A normal
Prompt may carry top-level `_meta["qwen.regenerateOf"]` with the original daemon
prompt UUID, restored on original user chunks as `_meta.promptId`. It is not a
`session########n` file-history ID. Malformed values are ignored.

Bridge echoes preserve the marker. Session recording stores
`UserPromptRecordPayload.regenerateOf`; replay validates it again and restores
`user_message_chunk._meta["qwen.regenerateOf"]`. Existing SDK metadata passthrough
retains it. The regular daemon advertises this capability; the hosted persona
does not. Existing owner-routed session capability proxies retain the tag.

The marker is UI-only: both turns stay appended, with model content/history and
authorization unchanged. Renderers resolve only explicit relationships to known
turns in the same session. No new route or secondary storage is added.

## Release and validation

Upgrade the runtime before enabling the client affordance; disable regeneration
when the feature is absent after rollback. Existing unmarked history remains
separate, even when text matches. Client grouping/selection, model-history
branching and resource-link expansion are outside this daemon change.

Focused tests cover invalid markers, model input, journal persistence, live
cross-client echo, replay with resource links, SDK preservation and capability
advertising. Restart/replay and consuming-UI acceptance remain pending; the short
E2E plan is `.qwen/e2e-tests/session-prompt-regeneration-metadata.md`.
