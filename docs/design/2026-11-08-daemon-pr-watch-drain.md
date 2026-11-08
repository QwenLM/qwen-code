# Daemon PR watch: delivery drain

[English](2026-11-08-daemon-pr-watch-drain.md) | [简体中文](2026-11-08-daemon-pr-watch-drain.zh-CN.md)

Status: proposed (2026-11-08). This is the increment after [observation and transition detection](2026-11-08-daemon-pr-watch-observation.md) (merged as #16611) of [PR state transitions from the daemon PR refresh](2026-11-04-daemon-pr-state-transitions.md) (the "master design" below). It implements §4 Delivery and §5 Durability, together with the §2 watch-file deletion and `lastBoundAt` rules that the observation increment deferred to the drain because they need the drain's scan-completeness information. Configuration (§6) and the channel migration (§7) stay out (PR B). Like the observation, the whole path stays behind the internal off switch and is production-inert until the enablement increment populates its deps.

## Problem

The observation writes detected transitions into each PR watch file's `pending`, but nothing drains them: no recipient is resolved, no prompt is admitted, no dormant session is woken. The store has a writer but no reader, so a session that follows a PR receives no daemon notification when the PR's head, CI, mergeability or state changes. The GitHub channel's own bound delivery still handles watch events today; this increment adds the daemon-side drain that PR B will switch over to. Per master §7 no build may ever run both pollers, so the drain stays off until PR B removes the adapter watch.

## Current state

- Observation + detection (`packages/cli/src/serve/server/pr-watch-observation.ts`, #16611) appends transitions to `pending` (cap 16) under the PR lock; nothing reads `pending`. The timer hook is gated by `SESSION_PR_WATCH_OBSERVATION_ENABLED` (off) plus the unpopulated `getPrWatchDeps` seam.
- Watch store (`pr-watch-store.ts`, #16590): `PrWatchState` already carries `delivered` (cap 64), `pending[].served` and the role groups `review/verify/fix/untyped`; `readPrWatchStateSync`/`writePrWatchStateSync`/`deletePrWatchStateSync` take no lock of their own (the caller holds the `PathMutexRegistry` lock, which is not re-entrant). The owner-record claim/release exists.
- Channel-base prompt/template contract (`packages/channels/base/src/bound-session-prompt.ts`, #16523/#16576) is already shared: `validateBoundActionEntries`, `resolveBoundActionTemplate`, `renderBoundActionTemplate`, `buildBoundEventPrompt`, `sanitizePromptText`, and the caps (2,000 template / 200 title+sender / 6,000 body code points). The renderer already sanitises every value and uses a `Map` to block `%constructor%` prototype escape.
- `BoundSessionGoneError` / `BoundSessionUnavailableError` / `BoundSessionQueueFullError` are shared in `packages/channels/base/src/bound-session-delivery.ts`.
- Prompt admission is extracted (`routes/session-prompt-admission.ts`, #16543): `admitSessionPrompt(deps, input)` is synchronous, idempotency-keyed and classification-driven, callable in-process. `PROMPT_IDEMPOTENCY_KEY_MAX_LENGTH` is 200.
- Bindings scan (`routes/session-pr-bindings.ts`): `scanWorkspaceBindings` returns `SessionPrBindingSummary[]` (`sessionId`, `workspaceCwd`, `sourceType?`, `updatedAt?`, `prs[]` with `role?`) plus a `partial` flag. `updatedAt` is the shared recency rule (transcript mtime refined by bridge live activity); hidden-catalog and archived sessions are already excluded by attribution.
- Restore is still route-local: `restoreSessionHandler` is a ~650-line closure inside `registerSessionRoutes` (`routes/session.ts`); the channel wake reaches the same `POST /session/:id/resume` route through the SDK (`commands/channel/daemon-worker.ts`). There is no shared in-process restore function and no resume-drain hook.
- Recipient selection, partial-scan retention (`MAX_PARTIAL_RETAINED`) and Gone iteration are adapter-local private methods of `GithubAdapter.ts`.
- No "at most four concurrent restores" limiter exists anywhere.
- The autofix-pr pushed-head ledger building blocks are exported (`commands/autofix-pr/state.ts`: `vouchedScanRoots`, `autofixPrPaths`, `readState`, `readRegularFile`, `sameRepository`; `routes/autofix-pr-watches.ts`: async single-git-call `cloneWorktreesOf`), but there is no "read a candidate's ledger for this PR and judge self-push" composition.

## Goals

- Drain `pending` oldest-first under the PR's lock with the master §5 crash-window semantics: check `delivered` and the in-memory in-flight mark, resolve the recipient, set the mark, admit through `admitSessionPrompt`, then write `delivered`/`served` and remove the entry; a failed recording write keeps the mark and later drains only retry the write.
- Resolve one recipient per PR across the daemon (one per role group with role-aware actions), never one per workspace, lazily at delivery time, with the channel's legacy recency rule and partial-scan retention.
- Restore dormant recipients through an injected `wakeSession` dependency, at most four at once, with the channel's Gone/Unavailable split and `wakeDormant` defaulting on.
- Suppress self-pushed `head_change` per recipient via the autofix-pr ledger; never suppress the other three transitions.
- Deliver role-aware actions and the generic prompt through the shared channel-base contract, with the group-suffixed transition key as the `idempotencyKey`.
- Apply the §2 deletion and `lastBoundAt` rules on the drain's scan-completeness information.
- Keep the whole path behind the off switch: no config read, no production behaviour or API-volume change.

## Non-goals (this increment)

- Configuration (§6) and the channel migration/aliases (§7): PR B. The `sessionPrWatch` setting is not read.
- Daemon-level provision of the watch/drain deps in `run-qwen-serve.ts` (allowed-hosts discovery, the lock registry and watch dir, the admission/restore deps, and the listing→watch write + `listedKeys`): the enablement increment. The drain exposes a deps seam and is inert until it is populated and the switch is on.
- The shared restore extraction from `restoreSessionHandler`, the resume-drain hook, and the serve-lifecycle close reorder: these only run once the drain is enabled, so they land with the enablement increment where they can be exercised end-to-end. This increment injects `wakeSession` as a dependency and tests the drain's restore handling against it; the route is untouched.
- Fencing interactive writers (master §4 "Dormant sessions"): the session-writer-lease exposure is the channel's today and stays out of scope.
- Manual-push ledger (master open question 5): only pushes through the autofix-pr helper are recorded.

## Proposed changes

### Restore as an injected dependency

The drain restores a dormant recipient through an injected `wakeSession(sessionId, workspaceCwd)` that returns `restored` (with a `release` for the minted client registration), `gone`, or `unavailable`. The drain releases the registration once the delivered prompt settles, as the channel accessor does. The real implementation — extracting the workspace-session restore out of `restoreSessionHandler` into a function the route and the drain share, plus the resume-drain hook so `wakeDormant: false` entries deliver on the next live turn — lands with the enablement increment; this increment leaves the route untouched and tests the drain against a fake `wakeSession`.

### Drain orchestration

A new module `packages/cli/src/serve/server/pr-watch-drain.ts` exposes the per-tick drain and the per-PR drain step. The tick drains only when it holds the owner record (a non-owner drains nothing). For each watched PR, under one hold of the PR's `PathMutexRegistry` lock, it re-reads the watch file and drains `pending` oldest-first: skip a key already in `delivered` or marked in flight; resolve the recipient; set the in-memory in-flight mark; admit; then write the entry's key into `delivered` (and the group into `served`), removing the entry from `pending` once every matched group is served. The mark is cleared after that write, or when admission is rejected outright. If the recording write fails, the mark is kept and later drains only retry the write, never re-resolving or re-admitting. A pending entry older than 7 days is dropped with a log line. Only a dormant recipient's restore runs outside the lock with its key marked in flight; its admission re-acquires the lock, re-reads the file and skips the key if it is already in `delivered`. This gives the master §5 crash windows: re-detection before the write, drain after the write, and at-least-once re-admission after a restart between admission and the recording write.

### Recipient resolution

Recipients come from the in-process bindings scan over the workspaces the scan covers (trusted plus the primary). Exclude channel-owned sessions (`sourceType: 'channel'`); archived and hidden-catalog sessions are already excluded by the scan's attribution. Without actions the recipient is the single most-recently-active binder (`updatedAt`, the scan's recency rule); with actions each role group resolves its own most-recently-active binder whose template chain matches. On a partial scan, retain the rows the scan does not list from the last scan that did (bounded, oldest dropped first, mirroring the adapter's `MAX_PARTIAL_RETAINED`), and drop a retained row once a complete scan omits it; a retained winner that cannot be reached keeps the entry pending. A recipient archived or outranked between detection and drain loses nothing — the drain re-resolves the next binder. A workspace no longer registered, no longer covered, or whose generation is retired is skipped with a log line and re-resolved immediately before dispatch.

### Dormant restore

A bound session that is not live is restored through the injected `wakeSession`, then delivered to. Restores never run on the tick: the drain starts a dormant recipient's restore and admission without waiting (at most four at once; the rest wait for a later drain), the key stays in flight until they settle, and a restore timeout never stretches a tick. `wakeDormant` defaults on so a restart does not strand events; with it off the entry stays pending until the session's next live turn (the resume hook that drains it lands with enablement). Restore outcomes split as the channel's: a permanent Gone outcome (404 session record gone, or 409 `session_archived`/`worktree_session_superseded`/`worktree_marker_missing`/`worktree_reset_interrupted`) excludes the session and the drain re-resolves among the remaining binders, dropping the transition with a log line only when a complete scan leaves no candidate; a temporary outcome (timeout, 503, 429, 409 `restore_in_progress`/`session_busy`, `session_writer_conflict`) leaves the entry pending for the same recipient at the next drain. The drain's restore-error classification includes `session_writer_conflict` as temporary (the channel accessor's `deliverPrompt` 409 whitelist currently omits it; the drain does not reuse that whitelist).

### Self-pushed head suppression

For `head_change` only, a candidate whose own pushed-head ledger contains the new head is excluded and the drain re-resolves the next binder (within its role group with actions, the single winner without). The ledger is `pushedShas` in the autofix-pr watch state, resolved through the helper's own single-git-call discovery (`cloneWorktreesOf` from the candidate's clone — the bridge live summary's `worktree.path`, else the binding's `workspaceCwd` — then `vouchedScanRoots` and the regular-file check), read through `readRegularFile`/`readState`, and accepted only when `sameRepository` and the `sessionId` match. The untrusted primary uses the coordinate alone (no git runs in its checkout). Any refusal (absent, non-regular, unreadable, mismatched) means no ledger and the transition delivers. `lastKnownHeadSha` is deliberately not part of the ledger. `ci_failure`, `merge_conflict` and `state_change` are never suppressed.

### Role-aware actions and prompt construction

With actions set, delivery uses the shared channel-base contract: `validateBoundActionEntries` over the four bare transition types (no lane), `resolveBoundActionTemplate` per role group (`<role>:<type>` → `<role>:default` → `<type>` → `default`; untyped resolves only the bare chain), and `renderBoundActionTemplate` with the values (`%repo%`/`%pr%`/`%url%`/`%title%`/`%event%`/`%sender%`/`%role%`, `%event%` the bare type). Each matched group has its own winner, its own admission under the group-suffixed key, and a prompt built by `buildBoundEventPrompt` carrying the rendered instruction in the labelled trusted-instruction block; at most four deliveries per transition. A matched group with no eligible binder is skipped on a complete scan and waits on a partial one. Without actions, delivery is the single winner and the generic prompt (built-in role guidance when a role is present). The prompt's GitHub-derived lines pass through `sanitizePromptText` and the body keeps the 6,000-code-point cap. No display text is set; the reply stays in the session.

### Scan completeness: lastBoundAt and deletion

The drain refreshes `lastBoundAt` when a complete or partial scan lists a binder of the PR (or a retained row names it), under the PR lock. It deletes a watch file when a complete scan finds no binder, and otherwise once 7 days have passed since `lastBoundAt`; undelivered entries are dropped with a log line. On a partial scan only the 7-day rule applies. A read error other than absent/invalid skips the PR for the tick (no drain step, no deletion, no recording write). A PR bound again after deletion initialises silently; before deletion it resumes from its last observation.

### Lifecycle close reorder (deferred to enablement)

Reordering the serve lifecycle close (`serve-app-lifecycle.ts`) so the owner stops its PR watch — the timer, the drains, and every restore and admission in flight — before it removes the owner record (master §2) only matters once the drain runs. With the switch off no claim is attempted and no drain/restore/admission is in flight, so the reorder lands with the enablement increment.

### Timer wiring and the deps seam

The drain runs in the same gated timer block as the observation, after `runPrWatchObservationTick`, behind the off switch and its own `getPrDrainDeps` seam; the deps carry the admission/restore/registry/self-push access it needs. With the switch off (or the seam unpopulated) the block is inert and the refresh is unchanged. The resume hook that drains independently of the timer lands with enablement.

## Files affected

| File                                                         | Change                                                                                                                             |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| `packages/cli/src/serve/server/pr-watch-drain.ts` (new)      | per-tick + per-PR drain, recipient resolution, in-flight marks, self-push suppression, role-aware delivery, deletion/`lastBoundAt` |
| `packages/cli/src/serve/server/pr-watch-drain.test.ts` (new) | drain semantics, crash windows, recipient/retention, restore split, self-push, role groups, deletion                               |
| `packages/cli/src/serve/server/session-pr-refresh.ts`        | run the drain after the observation in the gated block; add the `getPrDrainDeps` seam                                              |
| `packages/cli/src/serve/routes/session.ts` (deferred)        | extract the shared restore from `restoreSessionHandler`; add the resume-drain hook (enablement)                                    |
| `packages/cli/src/serve/serve-app-lifecycle.ts` (deferred)   | stop the watch before removing the owner record (enablement)                                                                       |
| `packages/cli/src/serve/run-qwen-serve.ts` (deferred)        | populate the watch/drain deps with the enablement increment                                                                        |

## Key design decisions

1. **Reuse the merged contract, do not reimplement.** Prompt/template validation, resolution, rendering, the envelope, the admission and the error classes are all shared already; the drain adds only orchestration, recipient resolution, restore slots and the self-push composition.
2. **The file is the only baseline; delivery is PR-scoped.** Observation stays per workspace while detection and delivery are PR-scoped, so an unreachable/untrusted/retired binder holds no stale copy and simply becomes a candidate again when reachable.
3. **Admission counts as delivery.** As for the channel's bound relay, an admitted prompt queued behind a running turn is lost with the in-memory queue on restart; the watch file already records the key and does not re-inject it. `delivered` (not the per-session admission ring) stops a key being admitted to a different session.
4. **Restore is an injected dependency.** The drain consumes `wakeSession`; the shared restore extraction from the route lands with enablement so it can be tested end-to-end. The drain's restore-error classification is its own and treats `session_writer_conflict` as temporary.
5. **Off by default.** The drain is production-inert until the enablement increment populates the deps and PR B turns the switch on; no build runs both pollers.

## Constraints and risks

- With the switch off there is no behaviour or API-volume change; the risk is confined to the new module's tests and the gated hook. The core `routes/session.ts` is untouched this increment.
- The drain must not stretch a tick: restores run off-tick with at most four in flight, and every drain step is bounded by the PR lock and the pending cap.
- The self-push ledger is session-writable: a cost optimisation, not a trust boundary (master §4); a forged entry can redirect a `head_change` to the next binder but cannot silence the other three transitions.

## Validation plan

- Unit (drain): oldest-first drain; `delivered`/in-flight skip; recording-write failure keeps the mark and only retries the write; 7-day age drop; crash-window re-admission; non-owner drains nothing.
- Unit (recipient): single winner by recency; role-group winners; channel-owned excluded; partial retention and complete-scan drop; Gone re-resolve; retired/unregistered workspace skipped.
- Unit (restore): at most four concurrent; Gone vs temporary split incl. `session_writer_conflict`; `wakeDormant` off keeps pending; restored recipient delivered and registration released.
- Unit (self-push): `head_change` suppressed for a candidate whose ledger holds the head, re-resolved to the next binder; other transitions never suppressed; ledger refusal delivers; untrusted primary uses the coordinate.
- Unit (role-aware/prompt): group-suffixed keys; `served` per group; entry leaves pending once all matched groups served; generic prompt without actions; sanitisation and caps.
- Unit (deletion/`lastBoundAt`): complete-scan no-binder delete; 7-day rule on partial; read-error skip; re-bind initialises silently.
- Switch-off parity: the refresh/timer are unchanged; the drain seam is never read while off.

## Acceptance criteria

1. With the switch off, the timer and refresh behave exactly as before: no drain, no admission, no restore, no deletion.
2. With the switch on (tests), a pending transition is delivered once to the resolved recipient, recorded in `delivered`, and removed from `pending`; a retry deduplicates; a crash between admission and the recording write re-admits once.
3. A dormant recipient is restored (≤4 concurrent) and delivered to; a Gone recipient is re-resolved; a temporary failure keeps the entry pending.
4. A self-pushed `head_change` is suppressed for the pushing candidate and re-resolved; the other three transitions deliver regardless.
5. A watch file with no binder on a complete scan is deleted; `lastBoundAt` gates the 7-day rule on partial scans.
6. No transition is published anywhere; the reply stays in the session.

## Open questions

- Inherited from the master design (on-by-default timing, `cancelled`/`stale` CI predicate, manual-push ledger); none are decided here.
