# Daemon PR watch: enablement wiring

[English](2026-11-09-daemon-pr-watch-enablement.md) | [简体中文](2026-11-09-daemon-pr-watch-enablement.zh-CN.md)

Status: proposed (2026-11-09), partially landed (#16732). This is the increment after [delivery drain](2026-11-08-daemon-pr-watch-drain.md) (merged as #16656) of [PR state transitions from the daemon PR refresh](2026-11-04-daemon-pr-state-transitions.md) (the "master design"). It covers the four items the drain increment deferred to enablement: the shared restore (§1), the resume-drain hook (§2), the lifecycle close reorder (§3), and the daemon-level deps provisioning (§4). **Landed so far in #16732: §3 in full, plus the host enumerator from §4.** §1, §2, the rest of §4 and §5 are still ahead; each section below is marked accordingly. **The off switch stays `false` and the `sessionPrWatch` setting is still not read** — configuration (§6), the channel alias and turning the switch on (§7) remain PR B. No build may ever run both pollers.

## Problem

The drain is complete but unreachable. `runPrWatchDrainTick` takes its restore, admission, registry and self-push access as injected dependencies, and nothing in production populates them: `getPrWatchDeps` and `getPrDrainDeps` have no production caller, `defaultPrWatchDir()` and `releasePrWatchOwnershipSync()` are referenced only by tests. Three consequences follow, and each is a defect the moment PR B flips the switch:

- A dormant recipient can never be woken. The real restore lives in `restoreSessionHandler`, a ~650-line closure inside `registerSessionRoutes` (`packages/cli/src/serve/routes/session.ts:4273-4922`), reachable only over HTTP. The channel reaches it through the SDK (`commands/channel/daemon-worker.ts:1057-1063`), which the daemon cannot use for its own in-process delivery.
- `wakeDormant: false` strands entries forever. The drain holds them for the session's next live turn, but no hook drains on resume, so nothing consumes them.
- Shutdown overlaps a successor. Nothing stops the watch or releases the owner record, so a successor daemon can claim while the predecessor's restores and admissions are still in flight (master §2).

Two further gaps are load-bearing for correctness rather than reachability: the observation discards the bindings scan's `partial` flag (its own comment says enablement MUST thread it before any negative decision), and the slim listing never writes `state` to a watch file nor supplies `listedKeys`, so a closed PR the listing returns stays in the view rotation forever.

## Current state

- **Restore is route-local.** The handler is `(action: 'load' | 'resume') => async (req, res) => …`. Its reusable core is the archive-coordinator shared lock (`session.ts:4498`) through the bridge `loadSession`/`resumeSession`, `cleanupRestoredSession` (`4803-4819`), the worktree reconcile (`reconcileRestoredSessionWorktree`, already a module-level fully-injected function at `930`), and the deferred-question fire. That core does not touch `req`/`res`. The HTTP coupling is concentrated in five places: input parsing helpers that write 400 to `res`; `resolveRuntimeForSessionRestore` (`2180-2299`), which writes six distinct failures to `res` and returns `undefined`; `setDaemonTelemetryWorkspace(res, …)`; three `!res.writable` disconnect-cleanup checks; and response shaping (`withPromptTerminals` / `redactSdkSurfaceReplay` / 200 JSON).
- **Typed errors are already pure.** `SessionNotFoundError`, `WorktreeSessionSupersededError`, the restore-conflict and session-limit errors all exist as classes before `sendBridgeError` translates them to wire shape (`server/error-response.ts`). An in-process caller can classify by class without any HTTP involvement. The 429 rate limit is a global middleware (`rate-limit.ts:277-289`), so an in-process caller never sees it.
- **Both locks and the detach are idempotent.** `RequestedSessionIdReservation.release()` is gated by a `released` boolean (`session-id-admission.ts:212-229`); the worktree ownership op release likewise (`server/worktree-ownership-op.ts:52-60`); `bridge.detachClient` no-ops for an unknown client and decrements a refcount otherwise. The last client leaving triggers idle close — which is exactly why the drain must release the registration it mints.
- **The channel's wake lifecycle is the model.** `createBoundSessionsAccessor`'s `wake` calls SDK resume and returns `restored.detach`; `deliverPrompt` releases it in a `finally` after the prompt settles, never before the retry (`daemon-worker.ts:1127-1134` and `692-703`). Its Gone set is 404 plus the 409s `session_archived`, `worktree_session_superseded`, `worktree_marker_missing`, `worktree_reset_interrupted`; everything else temporary.
- **The drain's seam is ready.** `PrWatchDrainDeps` already declares `wakeSession`, `admitPrompt`, `readPushedHeads`, `resolveRuntime`, `isSessionLive`, `scanBindings`, `actions`, `wakeDormant`; `runPrWatchDrainTick` already accepts the caller's `coveragePartial`. `admitSessionPrompt` is already extracted and callable in-process (#16543).
- **Timer provisioning has a precedent.** `run-qwen-serve.ts:7611` starts the refresh timer before the app exists and reaches the archive coordinator through a late-bound getter. The watch deps must use the same shape.
- **Lifecycle has a drain registry.** `ServeAppLifecycleController.addAppDrain` (`serve-app-lifecycle.ts:118`) feeds `closeOnce` (`198`), which seals admission, starts every drain and the listener close concurrently, and awaits them all with `Promise.allSettled` — a rejecting drain makes `close()` throw. `server.ts:4440` is an existing registration.
- **Host discovery has building blocks but no enumerator.** `resolveGithubWebOrigin(baseUrl)` (`packages/channels/github/src/web-origin.ts:14`) maps a channel's `baseUrl` to its web origin; `resolveChannelWorkspaceGroups` (`serve/channel-workspace-grouping.ts:128`) already applies the trust gating channel hosting uses. `gh`'s own configured hosts are not enumerated anywhere — the adapter only queries one host at a time via `gh auth token --hostname`, documenting go-gh's ConfigDir precedence at `GithubAdapter.ts:136-147`.

## Goals

- Extract the restore core into a function the route and the drain both call in-process, with the route's HTTP behaviour byte-compatible.
- Give the drain a real `wakeSession` that mints and releases a client registration, classifying outcomes as the channel does.
- Drain on resume so `wakeDormant: false` entries are consumed on the session's next live turn.
- Stop the watch and release the owner record on shutdown, after in-flight work settles.
- Populate both deps seams: watch directory and lock registry, allowed hosts, admission, restore, self-push ledger, and the scan's `partial`.
- Write the slim listing's `state` to watch files and supply `listedKeys`.
- Keep the switch off and the setting unread: zero behaviour or API-volume change in production.

## Non-goals

- `sessionPrWatch` configuration, its environment overrides, the channel alias and turning the switch on: **PR B** (master §6/§7).
- Removing the adapter watch: PR B. Until then the channel keeps its own poller and the daemon's stays inert.
- Fencing interactive writers (master §4): the session-writer-lease exposure is the channel's today and stays out.
- Manual-push ledger (master open question 5): only pushes through the autofix-pr helper are recorded.

## Proposed changes

### 1. Shared restore (not yet landed)

A new module `packages/cli/src/serve/server/session-restore.ts` exports the core as a function taking the runtime, the session id, the action, the validated options, and the closure state the route currently captures (`archiveCoordinator`, `requestedSessionIdAdmission`, the generation assertion, `materializeLiveConversationDirectory`, `daemonLog`). It returns the restored session plus a `release()` that detaches the minted client registration, and it **throws the existing typed errors** rather than writing a response.

The route keeps everything HTTP-specific: parsing, `resolveRuntimeForSessionRestore`, telemetry, the disconnect checks, response shaping, and the `sendBridgeError` translation. It calls the shared function inside its existing `try`/`catch`/`finally`, so the reservation and worktree-lock releases stay where they are and the ~70 existing HTTP tests keep passing unchanged.

Three boundaries are decided explicitly:

- **The legacy standalone adoption branch and the virtual-subagent branch stay in the route.** Both are HTTP-shaped early returns with their own rollback, and neither is a workspace session the drain can target. The shared function covers the workspace-session path only.
- **`res.writable` has no in-process analogue.** The shared function takes an optional `isCancelled` predicate; the route passes `() => !res.writable`, the drain passes nothing. The cleanup it guards moves into the shared function so both callers get it.
- **`resolveRuntimeForSessionRestore` is not extracted.** Its six `res` exits are routing decisions the drain does not make — the drain already knows the recipient's runtime and re-resolves it immediately before dispatch. Extracting it would mean inventing a typed-error variant for failures the in-process caller cannot hit.

### 2. Resume-drain hook (not yet landed)

The shared restore takes an optional `onRestored` callback, invoked after the session is live and the generation assertion passes, before the function returns. The route passes nothing (behaviour unchanged); the drain's `wakeSession` provisioning passes a hook that schedules a drain for that session's bound PRs.

The hook **must not be awaited inside the restore**. `PathMutexRegistry.runExclusive` is not re-entrant, and the drain's own `restoreAndAdmit` re-acquires the same per-PR lock after its wake. Awaiting a drain from inside a restore that a drain dispatched would invert the await direction and can deadlock. The hook therefore fires the drain without waiting (`void`, with its own failure logging), exactly as the drain already fires restores. It also runs after the reservation and worktree-lock releases, so a drain that re-enters the same session's restore cannot collide with the pending reservation count.

### 3. Lifecycle close reorder (landed in #16732)

Register an app drain that, in order: stops the refresh timer; waits for the claim-holding refresh tick and the drain's in-flight restores and admissions to settle; then releases the owner record via `releaseOwnedPrWatchSync`. Registering it through `addAppDrain` places it in `closeOnce`'s drain set, which `close()` awaits alongside the listener close. The lifecycle imposes no ordering between them, so the stop → settle → release sequence has to hold inside the drain itself.

The wait needs a settle signal the drain does not expose today. Add an `idle()` promise to the drain state that resolves when no drain tick and no restore is in flight. An admitted mark left by a failed recording write is not in-flight work — it is a retry the next owner performs — so it never holds the wait open.

That signal alone is **not** sufficient: the observation claims the owner record for the whole refresh tick and never enters a drain tick, so a shutdown landing mid-view would see an idle drain and release the record while this daemon is still viewing and about to drain. The wait therefore has two arms — `stopPrWatch` also takes a `waitForTick` settle promise, supplied by the refresh timer, that resolves when its in-flight tick ends.

The arms must be **sequential, not parallel**. Sampling drain-idle alongside the tick resolves it immediately (the tick has not entered a drain yet), and that same tick then dispatches a dormant restore which outlives it — so the record would be released while the restore is still admitting. `waitForTick` is awaited first and `idle()` is sampled only after it resolves; both share one timeout budget.

`idle()` itself is unbounded: `stopPrWatch` races the whole sequence against a timeout, since only the caller knows its shutdown deadline. The owner record is released **only after** the wait succeeds, so a successor never overlaps in-flight work (master §2). On timeout the record is deliberately **kept** — releasing it while a restore is still admitting would let a successor deliver the same transition twice, whereas leaving it is safe because the claim sweeps a record whose process is provably gone. A daemon that never claimed releases nothing, and a record this process does not own is left alone.

"Does not own" is decided by the **claim's own identity rule**, in the same order: `isLocalIdentity` before `isSameProcess`. Both sides call one predicate (`isOwnedByThisProcess`), so a future widening of the discriminator cannot land on only one of them. The release returns a reason (`released` / `absent` / `foreign` / `unreadable` / `lock`) rather than a bare boolean, and shutdown logs every refusal except `absent` — the ordinary never-claimed case, which stays silent. A matching PID number does not authorize deleting a record from another boot, machine or PID namespace sharing this home, and `isSameProcess` alone degrades to a PID-liveness check wherever no process token is readable (macOS/Windows) — which would delete a record the claim explicitly refuses.

### 4. Deps provisioning (host enumerator landed in #16732; the rest not yet)

`run-qwen-serve.ts` populates both seams through late-bound getters beside `getArchiveCoordinator`:

- **Watch directory and locks**: `defaultPrWatchDir()`, one `PathMutexRegistry` shared by observation and drain so the owner's in-process locks are authoritative for every file (master §2).
- **Allowed hosts**: `github.com`, the hosts in the daemon's own `gh` configuration, and the web origin of each GitHub channel this daemon hosts. A new helper enumerates `gh`'s `hosts.yml` keys following go-gh's ConfigDir precedence (`GH_CONFIG_DIR`, `XDG_CONFIG_HOME`, `%AppData%\GitHub CLI`, `HOME/.config/gh`), reading YAML with the repo's `node yaml` via `parseDocument(text, { logLevel: 'error' })`, never `parse`: the library emits its own `process.emitWarning` with the offending source text attached, bypassing both the catch and the caller's log, and a `hosts.yml` line carries an oauth token. Two paths do that — an unresolved tag, and `toJS()` stringifying a collection-valued mapping key — and neither lands in `doc.errors`/`doc.warnings`. `'error'` closes the class while still collecting diagnostics; `'silent'` must not be used, because it also drops the `MULTIPLE_DOCS` error. Errors and warnings are collected from the document and logged as a non-echoing code plus line number only; an unparseable document yields no hosts, a warning still yields the host names. Hosted channels come from `resolveChannelWorkspaceGroups`, so an untrusted workspace's settings never contribute; `resolveGithubWebOrigin` gives each one's host. Every host is normalised with `normalizeWatchHost`. A read failure degrades to `github.com` plus the hosted channels, with a log line — never to an empty set that would silently disable every view.
- **Admission**: `admitSessionPrompt` with the app's archive coordinator, riding the bound-relay classification (`channelPrompt: true`) so no PR-binding backfill runs on injected text (master §4).
- **Restore**: the shared restore from §1, mapping its typed outcomes to `PrWatchWakeOutcome` — success to `restored` with the registration's `release`, the Gone set to `gone`, everything else to `unavailable`. `session_writer_conflict` is temporary, as the drain's own classification already requires.
- **Self-push ledger**: `cloneWorktreesOf` from the candidate's clone (the bridge live summary's `worktree.path`, else the binding's `workspaceCwd`), then `vouchedScanRoots`, `autofixPrPaths`, `readState`, accepted only when `sameRepository` and the `sessionId` match. The untrusted primary uses the coordinate alone — no git runs in its checkout. Any refusal means no ledger and the transition delivers.
- **Actions**: not provisioned. `sessionPrWatch.actions` is PR B; the drain's empty-map normalisation already treats an absent map as the generic prompt.

### 5. Listing write, listedKeys and partial (not yet landed)

The refresh's slim listing already knows each listed PR's state. Under the same gate, and only when the daemon holds the owner record, write `state` and `observedAt` to that PR's watch file under its per-PR lock — the same atomic write the observation uses, initialising silently when no file exists. Collect the listed keys into `listedKeys` and pass them to the observation so a closed PR the listing returned leaves the view rotation (master §1).

Thread the bindings scan's `partial` flag into the observation options. The observation makes no negative decision today, but the drain already does, and the flag must reach it from the same scan rather than being recomputed. The drain's caller-side `coveragePartial` (added in #16656) stays: it covers the registry entries `listAll()` omits, which the scan's own flag cannot see.

## Files affected

| File                                                            | Change                                                                                                                |
| --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `packages/cli/src/serve/server/session-restore.ts` (new)        | the shared restore core, typed errors, `release()`, optional `isCancelled` and `onRestored`                           |
| `packages/cli/src/serve/routes/session.ts`                      | route delegates to the shared core; keeps parsing, runtime resolution, telemetry, disconnect checks, response shaping |
| `packages/cli/src/serve/server/pr-watch-drain.ts`               | `idle()` settle signal on the drain state, and `stopPrWatch` (stop, wait, then release)                               |
| `packages/cli/src/serve/server/pr-watch-store.ts`               | `releaseOwnedPrWatchSync`: release only a record this process owns                                                    |
| `packages/cli/src/serve/server/pr-watch-gh-hosts.ts` (new)      | enumerate the daemon's `gh` configured hosts                                                                          |
| `packages/cli/src/serve/server/pr-watch-deps.ts` (new)          | build the observation and drain deps: hosts, admission, restore mapping, ledger                                       |
| `packages/cli/src/serve/run-qwen-serve.ts`                      | populate both seams via late-bound getters; register the shutdown drain                                               |
| `packages/cli/src/serve/serve-app-lifecycle.ts`                 | no shape change; the new drain registers through the existing `addAppDrain`                                           |
| `packages/cli/src/serve/server/session-pr-refresh.ts`           | listing→watch write, `listedKeys`, `partial` threading; `stopWatch` and the tick settle signal                        |
| `docs/design/2026-11-09-daemon-pr-watch-enablement.md` (+zh-CN) | this design                                                                                                           |

Rows for `session-restore.ts`, `pr-watch-deps.ts` and `routes/session.ts` are not part of #16732 — they land with §1, §2 and the rest of §4. Two more rows are partial: `session-pr-refresh.ts` landed `stopWatch` and the tick settle signal but not the listing write, `listedKeys` or `partial` threading; `run-qwen-serve.ts` landed the shutdown drain registration but not the two seams.

## Key design decisions

1. **Extract the core, not the handler.** The res-coupled parts are routing and wire concerns the drain does not share. Extracting them would invent typed variants for failures an in-process caller cannot reach, and would put ~70 HTTP response-shape tests at risk for no gain.
2. **Typed errors, not a result union, at the restore boundary.** The classes already exist and `sendBridgeError` already maps them. The drain's adapter classifies by class, so the Gone/temporary split lives in one place and cannot drift from the route's wire mapping.
3. **The hook is fire-and-forget and runs after the locks release.** This is the deadlock avoidance, not an optimisation: the per-PR lock is not re-entrant and the drain's restore path re-acquires it.
4. **Release the owner record last, and wait on both arms in order.** Stopping the timer is not enough; the claim-holding observation tick and the in-flight restores and admissions must all settle first, or a successor overlaps them. Drain-idle alone misses the observation, which never enters a drain tick — and sampling it in parallel with the tick misses the restore that tick dispatches on its way out. Release also applies the claim's identity rule, not just process liveness.
5. **The composed allowed-host set fails open, never to empty.** The enumerator itself returns an empty set on every read or parse failure and never throws; the fail-open guarantee lives in the composition, which always includes `github.com`. An empty allowed-host set would silently disable every view while looking healthy, so the guarantee is stated where it is actually enforced.
6. **Still off.** Every new path is behind the existing switch and the unpopulated-until-PR-B setting, so this increment changes no production behaviour.
7. **No credential may reach stderr by any path.** Sanitizing the thrown parse error is not enough: the library emits warnings itself, from both the parse and the `toJS()` step, with the source text attached. Set `logLevel: 'error'` so it never emits, and collect diagnostics from the document instead. Assert containment against `process.emitWarning` as well as the injected log — and capture the spy's calls _before_ restoring it, since `mockRestore` clears the history and an afterwards-read assertion is vacuous.

## Constraints and risks

- The restore extraction is the highest-risk change: a byte-equivalence refactor of a 650-line closure with ~70 HTTP tests plus worktree, multi-workspace and prompt-terminal suites pinning it. The route must keep its exact status codes, response fields and `Retry-After` headers.
- The switch-off parity must hold: no claim, no view, no watch write, no admission, no restore, and no new owner-record release attempt when the daemon never claimed.
- `run-qwen-serve.ts` is in the serve fast-path pre-listen closure. The new deps module must not pull the SessionService chain into that static closure; the refresh timer's existing dynamic-import boundary is the model.
- The lifecycle wait must be bounded: a hung restore cannot hold shutdown past the controller's deadline.

## Validation plan

- Unit (shared restore): the core returns the restored session and a releasing handle; typed errors propagate unchanged; `isCancelled` triggers the same cleanup as a disconnect; `onRestored` fires after the locks release and is not awaited.
- Route parity: the existing load/resume, worktree-classification, prompt-terminal, multi-workspace and REST-contract suites pass unchanged — they are the byte-compatibility oracle.
- Unit (wake mapping): each Gone code maps to `gone`, each temporary code to `unavailable`, success to `restored` with a release that detaches exactly once.
- Unit (hook): a resume drains the session's bound PRs; a hanging drain does not lengthen the restore; the per-PR lock is never re-entered.
- Unit (lifecycle): close stops the timer, waits for in-flight work, then releases the record; a hung restore times out rather than blocking; a non-owner releases nothing. Two ordering cases are load-bearing: shutdown mid-observation (drain-idle is already true), and shutdown mid-observation where the tick then dispatches a restore that outlives it — the record must survive until that restore settles. Identity: a record the claim refuses (foreign boot, or a foreign PID namespace whose process token still matches) is never deleted, on every platform; a record held by another live PID with no process token is refused too. Both stop-timer arms are pinned by effect, not mechanism: with the watch on, three further intervals after `stopWatch` produce no view, no listing and no re-claim; with it off, the early return's `dispose()` is pinned by stopping before any tick and then advancing a full day with no listing. The off case must stop pre-tick — once a sweep is in flight its `running` guard skips later ticks under fake timers, so a post-sweep count cannot distinguish an armed timer from a stopped one. A refused release is logged; a never-claimed one stays silent. Wiring: a real daemon boot whose refresh timer is stubbed must reach `stopWatch` through `close()` — the sibling serve suite mocks the refresh chunk to throw, so this lives in its own file. The Windows `%AppData%` branch is exercised by stubbing the platform rather than gating on it, because the PR CI profile skips the Windows lane.
- Unit (hosts): `github.com` with no channel; a `hosts.yml` entry; a hosted channel's enterprise web origin; an untrusted workspace's channel contributes nothing; a read failure degrades to the known-safe set with a log. Credential containment covers every emission path: a thrown parse error, an unresolved-tag warning, and `toJS()` stringifying a collection-valued key (three spellings, asserted on the token prefix because the library truncates long keys) — each asserted against both the log and `process.emitWarning`. The symlink refusal is POSIX-gated like the FIFO one, since `O_NOFOLLOW` does not exist on Windows.
- Unit (listing): a listed closed PR leaves the view rotation; the listing's `state` write initialises silently and takes the per-PR lock; `partial` reaches the drain.
- Switch-off parity: with the switch off, none of the new seams is read and the refresh is unchanged.
- Real scenarios: extend the existing POSIX scenario suite to drive the real shared restore through the drain's `wakeSession`, and a real shutdown ordering probe.

## Acceptance criteria

1. With the switch off, production behaviour and API volume are unchanged; no new seam is read.
2. The route's HTTP behaviour is byte-compatible: every existing load/resume test passes without modification.
3. With the switch on (tests), a dormant recipient is restored through the shared core, delivered to, and its registration released once the prompt settles.
4. `wakeDormant: false` entries are consumed on the session's next resume.
5. Shutdown stops the watch, waits for in-flight work, and only then releases the owner record.
6. A closed PR the slim listing returns is not viewed again; the listing's `state` reaches the watch file.
7. Views go only to allowed hosts; a binding on any other host causes no `gh` call.

## Open questions

- Inherited from the master design (default-on timing, `cancelled`/`stale` CI predicates, manual-push ledger); none decided here.
- Whether the `gh` hosts enumeration should cache across ticks. Proposed: read once per deps build, since a host added while the daemon runs is an operator action that a restart already covers; revisit if PR B's alias needs live channel hosting changes.
