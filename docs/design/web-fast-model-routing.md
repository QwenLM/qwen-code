# Web Shell fast-model routing

[English](web-fast-model-routing.md) | [简体中文](web-fast-model-routing.zh-CN.md)

## Problem and scope

The Web Shell fast-model picker discards its ACP route ID and submits a bare model name. Providers sharing that name therefore cannot be selected by endpoint. Reopening a pinned selection also discards the endpoint and can highlight another row. This change addresses #12814 without changing advisor consultation behavior or adding model configuration fields.

## Decision

Keep the existing model list and submit its ACP ID unchanged. Resolve registered rows on the server with the existing ACP routing helpers, then persist `authType:id\0<registryBaseUrl>`. Preserve an explicit empty suffix when the selected row has no declared endpoint; Qwen OAuth keeps `authType:id`.

Live sessions retain `/model --fast` so the runtime configuration changes immediately. Standalone settings writes resolve against the settings registry of their own workspace. The legacy-primary route uses its bound workspace and trust flag; the qualified route uses the resolved trusted runtime's workspace. Neither path loads another session's runtime snapshots or falls back to the primary runtime. Ordinary bare and auth-qualified selectors keep their existing behavior. Unknown ACP routes and runtime snapshots fail without a write.

For readback, reuse provider-status metadata and load it while the fast picker is open: restored session rows omit endpoint metadata. Match the stored public selector against the model name, auth type, and public endpoint. Highlight only a unique match. If the pin is missing or public redaction makes it ambiguous, leave the picker unselected until the user chooses a row. Public endpoint matching is only for display; it never reconstructs a routing selector. Command responses retain the submitted ACP ID, and settings responses use the existing selector scrubber.

## Constraints and follow-ups

This does not add fast-only models to the existing ACP list. Credential-bearing workspace persistence remains the class-wide policy tracked in #12856 and its existing follow-up PR. Public values cannot distinguish endpoints that differ only in hidden credentials, or identify an implicit endpoint among multiple same-name routes, so those readbacks intentionally have no selected row.

## Acceptance

- Selecting the second of two same-name endpoints persists that endpoint and updates a live session without restart.
- Reopening the picker selects that same row; unknown or ambiguous pins cannot be silently replaced by pressing Enter.
- User and Workspace selections retain their chosen scope, including standalone settings writes.
- Invalid ACP routes do not write settings, and raw endpoint credentials do not enter command messages or settings responses.
- Focused server and UI regressions, build, typecheck, and browser before/after evidence verify these behaviors. Browser mock-daemon evidence verifies UI and payloads; server tests verify private selector persistence and runtime updates.
