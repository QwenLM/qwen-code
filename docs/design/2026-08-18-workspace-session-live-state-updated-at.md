# Workspace Session Live-state Activity Timestamp

## Status

Proposed follow-up to the workspace session live-state protocol. This document
defines the server and TypeScript SDK contract only. Web Shell consumption is a
separate implementation change.

## Summary

Add an optional `updatedAt` field to each live session returned by
`GET /workspaces/:workspace/sessions/live-state`. The value is a strictly
monotonic, bridge-local activity timestamp advanced when a prompt that reached
the running state publishes its formal terminal outcome.

The field lets clients update the recency of catalog rows already in memory
without reloading the persisted session catalog after each completed turn. It
does not change the catalog version, prove transcript durability, or make the
live-state route perform storage or ACP reads.

The response remains schema version `v: 1`, and the existing
`workspace_session_live_state` capability remains the only endpoint capability.
The field is wire-optional so old clients ignore it and new clients can retain
their current catalog-refresh fallback when it is absent.

## Relationship to the Existing Protocol

The original [workspace session live-state protocol](./2026-08-16-workspace-session-live-state.md)
separates two concerns:

1. Volatile live-session status is returned by a cheap memory-only endpoint.
2. Catalog changes advance the `generation + revision` version.

Ordinary turn completion intentionally does not advance the catalog revision.
The first Web Shell consumer therefore retained a rate-limited full catalog
reconciliation after a turn completes so persisted `updatedAt` values and
session ordering do not remain frozen.

That fallback is bounded, but it still reconnects an ordinary turn lifecycle
event to the expensive operation the live-state endpoint was introduced to
avoid. A live activity timestamp closes that remaining gap without widening the
catalog clock.

## Current Behavior and Evidence

The current implementation already contains most of the semantic path needed
for this extension:

- `BridgeSessionSummary` and `DaemonSessionSummary` already define
  `updatedAt?: string`.
- Persisted catalog summaries derive `updatedAt` from the transcript JSONL file
  modification time.
- The live/persisted merge helper already treats a live summary's `updatedAt` as
  the fresher value and all activity-based catalog comparators read
  `updatedAt ?? createdAt`.
- The bridge funnels successful, failed, cancelled, deadline, teardown, and
  transport terminal paths through `publishPromptTerminal`.
- `publishPromptTerminal` has a per-prompt `terminalPublished` latch and
  distinguishes a running prompt from a prompt that never left the queue.
- The Web Shell live-state consumer polls every two seconds but currently asks
  for one rate-limited catalog reconciliation after turn completion because the
  live overlay has no activity timestamp.

The missing piece is an activity timestamp on `SessionEntry` and its projection
through the existing summary and live-state surfaces.

## Goals

- Let a client refresh the recency of an already-loaded live session using only
  the memory-only live-state response.
- Establish a causal guarantee: after a client observes the formal terminal for
  a prompt that reached the running state, a subsequently started live-state
  request that still returns the same entry in the same bridge generation sees
  the terminal's activity timestamp.
- Advance once for every prompt that reached the running state and published its
  first formal terminal, including success, error, cancellation, and deadline.
- Keep the value strictly increasing for a live session even when multiple
  terminals occur in one wall-clock millisecond.
- Preserve the existing catalog-version boundary: turn activity changes the
  live overlay, not `generation + revision`.
- Preserve route ownership, trust, cache, status code, timeout, and
  memory-only behavior.
- Remain compatible in every old/new server and client combination.

## Non-goals

- Proving that every transcript record has reached durable storage.
- Returning the exact JSONL file modification time from the live-state route.
- Reading or statting session files in the live-state route.
- Seeding the activity timestamp by scanning persisted state during session
  creation or restore.
- Advancing catalog revision for prompt admission, streaming, or completion.
- Adding a new capability, readiness feature, schema version, query parameter,
  ETag, event stream, or feature gate.
- Adding static metadata such as source, title, organization, branch, or
  worktree information to live-state.
- Guaranteeing that an activity-updated session missing from a client's current
  catalog page can be inserted without a full catalog reconciliation.
- Changing the first catalog load, persisted scan implementation, or existing
  session-list deadline.
- Implementing the Web Shell consumer in the server protocol PR.

## Terminology and Authority

`updatedAt` on the live-state item is a **daemon-observed live activity
watermark**. It is not a persistence acknowledgement.

The authoritative transition is the first formal terminal published for a
prompt whose pending entry is in the `running` state. This point is preferable
to adjacent signals:

- Prompt admission is too early; the request may remain queued and never run.
- Prompt start would move the row before the turn has settled and would not
  replace the current completion-driven behavior.
- Individual streamed updates are too frequent and do not form a stable
  ordering boundary.
- `sessionLastSeenAt` is a liveness watermark also advanced by client
  heartbeats, so exposing it would continually reorder an idle but connected
  session.
- JSONL mtime is the persisted authority but requires filesystem work and is not
  synchronously available at the daemon terminal boundary.

The ACP child enqueues its turn-result record before its prompt call settles,
but the recording service uses a serialized asynchronous writer. The daemon can
therefore know that a running turn reached its formal terminal without claiming
that the final queued record has been flushed. The protocol names that fact
explicitly rather than turning a best-effort activity signal into a false
durability guarantee.

## Public REST Contract

### Request

The request is unchanged:

```http
GET /workspaces/:workspace/sessions/live-state
```

It retains the existing selected-runtime, workspace-scoped, trusted-only
ownership and has no query parameters.

### Success response

```json
{
  "v": 1,
  "catalogVersion": {
    "generation": "7eca3164-bce1-4f50-94d8-c842c480f213",
    "revision": 17
  },
  "sessions": [
    {
      "sessionId": "session-123",
      "clientCount": 1,
      "hasActivePrompt": false,
      "isWaitingForPermission": false,
      "isWaitingForUserQuestion": false,
      "updatedAt": "2026-08-18T08:12:30.123Z"
    }
  ]
}
```

`Cache-Control: no-store` remains required.

### Field contract

```ts
export interface DaemonSessionLiveState {
  sessionId: string;
  clientCount: number;
  hasActivePrompt: boolean;
  isWaitingForPermission: boolean;
  isWaitingForUserQuestion: boolean;
  updatedAt?: string;
}
```

When present, `updatedAt`:

- is a valid ISO 8601 timestamp;
- identifies the newest running-prompt terminal observed by the current bridge
  for that session;
- is strictly increasing within the lifetime of that live `SessionEntry`;
- is written before the corresponding formal terminal event becomes visible;
- may be absent before the first running turn settles in the current bridge
  generation;
- may be lost when a daemon or workspace runtime replaces the bridge; and
- must not be interpreted as proof that a transcript flush succeeded.

The response remains `v: 1`. Adding an optional object property is wire-additive
and does not change how existing fields are decoded. Absence is not a reliable
global support probe because a supporting daemon legitimately omits the field
for a live entry with no observed terminal in the current generation.

## Transition Matrix

| Event                                                                | `updatedAt` behavior                                                  | Catalog version behavior               |
| -------------------------------------------------------------------- | --------------------------------------------------------------------- | -------------------------------------- |
| Running prompt completes successfully                                | Advance once                                                          | No change                              |
| Running prompt returns a structured or transport error               | Advance once                                                          | No change                              |
| Running prompt is cancelled                                          | Advance once                                                          | No change                              |
| Running prompt reaches the daemon deadline                           | Advance once                                                          | No change                              |
| Running prompt is flushed during close, kill, crash, or shutdown     | Advance once if that prompt's terminal latch has not already been won | Membership removal advances separately |
| Queued prompt is removed, cancelled, or expires before dispatch      | No change                                                             | No change                              |
| A late result attempts to publish after an earlier deadline terminal | No change; duplicate latch wins                                       | No change                              |
| Prompt admission, queue wait, start, or streamed update              | No change                                                             | No change                              |
| Attach, detach, heartbeat, permission wait, or user-question wait    | No change                                                             | No change                              |
| Live session registration or restore before a new terminal           | Field absent                                                          | Membership revision advances           |
| Bridge or runtime replacement                                        | Field starts absent                                                   | New generation                         |

An error or deadline may advance live activity even when transcript persistence
is degraded or the child did not finish normally. This is deliberate: the
field represents the daemon-observed running attempt and formal terminal, not a
durability outcome.

## Monotonicity and Causal Ordering

`SessionEntry` stores the watermark as epoch milliseconds rather than a string:

```ts
lastTurnEndedAtMs?: number;
```

The first accepted running terminal advances it with:

```ts
const createdAtMs = Date.parse(entry.createdAt);
const floor = Number.isFinite(createdAtMs)
  ? createdAtMs
  : Number.NEGATIVE_INFINITY;
const next = Math.max(Date.now(), (entry.lastTurnEndedAtMs ?? floor) + 1);
entry.lastTurnEndedAtMs = next;
```

The exact implementation may avoid `Number.NEGATIVE_INFINITY` for readability,
but must preserve the same behavior. The additional millisecond is a logical
tie-breaker when wall time has not advanced; it is not a duration measurement.
The `createdAt` floor on the first advance matters because rows without a
watermark are keyed by `createdAt` and the live-only cursor carries no
emitted-identity list: a first watermark behind `createdAt` — a wall-clock
rollback between creation and the first terminal — would move an
already-emitted row's key backward mid-pass and let the strictly-older filter
return it twice.

`publishPromptTerminal` must determine whether the pending prompt was running,
pass the duplicate latch, advance the watermark, remember the terminal status,
and only then broadcast `turn_complete` or `turn_error`.

This establishes the required happens-before relationship:

```text
terminal latch wins
  -> live activity watermark advances
  -> formal terminal is published
  -> client observes terminal
  -> client starts live-state request
  -> live-state includes the new watermark
```

The final step applies only while that live entry remains present in the same
bridge generation. A close or runtime replacement may instead make the row
disappear or return a new generation; the protocol never carries the retired
bridge-local watermark across that lifecycle boundary.

The ownership gate on `settleActivePromptState` and the terminal latch continue
to protect the next prompt from a late result. The timestamp update must not add
a second independent settle path.

## Catalog Version Contract

`updatedAt` does not participate in `generation + revision`.

The version remains an equality token for catalog membership and static
metadata. Advancing it on every turn would make the two-second live-state poll
observe a mismatch and request the same full catalog scan this extension is
designed to remove.

Clients merge `updatedAt` from the snapshot directly, just as they merge
`hasActivePrompt` and waiting flags. A change in `updatedAt` with an unchanged
catalog version is valid and expected.

## Persistence and Full-catalog Merge

Persisted session summaries continue to derive `updatedAt` from JSONL mtime.
The live timestamp and persisted timestamp have different authorities:

- persisted mtime describes the latest modification visible in storage;
- live `updatedAt` describes the latest running-turn terminal visible to the
  bridge.

When a live session is merged with a persisted summary, the response should use
the later valid timestamp rather than blindly preferring either source. This
prevents a terminal timestamp from moving a row backward when an asynchronous
transcript write obtains an mtime a few milliseconds later.

The comparison helper must preserve a valid value when the other candidate is
absent or invalid. No filesystem read is added: both candidate strings are
already present in memory in the existing merge path.

Every surface that holds both candidates applies the same rule, including the
Live Task read and wait paths, which read the bridge summary directly rather
than through the list merge. Otherwise one task would report two different
recencies depending on the tool that asked, and a wait cursor keyed on the live
value alone would not change when only the transcript advanced.

While the session remains live, activity-based full catalog responses and
live-only session lists can therefore use the same effective recency. Once the
live entry disappears, persisted mtime becomes the only authority again and may
be older than the former live watermark. That can happen after a crash or
degraded write, but also after a normal close when the logical `+1ms` tie-breaker
or a wall-clock rollback placed the in-memory watermark ahead of storage. The
protocol does not manufacture durability or preserve a retired bridge-local
watermark.

Existing cursor routes are not snapshot-isolated: concurrent session activity
can already change the collection while a caller pages through it. Populating
live `updatedAt` makes that movement observable in activity-based ordering but
does not introduce a stronger pagination guarantee. Clients that require a
fresh first page reload it after an activity change.

One movement mode is new to the activity dimension. Before this change the
activity component of a cursor key came from transcript mtime alone and could
only advance; the organized key's pin dimension could already flip mid-pass
(the organization snapshot is re-read per page request), so an emitted
persisted row could already repeat after an unpin, but the activity component
itself never moved backward. A live watermark that leads mtime is not durable:
when the live entry retires mid-pass the row's key falls back to mtime, so a
page whose cursor was encoded from the higher watermark would admit that row
again. The same regression applies to a live-only row that persists mid-pass,
because its emitted key was the watermark while its persisted key is the first
flush's mtime.

The activity cursor therefore carries the identities of rows already emitted at
a live-derived key, and the after-cursor filter excludes them for the rest of
the pass, so live-derived key movement returns a session at most once per pass.
The carry covers only rows the mechanism saw: a persisted-only row emitted
before its pin state changes is never carried, so an unpin between fetches
keeps the pre-existing organized-view repetition mode, and callers that
accumulate pages key rows by `sessionId`. The third activity-keyed cursor, the
live-only list, needs no carry: the first watermark advance floors at
`createdAt`, so a live key never moves backward. The list stays bounded and
self-pruning: an identity absent from the filtered collection is retained —
absence can be transient under the short-TTL persisted snapshot or mid-pass
group movement — while an identity whose row is present is dropped once its
persisted key alone can no longer pass the strictly-older filter under either
pin state. Past a 64-identity cap the identities with the highest persisted
keys are dropped first — they leave the re-admission window soonest — and a
dropped identity degrades to an at-most-once duplicate instead of failing the
pass. Cursors minted before the field existed remain
valid, and the field is omitted when empty, so the cursor shape is unchanged
whenever no live-derived key was emitted. Cross-pass guarantees are unchanged:
a new pass is a new snapshot, and clients that require a fresh view reload from
the first page.

## Bridge and Route Implementation

The server implementation should make the smallest possible change:

1. Add `lastTurnEndedAtMs?: number` to `SessionEntry`.
2. Add one internal helper that advances the field monotonically, flooring
   the first advance at the entry's `createdAt`.
3. In `publishPromptTerminal`, compute the existing running-state gate before
   broadcasting and advance only after the duplicate latch succeeds.
4. Project `new Date(lastTurnEndedAtMs).toISOString()` from
   `toSessionSummary` as the already-declared `BridgeSessionSummary.updatedAt`.
5. Project the optional summary field from the workspace live-state route.
6. Change live/persisted merge selection to keep the later valid timestamp.

No new bridge method is needed. `listWorkspaceSessions` and
`getSessionSummary` already return `BridgeSessionSummary`, and its public type
already carries the optional field.

The live-state route continues to:

- resolve the selected workspace runtime without primary fallback;
- reject untrusted or unavailable runtimes under existing semantics;
- read only the bridge version and in-memory summaries;
- invalidate persisted catalog caches only when exposing a new catalog version;
- make no session-storage, settings, external-command, or ACP request; and
- return `Cache-Control: no-store`.

An activity-only change must not invalidate the persisted-list cache from the
live-state route. Cached snapshots contain persisted facts; the request's
existing live merge applies the current in-memory timestamp when the catalog is
served.

## Downstream Consumer Audit

Populating the existing `BridgeSessionSummary.updatedAt` field has a wider but
intentional additive effect than projecting a route-local value.

| Consumer                                         | Effect                                                                                                                       |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| Workspace live-state                             | Returns optional activity watermark for the intended client optimization                                                     |
| Full workspace session lists                     | Live/persisted merge and activity ordering can reflect the latest running terminal                                           |
| Live-only session list and cursor                | Live rows are ordered by the populated activity timestamp instead of creation time alone                                     |
| `GET /session/:id/status`                        | Adds the already-typed bridge-local field directly, without a persisted merge                                                |
| Live Task thread summaries and cursors           | A running terminal advances the live task's `updatedAt`/change cursor; read/wait apply the same later-valid rule as the list |
| Goals routes                                     | Ignore the new field; behavior is unchanged                                                                                  |
| Session-owner resolution and admission           | Read identity/ownership fields only; behavior is unchanged                                                                   |
| Create-sub-session and live-session coordinators | Read caller or interaction state only; behavior is unchanged                                                                 |

The implementation PR must update exact-object tests for the affected public
summary surfaces while retaining tests that prove unrelated ownership and
status decisions do not start depending on the timestamp.

`GET /session/:id/status` returns the bridge summary directly. Its `updatedAt`
may therefore be earlier than a merged list response that selected a later
persisted mtime; equality across those response surfaces is not guaranteed.

## TypeScript SDK and Capability

The TypeScript SDK change is limited to the optional field on
`DaemonSessionLiveState`. `DaemonSessionSummary.updatedAt` already exists.

The SDK transport remains a typed native REST call and does not add a runtime
schema transformation or a capability request per poll.

No capability is added or changed:

```ts
workspace_session_live_state: {
  since: 'v1';
}
```

That capability continues to mean that the endpoint exists. It does not promise
that every live item has `updatedAt`, because the value is lifecycle-dependent.

No Java SDK or ACP method is added.

## Compatibility

| Server | Client               | Behavior                                                                               |
| ------ | -------------------- | -------------------------------------------------------------------------------------- |
| Old    | Old                  | Existing live-state and rate-limited catalog refresh behavior                          |
| New    | Old                  | Extra JSON property is ignored; existing behavior remains                              |
| Old    | New follow-up client | Missing field retains the current rate-limited full-catalog fallback                   |
| New    | New follow-up client | Known catalog rows update recency from live-state; fallback remains for uncovered rows |

The response schema remains `v: 1`. A new schema version would force clients to
branch on an otherwise additive property and would not solve the legitimate
absence of a timestamp before the first terminal in a new generation.

## Follow-up Web Shell Consumption Contract

The server PR does not change Web Shell behavior, but the protocol is designed
for a follow-up consumer with the following rules:

1. `turnCompleted` carries both workspace cwd and session id.
2. The client records a per-session completion sequence only for a turn known
   to have reached the running state. A queued-only terminal requires no
   recency reconciliation.
3. A live-state request snapshots pending sequences when the request starts.
4. Only a response from a request started after that sequence was recorded may
   satisfy it.
5. A valid `updatedAt` on a matching row patches recency and reorders the loaded
   active page using the server comparator.
6. Archived pages never accept a live activity timestamp.
7. A missing/invalid timestamp or a target row absent from the loaded active
   catalog retains the existing version-fenced, rate-limited catalog fallback.

The sequence is required because a second turn can complete while a live-state
request is in flight. A set of session ids would let that older response clear
the newer completion.

A consumer that cannot distinguish a queued-only terminal may retain the
existing rate-limited catalog fallback conservatively, but the protocol does
not require a fallback for an event that produced no activity watermark.

The client should keep the later of its catalog and live timestamps, and should
only reorder when the effective value changes. It must not insert an unknown
live session into source-, group-, or archive-filtered pages because live-state
does not carry the static metadata needed to prove membership.

This keeps the common case scan-free while preserving correctness for old
servers, pagination boundaries, and sessions missing from the current page.

## Failure Semantics

The route's HTTP failure semantics do not change.

| Condition                                                                 | Result                                                                                               |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| No running terminal in current live generation                            | Session item omits `updatedAt`                                                                       |
| Wall clock does not advance between terminals                             | Logical `+1ms` preserves strict monotonicity                                                         |
| Wall clock moves backward                                                 | Per-entry monotonicity prevents a live timestamp regression; the first advance floors at `createdAt` |
| Wall clock jumps forward and is later corrected                           | The watermark may remain in the future until time catches up or the live entry disappears            |
| Recorder is degraded or later flush fails                                 | Watermark still represents terminal activity; no durability claim                                    |
| Duplicate or late terminal                                                | Existing latch suppresses another timestamp advance                                                  |
| Queued prompt never runs                                                  | No timestamp advance or required recency confirmation                                                |
| Session disappears after terminal                                         | Live row disappears; persisted catalog remains authoritative                                         |
| Daemon/runtime replacement                                                | New catalog generation and initially absent live watermark                                           |
| Client awaiting running-turn recency receives an invalid or missing field | Ignore it and retain existing fallback behavior                                                      |

No new logging is required on the high-frequency route. Existing route latency
and request-count telemetry is sufficient. The implementation may add no
per-terminal success log; doing so would add high-cardinality noise to an
ordinary lifecycle path.

A forward clock jump is accepted bridge-local watermark behavior. Correcting
the value downward would violate strict monotonicity; while the entry remains
live, the later-valid merge may therefore keep the future watermark ahead of a
correct persisted mtime. Entry removal or bridge replacement ends that scope.

## Implementation PR Boundaries

The server protocol implementation should be one atomic feature PR containing:

- the bridge-local monotonic activity watermark;
- summary projection and the existing full-list merge correction;
- workspace live-state route projection;
- TypeScript SDK type update;
- protocol and SDK documentation updates; and
- bridge, route, list-merge, status, and SDK tests.

It intentionally excludes all Web Shell changes. Shipping the additive server
field first lets old clients exercise the unchanged path and gives the later
client PR a deployed compatibility target.

The implementation crosses ACP bridge, CLI serve, and TypeScript SDK packages.
It is a small feature rather than a refactor, but repository policy requires
maintainer awareness for cross-package architectural changes. The PR should
name the complete downstream consumer audit above in its risk section.

## Test Plan

### Bridge unit tests

- A newly created or restored live entry omits `updatedAt` before its first
  running terminal.
- A successful running terminal produces a valid ISO timestamp.
- Running success, structured error, transport error, cancellation, and deadline
  terminal paths each advance exactly once. The teardown paths (session close,
  kill, channel exit, daemon shutdown) advance through the same helper, but each
  removes the entry from live state in the same operation, so the advanced value
  has no reader and no test asserts it.
- Queued removal/cancellation/deadline does not advance.
- The deadline path publishes its terminal twice — once from the expiry and
  once from the raced rejection reaching the settle handler — and still
  advances exactly once. An agent result arriving later lands after the raced
  promise settled, so it adds neither a terminal nor an advance.
- Two running terminals under a fixed `Date.now()` produce strictly increasing
  values.
- A forward clock jump followed by a correction never decreases the watermark;
  the bridge-local value resets only with entry or bridge replacement.
- Heartbeat, attach/detach, interaction waiting, and streamed updates do not
  change the value.
- The summary already contains the new timestamp when a terminal subscriber is
  synchronously notified.
- Turn activity leaves catalog generation and revision unchanged.

### Route and ownership tests

- The workspace live-state response includes `updatedAt` only when the bridge
  summary supplies it.
- Existing five required live-state fields remain present.
- `v`, `catalogVersion`, `Cache-Control`, selector, trust, and runtime-generation
  behavior remain unchanged.
- The route still performs no filesystem, settings, command, or ACP-child work.
- Primary and secondary runtime tests prove the timestamp comes only from the
  selected bridge.

### Full-list and downstream tests

- A live timestamp newer than persisted mtime wins and changes activity order.
- A persisted timestamp newer than the live terminal value wins, preventing a
  regression.
- Invalid or absent candidates preserve the other valid value.
- Live-only list ordering and cursor keys use the populated timestamp.
- Session status exposes the optional field without changing unrelated status
  values.
- Live Task cursor changes after a running terminal and remains stable across a
  heartbeat.
- Goals, owner resolution, and admission tests remain unchanged or explicitly
  ignore the new field.

### SDK and compatibility tests

- Public daemon exports include the optional field.
- Existing live-state method performs exactly one native REST request and no
  capability probe.
- An old-shaped response without `updatedAt` remains assignable and usable.
- Exact request URL, timeout, client identity, and error behavior remain
  unchanged.

### E2E and fault injection

1. Start a real daemon and create a session.
2. Read live-state before a prompt terminal and allow `updatedAt` to be absent.
3. Complete a prompt and assert a subsequent read returns a valid timestamp
   while `catalogVersion` is unchanged.
4. Complete a second prompt with minimal delay and assert the timestamp is
   greater.
5. Send heartbeats and assert the timestamp does not change.
6. Exercise a running cancellation or deadline and assert it advances once.
7. Restart the daemon and assert the catalog generation changes while the live
   timestamp is absent until another terminal.
8. Block or enlarge persisted catalog scanning and confirm direct live-state
   latency remains independent of it.

The later Web Shell PR adds request-count E2E coverage proving repeated turns on
an already-loaded row issue no additional full catalog requests.

## Acceptance Criteria

- A running-prompt terminal event observed by a client causally precedes the
  watermark in a subsequently started live-state response whenever the same
  live entry remains present in the same bridge generation.
- The watermark advances exactly once per running prompt terminal and never for
  a queued-only terminal or heartbeat.
- Multiple terminals in one wall-clock millisecond remain strictly ordered.
- Turn activity does not change catalog generation or revision and does not
  invalidate persisted-list caches.
- Direct live-state work remains independent of persisted session count and
  transcript size.
- When a live and persisted summary for the same session are merged, ordering
  uses the later valid activity time without moving that row backward while the
  live entry exists.
- Existing status, trust, runtime ownership, capability, and error contracts are
  preserved.
- Old clients ignore the field, and a missing field remains valid for new
  clients.

## Rollout

The server field is additive and ships through the normal daemon release path
without a feature flag. Canary telemetry should compare:

- live-state latency and error rate before and after the change;
- catalog revision stability across ordinary prompt terminals; and
- unexpected changes in live-session list or Live Task ordering.

Targeted canary smoke tests should separately verify one distinct timestamp
advance per running terminal. That verification reads the endpoint directly and
does not require a new per-terminal production log or metric.

The protocol PR alone does not reduce Web Shell catalog request volume. That
metric changes only after the follow-up consumer ships. Rollback is the ordinary
server binary rollback; there is no configuration, data, or migration state.

## Rejected Alternatives

### Reuse `sessionLastSeenAt`

Heartbeats advance it, so connected idle sessions would continually appear
recent. Liveness and conversation activity are different signals.

### Stat the transcript from the live-state route

This would return persisted authority but restore filesystem work to a
high-frequency endpoint whose defining contract is memory-only cost.

### Flush the recorder before publishing every terminal

This would turn UI recency into a synchronous durability barrier on the prompt
response path, increasing latency and coupling bridge settlement to storage
health. The timestamp does not require that guarantee.

### Advance catalog revision on every terminal

Every live-state client would observe a version mismatch and reload the full
catalog, preserving the current scan rather than eliminating it.

### Use the browser's `Date.now()`

It would not cover turns completed by another controller, would disagree across
clients, and would provide no server-side ordering authority.

### Add `lastTurnCompletedAt` beside `updatedAt`

Existing summary and catalog comparators already use `updatedAt` as the activity
time. A second public timestamp would require another merge policy while the
desired consumer ultimately maps it back onto the same catalog field.

### Add an envelope support flag, new capability, or `v: 2`

The property is additive, and a supporting daemon can legitimately omit it
before the first running terminal. The follow-up client can safely fall back on
absence without another negotiation surface.

### Include source and organization metadata so unknown rows can be inserted

That would evolve live-state into a second catalog protocol with duplicate
filtering, invalidation, and compatibility rules. A full catalog reconciliation
is the correct uncommon fallback when the target row is not already loaded.

### Publish activity through SSE only

The terminal already arrives through the session stream, but a route-level
watermark also updates other tabs and controllers polling workspace state. It
keeps reconnect and missed-event recovery stateless and within the existing
live-state protocol.
