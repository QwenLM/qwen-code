# Orphan-reap worktree cleanup (#11024 item 1)

## Status

Implemented and verified (2026-09-07). Two real-daemon A/B rounds: the
first caught the `supersedes` classification defect (a post-reset
replacement could never be cleaned — rule 3 was revised accordingly);
the second confirmed the happy path, the tombstone variant, the
superseded-predecessor skip, and all preserved-by-design states.
Pre-existing gap noted by verification (out of scope): a `worktree-reset`
requested without source metadata leaves the replacement with no
transcript record, and `/sessions/delete` answers `notFound` for it.

## Problem

When the daemon definitively deletes a session that owned a worktree, the
checkout and its branch are never removed. Crash/reap cycles and operator
deletes therefore leak worktrees and branches permanently (flagged by
yiliang114 on #10643, `session-archive.ts:656`).

## Leak map (real daemon, measured)

Scenario: channel worktree session (`POST /session` with `worktree:{}`),
artifacts = JSONL record, sidecar `<chatsDir>/<sid>.worktree.json`,
in-worktree marker `.qwen-session`, checkout
`W/.qwen/worktrees/<slug>` (git-registered), branch `worktree-<slug>`.

| Path                                             | Record      | Sidecar     | Checkout   | Marker     | Branch     |
| ------------------------------------------------ | ----------- | ----------- | ---------- | ---------- | ---------- |
| Bridge idle reaper (worker crash)                | kept        | kept        | kept       | kept       | kept       |
| `POST /sessions/delete` (`deleteDaemonSessions`) | **deleted** | **deleted** | **leaked** | **leaked** | **leaked** |
| `DELETE /session/:id`                            | kept        | kept        | kept       | kept       | kept       |

- The idle reaper deletes nothing persisted; the session stays
  restorable. Not a leak in the sense of this issue.
- `POST /sessions/delete` is **the** deletion path that actually removes
  a worktree-owning session's record, and it destroys the sidecar (the
  ownership evidence) as part of the record deletion. Confirmed for both
  idle-live and reaped sessions.
- No production flow ever reaches `deleteDaemonSessionIfOrphan` for a
  worktree-owning session (6 sessions / 6 reaps / 5 deletes driven; its
  static call sites are rollback/keepalive paths that either never own
  worktrees or self-clean via request-local `worktreeMeta`).
- After deletion, later restores answer 404 `session_not_found`; the
  leftover marker's session id simply dangles.

## Decision

Arm the cleanup at **`deleteDaemonSessions`** — the one real leak path —
covering both its production call sites (REST `POST /sessions/delete` and
ACP `qwen/sessions/delete`) uniformly by placing the cleanup inside the
shared function, not at each route.

`deleteDaemonSessionIfOrphan` is deliberately **not** armed: the evidence
shows no production flow reaches it for a worktree-owning session, its
named call sites must stay unarmed (ACP dispatch rollback, scheduled-task
keepalive, Part 4B reset rollback), and the create-route reap sites
already self-clean request-local worktrees. Adding an unused opt-in
there would be a dead switch.

Because `deleteDaemonSessions` destroys the sidecar as part of the record
deletion, cleanup classification must happen **before** the record is
deleted, and execution **after** the deletion is confirmed.

## Concurrency and lock order

Restores (Part 4A) and the reset route (Part 4B) serialize worktree
operations on a promise chain keyed by the canonical worktree path
(`acquireWorktreeOwnershipOp`), taken **before** any session-archive
coordinator lock (reset route: worktree lock →
`deleteDaemonSessionIfOrphan` → coordinator). Cleanup must follow the
same order — worktree lock first, coordinator second — or the two orders
can deadlock (AB-BA).

- The ownership-op lock moves from a route-local closure to a shared
  module keyed by canonical worktree path alone (the serialized resource
  is the on-disk checkout; bridge-scoping was only a GC convenience and
  release-on-finally already bounds the map). Path-keying is strictly
  more conservative and frees the cleanup from bridge-identity concerns
  across the REST and ACP call sites.
- When `deleteDaemonSessions` runs with `coordinatorLockHeld: true`
  (internal live-conversation runtimes, where the outer batch lock is
  already held), cleanup is **skipped**: taking the worktree lock there
  would invert the order, and internal runtimes never own Part 4A
  worktrees.
- Each delete takes exactly one worktree lock (its own candidate's), so
  concurrent batch deletes need no multi-lock ordering — two sessions
  sharing a checkout serialize on the same key and the loser
  re-classifies against post-delete state.

## Safety contract

Cleanup fires only when the whole ownership chain verifies; any doubt
preserves the checkout and logs a named warning (a `qwen serve:` stderr
line via `writeStderrLine`).

Classification (before record deletion, under the worktree lock):

1. Strict sidecar read (`readWorktreeSessionStrict`). `missing` → not a
   worktree owner, no cleanup. `invalid` → preserve + log. The archived
   location is checked too — the sidecar moves with the record.
2. Sidecar without `workspaceCwd` (legacy tool worktree) → preserve
   silently; not daemon-route-owned.
3. Sidecar carrying `supersededBy` → skip **silently**: the expected
   post-reset state (the checkout belongs to the replacement now), so
   preserve-and-log keeps its meaning. A sidecar carrying `supersedes`
   means this session IS the current owner after a reset and stays
   cleanable — the first A/B round proved the stricter reading (skip on
   any link) makes every post-reset session's worktree permanently
   uncleanable, which fails this design's own goal.
4. Marker strict read (`readWorktreeSessionMarkerStrict`) must be
   `valid` and name exactly the session being deleted.
5. Path containment: the checkout must resolve under the workspace's
   worktree roots (`<ws>/.qwen/worktrees` or the repo top-level
   equivalent, same allowed-roots derivation as the create route).
6. Cross-session sharing: a scan of the sidecar dir's `*.worktree.json`
   must find no **other** session's sidecar naming the same (canonical)
   worktree path. A tombstone predecessor (`supersededBy` naming
   exactly the session being deleted) legitimately names the same
   checkout — it is evidence of the transfer, not sharing.

Execution (after confirmed deletion, still under the worktree lock):

7. **Gate on the actual deletion**: only `kind === 'removed'` /
   `mutationApplied` — never `notFound` or error shapes, mirroring the
   create route's `if (removed)` gate.
8. Re-verify the marker (unchanged, still naming the deleted session) —
   closes the out-of-band window classification can't see.
9. Full `git status --porcelain` inside the checkout must be empty —
   **untracked files included**, so an agent-written file that was
   never committed counts as work and preserves the checkout. This is
   the deliberate choice behind the safety contract's "any doubt
   preserves": tracked and committed work was already protected, and
   extending the gate to untracked files costs one `git status` walk
   per delete while closing the "silently destroyed draft" hole the
   tracked-only variant left open. The daemon's own marker file
   (`.qwen-session`, git-excluded in production) is the one exemption.
   Read errors fail closed to "has work". The bridge session was
   closed before the record deletion, so no in-daemon writer can dirty
   the checkout afterwards.
10. `removeUserWorktree(slug, { deleteBranch: true })` — never
    `forceDeleteBranch`. Log the `branchPreserved` outcome so "checkout
    removed, branch kept for unmerged commits" is distinguishable from
    "checkout kept, ownership doubtful".

## Failure semantics

- The session record deletion proceeds exactly as today regardless of
  the cleanup classification: a preserved checkout never blocks the
  delete, and a failed `removeUserWorktree` is logged and otherwise
  ignored (the leak it leaves is the status quo, never worse).
- A crash between record deletion and worktree removal leaves the
  previous leak shape; a future sweep can recover it (out of scope).

## Out of scope

- Periodic/startup orphan-worktree sweep for the crash/reap leak shape
  (record kept, everything kept — nothing is lost, just idle).
- Arming `deleteDaemonSessionIfOrphan` (no production reach; see
  Decision).
- Removing leftover sidecar/marker when the checkout is preserved
  (preserved means ownership doubt; the sidecar is the evidence a later
  repair needs).

## Test plan

Unit (`session-archive.test.ts`, real git repos + real sidecars/markers
in temp dirs):

- Happy path: delete removes record + checkout + branch + marker.
- Gate: `notFound` (record absent, sidecar present) → checkout kept.
- Superseded sidecar → kept, and no warning logged (silent skip).
- Legacy sidecar (no `workspaceCwd`) → kept.
- Invalid sidecar → kept + warning.
- Marker missing / mismatched / invalid → kept + warning.
- Cross-session sharing (second sidecar, same path) → kept + warning.
- Containment failure (checkout outside allowed roots) → kept + warning.
- Dirty checkout (tracked modification) → kept + warning.
- Unmerged commits in the worktree branch → checkout removed, branch
  kept, `branchPreserved` logged.
- `coordinatorLockHeld: true` → cleanup skipped (checkout kept) even
  when fully verified.

E2E (real daemon A/B): repeat the leak-map scenario 3/4 — after
`POST /sessions/delete`, the checkout, marker, registration, and branch
are gone; a dirty checkout variant stays.
