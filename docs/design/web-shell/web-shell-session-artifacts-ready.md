# Web Shell session-artifacts-ready callback

## Goal

Let an embedding host receive a stable, turn-correlated session artifact
snapshot after restoration and completed turns without polling daemon artifact
APIs or racing Web Shell's transcript and artifact refreshes.

## Design

Add an optional `onSessionArtifactsReady(snapshot)` prop to `WebShell`. The
callback receives the complete visible artifact list plus the same
turn-correlation map used by Web Shell. A `restore` snapshot is delivered after
the initial artifact load and transcript restoration settle. A `turn_complete`
snapshot is delivered after the completed turn's final artifact refresh and
includes the captured user turn ID.

Failed artifact loads do not emit a ready snapshot. Session ownership and
request guards prevent stale asynchronous loads from a previous session from
being delivered to the active host.

This callback reports lifecycle readiness only. It does not add continuous
artifact-change notifications or an imperative artifact query API.
