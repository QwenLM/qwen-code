# Web Shell Detached Background Shell Liveness

- Status: draft
- Issue: [#17819](https://github.com/QwenLM/qwen-code/issues/17819)
- Companion design: [web-shell-sidebar-background-work-indicator.md](./web-shell-sidebar-background-work-indicator.md) (live-path indicator, #17713)
- Chinese version: [web-shell-detached-background-shell-liveness.zh-CN.md](./web-shell-detached-background-shell-liveness.zh-CN.md)

## Background

A workspace runtime (the ACP bridge child) owns every session of a workspace; background shells are grandchildren spawned by that child. When the runtime dies — daemon restart, bridge crash, hard kill — the session becomes persisted-only: it has a transcript on disk but no live entry in the workspace registry, so nothing can be asked about its background work.

Background shell sidecars write `shell-*.status` files under `<projectTempDir>/background-shells/<sessionId>/`. The registry settles sidecars to a terminal state on graceful exit only (`settleAsCancelled`), so a hard kill leaves stale `running` claims on disk. Before this change, the `.status` sidecars were write-only artifacts: no code ever read them back.

## Problem

The daemon session list only reports `hasRunningBackgroundTasks` from the live registry entry. For a persisted-only session that field is absent, the Web Shell believes the row has no known background work, and the delete flow lets it through — deleting the transcript while detached work may still be running. This is exactly the state combination created by the "seamless recovery" story: lazy respawn restores the transcript, but nothing restores (or even observes) the detached shells.

## Goals

- Recover a liveness signal for detached background shells of persisted-only sessions from on-disk evidence plus OS-level process verification.
- Surface the signal end to end: daemon session list → SDK/bridge types → Web Shell store → sidebar cue, tooltip, and delete dialog.
- Block deletion for verified-running detached work; treat unverifiable states as a hint, not a block.
- Keep the list response path safe: best-effort probing, bounded work per request, cached results.

## Non-goals

- A server-side delete-time check in `deleteDaemonSessions` (follow-up; see [Delete-time check](#delete-time-check-follow-up)).
- Recovering or reattaching detached shells; the signal is observational only.
- Windows process identity tokens (Linux procfs only in this iteration; see [Platform limits](#platform-limits)).

## Design

### Evidence model

The sidecar `.status` file is a claim, not a fact. It is read as a candidate pointer — pid plus identity token — and the verdict always comes from probing the OS process table. A stale claim therefore never produces a false "running"; it produces either a settled `dead` verdict or an `unknown`.

Verdict matrix per session (any sidecar can decide the whole session):

| Disk claim                                      | Process probe                                                                  | Verdict contribution                  |
| ----------------------------------------------- | ------------------------------------------------------------------------------ | ------------------------------------- |
| `running` / `cancelled` / `failed` (with token) | identity-verified alive                                                        | session is `running` (short-circuit)  |
| same claims                                     | namespace claim unconfirmable (no recorded claim, or Linux procfs read failed) | session is `unknown`                  |
| same claims                                     | pid has no owner (`ESRCH`) under a settled namespace claim                     | claim disproven — contributes nothing |
| same claims                                     | alive but identity unverifiable                                                | session is `unknown`                  |
| `completed` / `failed` without token            | skipped                                                                        | terminal, no process check needed     |
| unreadable / malformed / >16 KiB file           | —                                                                              | session is `unknown`                  |
| no sidecar directory                            | —                                                                              | no signal (field absent)              |

`cancelled` claims are still probed: `settleAsCancelled` writes the file before requesting cancellation, so the label cannot prove the process is gone.

### Identity verification

Reuses the existing primitives from `process-liveness.ts` (`readLocalBootId`, `readProcStartToken`, `readPidNamespaceId`, `isZombie`) — the same pattern as the channel pidfile identity check, generalized to sidecars written by another process:

- `bootId` mismatch → machine rebooted → cannot settle → `unknown`.
- pid namespace mismatch → different container/domain → `unknown`.
- `ESRCH` on `process.kill(pid, 0)` → no process owns the pid at all → claim disproven (`dead`). Only valid under a settled namespace claim: the record's namespace matches this host, or the platform has no pid namespaces at all. PID reuse cannot make a pid vanish, so this direction is safe without identity tokens.
- procfs start-ticks mismatch → pid reused by an unrelated process → `dead`.
- start-ticks match and not a zombie → `alive-verified`.

### Platform limits

Identity tokens are only written on Linux (procfs). On other platforms files carry no token; without a token a live pid cannot be distinguished from a reused one, so the probe returns `alive-unverified` → session `unknown`. `ESRCH` settles a dead pid only where the local pid table is authoritative: on platforms without pid namespaces, or when the record's namespace is confirmed to match this host. On Linux a failed `/proc/self/ns/pid` read is not "no namespaces" — sibling containers sharing the runtime directory keep the local table meaningless — so such records stay `unknown`. Adding a Windows identity token (process creation time) is a follow-up.

### Integration

- `session-list.ts`: two entry points (whole-list and catalog-page) call the resolver for persisted-only sessions only; `mergeLiveSessionSummary` drops the field whenever a live entry exists — live state is authoritative and the two channels must never double-report.
- Wire format: `detachedBackgroundWork?: 'running' | 'unknown'` on the session summary. Absent = no detached work observed; `not_running` is deliberately not representable (absent already carries it).
- Client: the catalog store keeps the field only for non-live rows; `hasLiveWork`/`sessionBlocksDelete` treat `'running'` as blocking; `'unknown'` renders a hollow, non-pulsing cue and an advisory line in the delete dialog — a hint, never a block. Blocking every unverifiable row would lock out quiet historical sessions on platforms without identity tokens.
- A 60 s slow refresh for subscribed persisted rows re-runs the resolver: verdicts change without a catalog version bump, so the version-gated reconcile would otherwise never refresh them.

### Budget and caching

- Results are cached per (project temp dir, session) for 45 s, including "no signal" verdicts, bounding both disk scans and pid probes.
- At most 100 uncached sessions are probed per call; the rest roll over to later refreshes. Probing happens after pagination, never across the whole catalog.
- Every probe failure degrades to `unknown` or "no signal" — never an error — because this runs inside the list response path.

## Delete-time check (follow-up)

The list/UI layer can be bypassed by a direct `POST /sessions/delete` call. The same resolver should be invoked inside the daemon delete handler to reject deletions whose sessions still have verified-running detached work. The design deliberately ships the read-side first; the delete gate is a small follow-up change reusing this module.

## Alternatives considered

- **Extend `requireIdle` to delete** — changes deletion semantics for every session with an active AI turn, breaking the documented behavior that rows with only an active turn remain selectable (#17713 tests pin this). Rejected.
- **Treat any sidecar claim as truth** — stale claims after a hard kill would block deletion of clean sessions forever. Rejected: claims must be verified against the OS.
- **Persist a "detached" flag in the session record** — cannot answer "is it still running"; the truth lives in the process table, not the record.

## Testing

- `detached-work-liveness.test.ts`: verdict matrix, caching, budget rollover, PID reuse, ESRCH degradation, malformed sidecars.
- `session-list.test.ts`: live-merge drops the field, pagination budget, persisted-only selection.
- `backgroundShellRegistry.test.ts`: identity tokens persisted with sidecars.
- Client tests: policy predicates, snapshot synthesis, cue rendering, dialog advisory.
- Manual: daemon restart with a live detached shell (Linux) leaves the row cued and deletion blocked; after the shell exits the row clears and deletion succeeds. On Windows, a hard-killed daemon kills the whole tree; stale `running` claims settle to "no signal" via `ESRCH`.

## Acceptance criteria

1. A persisted-only session with a verified-running detached shell shows a running cue and cannot be deleted from the dialog.
2. A persisted-only session whose detached shells all died on a namespace-less platform (or with a confirmed namespace match) shows no cue and can be deleted; where the namespace claim cannot be confirmed, it degrades to the unknown handling in criterion 3.
3. A persisted-only session with an unverifiable claim shows an unknown cue and a dialog hint; deletion stays possible.
4. Live sessions never carry the field, and re-attaching clears it.
5. The list response path stays bounded: cache hit or budget rollover, never an unbounded scan.
