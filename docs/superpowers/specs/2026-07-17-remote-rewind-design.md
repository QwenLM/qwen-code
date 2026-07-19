# Remote rewind + branch-from-past-turn — design (2026-07-17)

Extend rc-gateway so remote clients can rewind a running session to a
previous turn, and branch/fork from any historical turn (not just the
tip). Approved approach: **A — gateway rewind route + SDK proxy +
append-only WAL marker** (chosen over B: gateway-side truncation, and
C: rewind-as-self-fork; see Alternatives).

Spec-first: ships as the 21st OpenSpec change, `add-remote-rewind`,
in qwen-code-remote, registering the new SSE event and audit action in
the authoritative registries.

## What already exists (not rebuilt)

- **Local CLI**: `/rewind` (interactive turn rewind via
  `session.rewindToTurn` + `ChatRecordingService.rewindRecording`),
  `/branch` (fork current tip into a new session), `/restore`
  (tool-call file checkpoints). `ChatRecordingService` keeps a
  uuid/parentUuid tree with `forkedFrom` lineage.
- **Daemon (ACP)**: already exposes a `rewindSession` method
  (`case 'rewindSession'` → `session.rewindToTurn(targetTurnIndex)`),
  which truncates history, strips thoughts, and computes the API
  truncation index. The gateway proxies this; it does NOT reimplement
  rewind.
- **rc-gateway**: session **forking** (`POST /session/:id/fork`) with
  `fromEventId` slicing already delivers non-destructive
  branch-from-a-past-point remotely; lineage endpoints exist. The
  durable WAL + `replay_truncated` 412 machinery exists.

## The gap this closes

1. **Remote rewind** — the gateway can fork but cannot rewind a live
   session in place. Rewind is destructive to a shared session; fork
   is not. No rewind route, no SDK method, no SSE event.
2. **Turn-addressed branching** — fork slices by `fromEventId` (a WAL
   event id), but clients think in _turns_ (user messages). Adding
   `fromTurn` via a shared resolver makes branch-from-past-turn
   ergonomic and consistent with rewind.

## Scope decisions (user-confirmed)

- **Broadcast truncation, all re-sync**: on rewind of a shared
  session, the gateway appends a `session_rewound` marker to the WAL;
  every attached client truncates its rendered view to the target
  turn and continues on the rewound timeline. One shared timeline;
  WAL stays append-only (matches the `session_forked` pattern). Owner
  scope required to rewind.

## Architecture

All new surface on the gateway (transparent-proxy topology).

### SDK (`@qwen-code/sdk`)

`DaemonClient.rewindSession(sessionId, { toTurn }) → { targetTurnIndex,
apiTruncateIndex }` — proxies the daemon's existing ACP `rewindSession`
method. New method + its ACP request mapping.

### Gateway control plane

| Endpoint                                                             | Scope    | Behavior                                                                                                                                                                    |
| -------------------------------------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /session/:id/rewind` `{ toTurn }`                              | `owner`  | Resolve `toTurn` → daemon `targetTurnIndex` + WAL `truncatedEventId`; call `daemon.rewindSession`; append `session_rewound` WAL marker; `202 { toTurn, truncatedEventId }`. |
| `POST /session/:id/fork` `{ fromTurn \| fromEventId, ... }` (modify) | existing | Accept `fromTurn` as an alternative to `fromEventId`, resolved by the same turn resolver. Mutually exclusive.                                                               |

Rewind error codes: `409 rewind_in_progress` (prompt running),
`409 rewind_not_applicable` (turn compressed away / beyond tip),
`400 invalid_turn` (malformed/negative). Fork: `400 mutually_exclusive`
if both `fromTurn` and `fromEventId` supplied.

### Observation / SSE

New event `session_rewound`, registered in the wire-protocol SSE
registry:

```jsonc
session_rewound — data: {
  toTurn, truncatedEventId, rewoundByTokenId, rewoundAt
}
```

Emitted on the session's own stream. Attached clients truncate their
rendered view to `toTurn` and continue. The WAL stays append-only: the
marker is a normal event with the next id; a late client replaying
across it applies the truncation and renders the target turn as tip.

### Notifications

`session.rewound` is a routable notification kind through the existing
routing rules. It does **not** bypass quiet hours.

### Audit

`session_rewound` action, recorded `{ sessionId, toTurn,
truncatedEventId, actorTokenId }` (pairing-auth extension registry).

## Components

New code in `packages/rc-gateway/src/`, mirroring the fork layout.

### `sessions/turnResolver.ts`

The shared exact unit both rewind and turn-addressed fork depend on. A
"turn" is a user message; the WAL and daemon index differently, so the
mapping lives here alone.

`resolveTurn(records, toTurn) → { targetTurnIndex, truncatedEventId }
| { error }`:

- Walks the session's persisted records (same source the fork route
  reads via `readParentRecords`), counts user-message turns.
- Returns both coordinates: `targetTurnIndex` for the daemon's ACP
  rewind, and the WAL `truncatedEventId` boundary (the event id of the
  first record dropped) for the marker payload.
- Rejects with a typed error: negative/non-integer turn
  (`invalid_turn`), turn beyond the last (`rewind_not_applicable`),
  turn inside a compression checkpoint (`rewind_not_applicable`).
- Pure function, exhaustively unit-tested — the off-by-one hazard
  lives and dies here.

### `routes/rewind.ts`

`createRewindRoute(deps)` handler factory, mounted with
`requireScope(OWNER)` in server.ts (like the agent routes). Saga:

1. Guard: `409 rewind_in_progress` if the session has an in-flight
   prompt (query the prompt-queue / broadcaster state the gateway
   already tracks).
2. Read records → `resolveTurn`; map error → 4xx.
3. `await daemon.rewindSession(id, { toTurn })`.
4. Append `session_rewound` to the session `SessionWal` (next id) with
   `{ toTurn, truncatedEventId, rewoundByTokenId, rewoundAt }`.
5. Audit row + hand `session.rewound` to the notification router.
6. `202 { toTurn, truncatedEventId }`.

Saga discipline (mirrors fork/spawn): if the daemon rewind fails, no
WAL marker and no audit (nothing half-applied). If the WAL append
fails after a successful daemon rewind, retry once, then
`500 rewind_marker_failed` with the daemon already rewound (logged
loudly; the daemon and gateway views briefly diverge until the next
event, which client replay reconciles).

### `routes/fork.ts` (modify)

Accept `fromTurn`; when present, run `resolveTurn` and use its
`truncatedEventId` as the existing `fromEventId` slice point.
`fromTurn` and `fromEventId` are mutually exclusive (`400`).

### SDK (`packages/sdk-typescript`)

`rewindSession` method + ACP request mapping.

## Data flow (owner rewinds a shared session to turn 3)

1. Owner `POST /session/S/rewind { toTurn: 3 }`.
2. Gateway checks no prompt in flight.
3. Reads S's records; `resolveTurn` → `{ targetTurnIndex,
truncatedEventId: 47 }`.
4. `daemon.rewindSession(S, { toTurn: 3 })` truncates daemon history.
5. Gateway appends `session_rewound { toTurn:3, truncatedEventId:47,
... }` as WAL event 51.
6. All attached clients receive event 51, truncate render to turn 3,
   continue.
7. Audit row; `session.rewound` routed to push/bridges; `202`.
8. A late client reconnecting with `Last-Event-ID: 40` replays 41–51,
   hits the marker, renders turn 3 as tip.

## Error handling

| Failure                                           | Behavior                                                                         |
| ------------------------------------------------- | -------------------------------------------------------------------------------- |
| Prompt in flight                                  | `409 rewind_in_progress`, nothing applied                                        |
| `toTurn` negative/non-integer                     | `400 invalid_turn`                                                               |
| Turn beyond tip / inside a compression checkpoint | `409 rewind_not_applicable`                                                      |
| Daemon rewind fails                               | `502`, no WAL marker, no audit (saga)                                            |
| WAL append fails after daemon rewind              | retry once → `500 rewind_marker_failed`, logged loudly; client replay reconciles |
| Fork given both `fromTurn` and `fromEventId`      | `400 mutually_exclusive`                                                         |
| Non-owner token                                   | `403` (owner scope)                                                              |

## Threat model

| Attacker                                | Capability                                   | Mitigation                                                                                                                                                                               |
| --------------------------------------- | -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Compromised owner token                 | Destroy conversation history via rewind      | Owner scope required; every rewind audited (`session_rewound` with actorTokenId/toTurn); fork is the non-destructive alternative for exploratory branching; owner revocation ends access |
| Compromised `write`/`read` token        | Rewind a session                             | Rewind requires `owner`; `write`/`read` cannot invoke it                                                                                                                                 |
| Malicious `toTurn` (traversal/overflow) | Corrupt WAL or crash                         | `toTurn` validated as a non-negative integer in range by the pure resolver before any daemon call; typed rejection                                                                       |
| Race: rewind during a prompt            | Truncate mid-generation → inconsistent state | `409 rewind_in_progress` guard; the daemon has its own equivalent guard as defense-in-depth                                                                                              |
| Attached client desync after rewind     | Stale render diverges from timeline          | Append-only `session_rewound` marker broadcast to all; replay across the marker reconciles late joiners                                                                                  |

## Alternatives considered

- **B: Gateway-side truncation** — gateway truncates its own WAL and
  replays a reconstructed history to the daemon. Rejected:
  reimplements rewind the daemon already does correctly (history
  truncation, thought-stripping, API-index computation); two divergent
  rewind implementations; breaks the "daemon owns session state"
  boundary.
- **C: Rewind as self-fork + id swap** — fork from turn N, redirect
  the session id. Rejected: the session-id swap breaks every attached
  client's connection and all external references (bridges, links,
  push); rewind must preserve session identity.

## Testing

Vitest, stub-daemon pattern:

- **`turnResolver`**: exhaustive — turn 0 / mid / last / beyond,
  compression-checkpoint boundary, non-integer, and the exact
  `truncatedEventId` for each (the off-by-one net).
- **`rewind` route**: prompt-in-flight 409; each 4xx mapping; happy
  path emits exactly one `session_rewound` with correct payload; saga
  rollback on daemon failure; marker-retry path; owner-scope 403.
- **Multi-client**: two attached SSE readers both receive the marker;
  a late reconnect replaying across the marker renders the truncated
  tip.
- **`fork` turn-addressing**: `fromTurn` slices identically to the
  equivalent `fromEventId`; both-supplied 400.
- **SDK**: `rewindSession` maps to the ACP request and returns the
  daemon result.
- **Integration**: attach → prompt a few turns → rewind to turn N →
  observe marker → verify tip.

## Spec artifacts (qwen-code-remote)

`openspec/changes/add-remote-rewind/` with proposal.md, design.md
(alternatives + threat model per config.yaml rules),
specs/remote-rewind/spec.md (RFC-2119 requirements with scenarios;
endpoints cited method+path), tasks.md (phased, Status/Prompt fields).
Direct registry edits: `session_rewound` SSE row in add-remote-control
wire-protocol; `session_rewound` audit row in pairing-auth extension
registry (per repo precedent — no partial MODIFIED delta files).

## Known limitation / follow-up

`packages/rc-gateway/src/server.ts` mounts `GET /session/:id/events`
with `walDir` hardcoded to `undefined` and mounts the rewind/fork
routes without a `walDir` wired in either — the same pre-existing
dark-wiring condition that already governs `session_forked` (see
`docs/superpowers/plans/2026-07-17-remote-rewind.md`). WAL
persistence and owner-stream fan-out for the `session_rewound`
marker are implemented and unit-tested at the route-factory level,
but not switched on end-to-end in the shipped gateway today.

Concretely: step 6 of the data flow above ("all attached clients
receive event 51, truncate render to turn 3") is accurate for
clients currently attached to `GET /session/:id/events` — they
receive the daemon-emitted `{ toTurn, targetTurnIndex,
apiTruncateIndex }` frame live, independent of `walDir`. Step 5 (the
gateway appending the rich `session_rewound { toTurn, truncatedEventId,
rewoundByTokenId, rewoundAt }` WAL event) and step 8 (a late client
reconnecting with `Last-Event-ID: 40` replaying across that marker —
user story R3) both depend on `walDir` being wired into the rewind
route and the events route, which is not enabled in production
today. Wiring `deps.walDir` into both is deferred follow-up work.

## Follow-ups (out of scope)

- Local `/branch` gaining a from-past-turn option (this change is
  remote-only; the resolver could later back a local turn picker).
- Remote tool-call checkpoint restore (`/restore` equivalent).
- A rewind "redo" (re-applying a truncated forward branch) — the WAL
  retains the pre-rewind events, so a future redo marker is possible.
