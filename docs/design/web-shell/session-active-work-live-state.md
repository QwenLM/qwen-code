# Session active-work live state

## Problem

The workspace session snapshot exposes only foreground prompt activity. Once a
prompt launches background work and settles, the sidebar cannot distinguish the
still-working Session from an idle one even though the bridge already tracks
per-session active-work holds.

## Contract

Add one optional `activeWorkState` field to session summaries and workspace
live-state rows:

- `active`: daemon-owned work exists or a fresh child snapshot contains a hold;
- `idle`: a fresh child snapshot covers every required category and is empty;
- `unknown`: reporting was negotiated but is stale or incomplete;
- `unsupported`: the child did not negotiate active-work reporting.

`hasActivePrompt` keeps its running-foreground-turn meaning. The Web Shell
renders `activeWorkState: active` separately when no foreground prompt is
running; this state can represent queued prompt work as well as background
work.

The floating Todo panel animates an `in_progress` item only while the local
stream, daemon foreground state, or per-session active-work state confirms
that execution is live. A persisted `in_progress` value without live activity
keeps its static status glyph instead of implying that work is still running.

The field is optional for compatibility with older daemons. It uses the
bridge's existing hold cache, capability negotiation, and freshness window, so
the live-state request remains an in-memory read with no ACP round trip.

## Scope

This change exposes known liveness and does not add task persistence, route
rebinding, or cross-runtime recovery. Those require a reproduced routing loss,
not only an idle-looking UI.
