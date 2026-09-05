# Telemetry session ownership

## Problem

The CLI initializes telemetry once per process. That process-global session is
safe for an interactive CLI, but a daemon can host multiple sessions. Native
LLM spans created outside an interaction currently fall back to the bootstrap
session, even though `LoggingContentGenerator` owns the `Config` for the
session that issued the request. API log spans use that `Config`, so one model
request can be split across two sessions.

## Ownership

An existing native logical parent owns its descendants. Without one, the
`Config` owned by `LoggingContentGenerator` is authoritative. The resolved
session is carried in an OpenTelemetry `Context` so automatic HTTP spans and
log records created during the request inherit the same identity.

Session resolution uses this order:

1. Native interaction, subagent, or tool parent.
2. Explicit session from the owning `Config`.
3. Session stored in the active OpenTelemetry `Context`.
4. The existing per-request session `AsyncLocalStorage`.
5. The process-global session, for single-session compatibility.

The OpenTelemetry context key is private and is not baggage, so it is not
serialized onto outbound requests. A streaming request snapshots its resolved
session when the LLM span starts, uses the same snapshot for API log records,
and reactivates that context for every stream iteration. A later `Config`
session change therefore cannot split an in-flight request across sessions.

## Boundaries

This change fixes session ownership only. It does not add AgentLoop entry or
step spans, turn or react-round attributes, resource-level session identity,
or any wire, storage, or daemon API changes.
