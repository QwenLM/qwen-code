# Web Shell Detached Background Shell Liveness

- Status: draft
- Issue: [#17819](https://github.com/QwenLM/qwen-code/issues/17819)
- Companion design: [web-shell-sidebar-background-work-indicator.md](./web-shell-sidebar-background-work-indicator.md) (live-path indicator, #17713)
- Chinese version: [web-shell-detached-background-shell-liveness.zh-CN.md](./web-shell-detached-background-shell-liveness.zh-CN.md)

## Background

A workspace runtime (the ACP bridge child) owns every session of a workspace; background shells are grandchildren spawned by that child. When the runtime dies — daemon restart, bridge crash, hard kill — the session becomes persisted-only: it has a transcript on disk but no live entry in the workspace registry, so nothing can be asked about its background work.

Background shell sidecars write `shell-*.status` files under `<projectTempDir>/background-shells/<sessionId>/`. The registry settles sidecars to a terminal state on graceful exit only (`settleAsCancelled`), so a hard kill leaves stale `running` claims on disk. Before this change, no daemon-side code read them back — the only reader was the model itself, following the per-launch status-file guidance in `shell.ts` (`statusFileGuidance`).

## Problem

The daemon session list only reports `hasRunningBackgroundTasks` from the live registry entry. For a persisted-only session that field is absent, the Web Shell believes the row has no known background work, and the delete flow lets it through — deleting the transcript while detached work may still be running. This is exactly the state combination created by the "seamless recovery" story: lazy respawn restores the transcript, but nothing restores (or even observes) the detached shells.

## Goals

- Recover detached-shell liveness from disk and OS-level process verification, including after a session is reopened.
- Surface the signal end to end: daemon session list → SDK/bridge types → Web Shell store → sidebar cue, tooltip, and delete dialog.
- Block deletion for verified-running detached work; treat unverifiable states as a hint, not a block.
- Keep the list response path safe: best-effort probing, bounded work per request, cached results.

## Non-goals

- A server-side delete-time check in `deleteDaemonSessions` (follow-up; see [Delete-time check](#delete-time-check-follow-up)).
- Recovering or reattaching detached shells; the signal is observational only.
- Windows and macOS process identity tokens (Linux procfs only in this iteration; see [Platform limits](#platform-limits)).

## Design

### Evidence model

The sidecar `.status` file is a claim, not a fact. It is read as a candidate pointer — pid plus identity token — and the verdict always comes from probing the OS process table. A stale claim therefore never produces a false "running"; it produces either a settled `dead` verdict or an `unknown`.

Verdict matrix per session (any sidecar can decide the whole session):

| Disk claim                                             | Process probe                                                                                                              | Verdict contribution                                    |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `running` / `cancelled` / `failed` with identity token | token matches a live, non-zombie process                                                                                   | session is `running` (short-circuit)                    |
| same claims                                            | claim disproven — `ESRCH` under a settled namespace claim, or start-ticks mismatch / zombie                                | claim disproven — contributes nothing                   |
| same claims                                            | identity unconfirmable — bootId mismatch, foreign or unpaired namespace claim, failed procfs read, non-`ESRCH` probe error | session is `unknown`                                    |
| `running` / `cancelled` without token (non-Linux)      | no pid namespaces, so the local pid table is authoritative                                                                 | `ESRCH` disproves the claim; anything else is `unknown` |
| `running` / `cancelled` without token (Linux)          | no confirmable namespace claim anchors the record to this host                                                             | session is `unknown`                                    |
| `failed` without token                                 | skipped                                                                                                                    | terminal, no process check needed                       |
| `completed`                                            | skipped                                                                                                                    | terminal, no process check needed                       |
| unreadable / malformed / >16 KiB file                  | —                                                                                                                          | session is `unknown`                                    |
| no sidecar directory                                   | —                                                                                                                          | no signal (field absent)                                |

`cancelled` claims and token-carrying `failed` claims are still probed: `settleAsCancelled` writes the file before requesting cancellation, and transport errors are recorded before exit, so a terminal label cannot prove the process is gone.

### Identity verification

Reuses the existing primitives from `process-liveness.ts` (`readLocalBootId`, `readProcStartToken`, `readPidNamespaceId`, `isZombie`) — the same pattern as the channel pidfile identity check, generalized to sidecars written by another process:

- `bootId` mismatch → machine rebooted → cannot settle → `unknown`.
- pid namespace mismatch → different container/domain → `unknown`.
- `ESRCH` on `process.kill(pid, 0)` → no process owns the pid at all → claim disproven (`dead`). Only valid under a settled namespace claim: the record's namespace matches this host, or the platform has no pid namespaces at all. PID reuse cannot make a pid vanish, so this direction is safe without identity tokens.
- procfs start-ticks mismatch → pid reused by an unrelated process → `dead`.
- start-ticks match and not a zombie → `alive-verified`.

### Platform limits

Identity tokens are only written on Linux (procfs). On other platforms files carry no token; without a token a live pid cannot be distinguished from a reused one, so the probe returns `alive-unverified` → session `unknown`. `ESRCH` settles a dead pid only where the local pid table is authoritative: on platforms without pid namespaces, or when the record's namespace is confirmed to match this host. On Linux a failed `/proc/self/ns/pid` read is not "no namespaces" — sibling containers sharing the runtime directory keep the local table meaningless — so such records stay `unknown`. Background shells are spawned detached on POSIX, so a hard-killed daemon on macOS also leaves surviving shells; they carry no tokens there, so a live one reads `unknown` while a dead one is disproven by the local `ESRCH` (macOS has no pid namespaces). Adding a Windows and macOS identity token (process creation time) is a follow-up.

### Integration

- `session-list.ts`: both list paths probe the persisted rows on the page. For a live row, the resolver uses the live entry's creation time to exclude shells started in the current session lifetime. A shell from an earlier lifetime can coexist with work tracked by the live runtime.
- Wire format: `detachedBackgroundWork?: 'running' | 'unknown'` on the session summary. Absent = no detached work observed; `not_running` is deliberately not representable (absent already carries it).
- Client: live-state updates preserve the catalog's detached-shell observation. Either verified detached work or running live background work blocks deletion, and the UI shows one running indicator when both are present. An unknown detached observation still shows an advisory.
- The 60 s slow catalog refresh includes subscribed non-live rows and live rows with a detached-shell observation. An orphan shell can exit without changing the catalog version.

### Budget and caching

- Results are cached for 45 s per project temp directory and session, including "no signal" verdicts. Cache reuse requires the same live-entry cutoff.
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
- `session-list.test.ts`: the catalog reports old shells for reopened sessions, including when the live runtime holds other work.
- `backgroundShellRegistry.test.ts`: identity tokens persisted with sidecars.
- Client tests: live updates preserve old-shell evidence when a new task starts and ends. A slow refresh clears the delete guard after the old shell exits without a catalog version change.
- Manual: daemon restart with a live detached shell (Linux) leaves the row cued and deletion blocked; after the shell exits the row clears and deletion succeeds. On Windows, a hard-killed daemon kills the whole tree; stale `running` claims settle to "no signal" via `ESRCH`. On macOS, surviving detached shells read `unknown` and dead claims settle the same way.

## Acceptance criteria

1. A persisted-only session with a verified-running detached shell shows a running cue and cannot be deleted from the dialog.
2. A persisted-only session whose detached shells all died on a namespace-less platform (or with a confirmed namespace match) shows no cue and can be deleted; where the namespace claim cannot be confirmed, it degrades to the unknown handling in criterion 3.
3. A persisted-only session with an unverifiable claim shows an unknown cue and a dialog hint; deletion stays possible.
4. Reopening the session and completing a new background task both preserve the delete guard while the old shell runs. Once a fresh probe confirms the old shell exited and the live session is idle, deletion is available.
5. The list response path stays bounded: cache hit or budget rollover, never an unbounded scan.
