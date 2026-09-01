# Web Shell Session Artifact Snapshots

## Status

This design supersedes the assistant-turn settlement proposal in PR #10398.
Artifact delivery is session state, not assistant-turn settlement. It must not
depend on prompt status, terminal events, transcript repair, or a settlement
ledger.

## Requirements

Embedding hosts need an optional `onSessionArtifactsChange` callback with the
complete Artifact state for the current session. Delivery is eventually
consistent, but an SSE gap or Artifact/transcript arrival order must not hide
an Artifact.

```ts
interface WebShellSessionArtifactsChange {
  reason: 'restore' | 'change';
  sessionId: string;
  sequence: number;
  artifacts: readonly DaemonSessionArtifact[];
  artifactsByTurn: ReadonlyMap<string, readonly DaemonSessionArtifact[]>;
}
```

`restore` is the first hydrated snapshot for a newly entered session after its
transcript is ready, and may be empty. `change` represents an
`artifact_changed` refresh, different same-session reconnect reconciliation,
or later turn-projection change. A real change takes precedence over an
undelivered restore.

`sequence` starts at 1 for each newly entered session. Payloads are complete
replacements, not incremental patches.

## Design

### Artifact hydration and reconciliation

The existing Artifact hook remains the sole snapshot owner. It will:

1. hydrate once for a connected, supported, non-catch-up session;
2. refresh whenever `artifactsVersion` changes;
3. reconcile after reconnect or catch-up;
4. preserve last-good state across a short disconnect;
5. discard stale request generations and session owners; and
6. allow later events or reconnects to recover failed hydration.

Prompt status is not an Artifact trigger. The provider's existing version
counter becomes session-scoped only for Artifact events; its workspace
counters retain their current ownership. No route, event payload, transcript
repair, timer, or settlement state is added.

### Host delivery

A small hook observes the hydrated snapshot and complete turn projection. It
keeps a pending reason, delivered signature, per-session sequence, last
Artifact ids, and observed `artifactsVersion`.

Delivery waits until connected and transcript load/catch-up has ended. The
signature canonically includes every enumerable Artifact field and turn
assignment, including future fields and projection changes.

Live Artifacts wait for a missing tool projection without advancing baseline.
Reconnect/catch-up reconciliation delivers the authoritative snapshot even
when the retained transcript lacks that projection.

Identical snapshots are suppressed. Listener exceptions are reported without
changing built-in Artifact UI state.

### Session ownership

A session-id change resets signature and sequence. Same-id owner replacement
preserves both while stale loads remain guarded by owner/request generation.
Reconnect reconciliation emits `change` only for a different full snapshot.

## Scope

Non-goals are incremental payloads, IDE concepts, Split View aggregation,
live-journal or prompt-settlement changes, new routes or event schemas, and
compatibility wrappers for the unpublished settlement callback.

## Test plan

- **TC-01:** Initial empty and historical sessions deliver `restore`.
- **TC-02:** An initially empty session's first Artifact delivers `change`.
- **TC-03:** An Artifact waits for its tool-block projection before delivery.
- **TC-04:** Metadata, projection, and consecutive changes deliver complete
  snapshots; canonical duplicates do not.
- **TC-05:** Reconnect/catch-up finds missed changes without a second restore.
- **TC-06:** Workspace, standalone, and live Artifact events increment the same
  version while other counters remain workspace-scoped.
- **TC-07:** Late loads, failed refreshes, and throwing listeners stay isolated.
- **TC-08:** No prompt/terminal state is used; Artifact rendering remains green.

## Budget and stop conditions

Expected change: about 280 production, 450 test, and 170 documentation lines.
The hard stop is 300 production lines, 900 total additions, or any need to
modify live-journal repair, prompt settlement, daemon routes, or event schemas.
