# Daemon Session Runtime Status

## Problem

Daemon clients can poll a live session through `GET /session/:id/status` and
enumerate sessions through `GET /workspace/:id/sessions`, but the only runtime
activity signal today is `hasActivePrompt`. Clients cannot distinguish a turn
waiting for an ordinary permission, an `ask_user_question` response, or a
failed turn whose error should remain visible until work resumes.

## Design

The ACP bridge owns a small in-memory status extension on each live
`SessionEntry`:

- `hasTurnError` and `turnError` store the terminal error from the most recent
  failed turn.
- `pendingInteractions` maps pending permission request ids to normalized,
  render-ready permission actions or user questions.

The existing prompt lifecycle remains the source for `hasActivePrompt`. A
failed turn records its sanitized `message`, optional `code`, and optional
`errorKind` when it emits the existing `turn_error` SSE event. The error stays
visible until the next queued prompt reaches dispatch and actually starts; an
accepted but queued prompt does not clear it.

The ACP child explicitly tags `ask_user_question` permission requests in the
tool-call metadata. The bridge reads only that stable marker, rather than
inferring category from UI text or a tool name.

## API

The existing live summary gains optional additive fields:

- `isWaitingForPermission`
- `isWaitingForUserQuestion`
- `pendingInteractionCount`
- `hasTurnError`
- `turnError` (`message`, optional `code`, optional `errorKind`)
- `pendingInteractions`: action title/content/input and selectable options for
  permissions; questions and selectable options for `ask_user_question`. Each
  question carries an `answerKey` for the `answers: Record<string, string>`
  permission-vote payload.

`GET /session/:id/status` returns all fields for a live session. The workspace
session list carries the same runtime fields, including `turnError` and
`pendingInteractions`, for live entries so callers can render and approve
interactions directly while batch polling. Persisted sessions that are not live
omit the new fields so callers do not mistake an unavailable runtime state for
a known idle state.

## Scope

This does not persist runtime state across daemon restarts, add a new endpoint,
or replace SSE for detailed event consumption. The existing
`POST /session/:id/permission/:requestId` vote route resolves a pending item;
question answers use its existing `answers` extension.
