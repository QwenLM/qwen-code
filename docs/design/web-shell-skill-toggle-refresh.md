# Web Shell Skill Toggle Refresh

## Context

Skill toggle requests can emit two `settings_changed` events for one persisted
change. The daemon metadata added by #9051 gives both events the same mutation
id and reports whether live-session activation was applied, deferred, or
partial.

Web Shell currently keeps a session-less `/workspace/skills` snapshot for the
composer. Once loaded, that snapshot overrides the active session's
`available_commands_update`, so a disabled Skill can remain in autocomplete.
The generic workspace settings signal also drops the mutation metadata and
cannot de-duplicate the two events.

## Design

The daemon React SDK exposes the latest Skill toggle mutation separately from
the generic settings version. Valid Skill toggle mutations do not increment the
generic settings signal, and consecutive events with the same mutation id
increment the Skill signal once. Events without valid mutation metadata retain
the existing settings behavior.

With an active session, Web Shell treats `available_commands_update` as the
authoritative command and Skill snapshot. Without a session, it refreshes and
uses `/workspace/skills`. A deferred or partial activation also refreshes that
workspace snapshot and temporarily uses it for the affected active session; a
failed refresh is surfaced to the user.

## Verification

- An active-session command update can add a Skill and replace the last Skill
  with an empty list without a workspace snapshot reload.
- A deferred pre-session mutation reloads `/workspace/skills` once.
- Duplicate settings events with one mutation id produce one Skill signal.
- A partial activation refreshes and uses the workspace snapshot.
- Unrelated and legacy settings events continue incrementing the generic
  settings signal.
