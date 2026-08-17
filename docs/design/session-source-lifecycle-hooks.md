# Session source in lifecycle hooks

## Context

Daemon session creation already forwards optional `sourceType` and `sourceId`
values to ACP in `_meta['qwen.session.source']`. The ACP runtime currently uses
the source type to disable native cron for channel sessions, but lifecycle hook
payloads cannot observe either value. Receivers therefore cannot attribute a
new session when `SessionStart` fires before the bridge persists its source.

## Design

Parse the existing source metadata once at the ACP session boundary. Store the
two optional strings on the session's `Config`, alongside the session id and
other session-scoped state, and expose read-only getters.

The hook event handler adds present source values to its common input:

- `sourceType` becomes `source_type`.
- `sourceId` becomes `source_id`.

Conditional object spreads omit absent values instead of serializing empty or
undefined fields. Because every lifecycle event uses the common input builder,
`SessionStart`, `UserPromptSubmit`, `Stop`, and `SessionEnd` receive the same
attribution without event-specific wiring.

## Boundaries

This is a read-through of existing creation metadata. It does not change the
REST create request, ACP bridge metadata key, capability negotiation, session
persistence, or resume behavior. A session created without source metadata
keeps the previous hook payload shape.

## Verification

- Hook handler tests cover present and absent source fields on
  `SessionStart` payloads.
- ACP session tests cover propagation of channel source metadata into the
  session `Config`.
- Existing channel worker tests continue to cover creation metadata, including
  the channel instance name as `sourceId`.
