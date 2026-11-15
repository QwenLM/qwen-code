# Session-targeted Skill and Extension Refresh

[English](session-targeted-refresh.md) | [简体中文](session-targeted-refresh.zh-CN.md)

## Problem and current behavior

Extension REST refresh selects a workspace runtime but refreshes all its live sessions. Skill refresh exists as an ACP workspace command and also refreshes all sessions. Skill toggles and automatic reconciliation own their existing refresh behavior. Callers need an explicit refresh operation that can select sessions without changing those existing callers.

## Contract and scope

Explicit refresh accepts optional `sessionIds`. Omission preserves full refresh. A supplied array selects only those live sessions, deduplicated in request order; `[]` selects no sessions. Invalid shapes return HTTP 400. Unknown IDs, including sessions belonging to another workspace, return HTTP 404 before refresh begins. IDs are resolved only by the selected runtime's bridge; no primary-runtime fallback is allowed.

Add `POST /workspace/skills/refresh` (legacy-primary) and `POST /workspaces/:workspace/skills/refresh` (selected-runtime). Both return the existing Skill refresh counts and use `reason: all`. Existing Extension refresh routes retain their synchronous or asynchronous response contracts. They accept the same optional field. All routes retain strict mutation, trust and client-identity checks.

Advertise `workspace_session_refresh` for the new Skill routes and session selection on Extension refresh. SDK methods check this capability before sending a selected refresh, so an older daemon cannot silently discard the filter and refresh everything. Existing Extension SDK calls retain their arguments and request behavior; the optional selection is an additional argument. New Skill SDK methods expose explicit refresh.

## Implementation by layer

REST validates request shape and session ownership before submitting work. Workspace services and the Extension operation controller pass the selection through. The Extension bridge filters its session entries before its existing bootstrap deduplication, per-session refresh, retry and event handling. Counts describe the selected sessions; workspace events remain workspace-wide notifications. Ownership is checked at HTTP admission. If a selected Extension session closes while queued, execution counts it as failed and continues refreshing the surviving selections. Present non-object JSON bodies are rejected before any refresh.

The Skill ACP command accepts `sessionIds` and validates all selected local sessions before reloading settings or caches. When the bridge receives a selected Skill refresh, it groups selected sessions by their owner channel and invokes the command only on those channels. It bypasses the normal workspace-change broadcast, which would otherwise refresh unrelated execution engines. The omitted-field path remains unchanged. Channel result counts are combined, and failures count against that channel's selected sessions.

Selected refresh may update shared bootstrap/catalog caches used by a targeted channel. Selection controls immediate session refresh and command notifications; it does not create session-scoped activation policy or freeze shared configuration.

## Reconciliation and compatibility

An Extension operation with `sessionIds` never advances the runtime-wide applied generation, even when the supplied list happens to cover every current session. The existing full generation reconciler remains unchanged and may subsequently refresh other sessions. Skill coordinator revision and readiness are not updated by this explicit request; automatic reconciliation continues to cover its entire runtime.

Web Shell, Skill enable/disable requests, install/delete operations and automatic refresh callers are unchanged. This change does not add `refreshRuntime` to HTTP toggle bodies and does not decouple legacy Skill toggles.

## Affected components

- CLI refresh routes, shared request validation, workspace service and Extension operation controller.
- ACP bridge refresh selection and Skill owner-channel routing.
- ACP Skill refresh handler.
- TypeScript daemon SDK, capability registry and daemon protocol documentation.
- Focused route, bridge, ACP and SDK tests.

## Validation and acceptance criteria

- Omitting `sessionIds` preserves full refresh and existing response contracts.
- Selecting one of multiple sessions refreshes only that session, including across execution engines.
- Duplicate IDs refresh once; `[]` performs no session or bootstrap refresh.
- Malformed and unknown/foreign IDs cause no refresh side effects.
- Partial Extension refresh does not advance workspace applied generation.
- Existing bootstrap deduplication, failure accounting and reconciliation tests remain green.
- SDK serialization and capability checks prevent selected refresh against older daemons.
- Build, typecheck, focused unit tests, baseline/local daemon HTTP checks and two clean self-audit passes complete.

## Open questions

None. Selection affects explicit refresh only; existing activation and automatic reconciliation behavior remain in scope for regression verification only.
