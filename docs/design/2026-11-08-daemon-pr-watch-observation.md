# Daemon PR watch: observation and transition detection

[English](2026-11-08-daemon-pr-watch-observation.md) | [简体中文](2026-11-08-daemon-pr-watch-observation.zh-CN.md)

Status: landed as #16611 (proposed 2026-11-08). This is the next increment of [PR state transitions from the daemon PR refresh](2026-11-04-daemon-pr-state-transitions.md) (the "master design" below). It implements §1 observation and §3 transition detection only; delivery (§4–§5), configuration (§6) and the channel migration (§7) stay out of this increment. The body below describes the increment as designed; PR B (#17214) later removed the internal switch, so enablement is now deps presence.

## Problem

The master design's foundations are merged: the per-PR watch store and its owner record (#16590), the single-PR `gh pr view` fetch and the exported `aggregateChecks` rollup (#16530, #16545), the shared bound-session prompt/template contract in `@qwen-code/channel-base` (#16523, #16576), and the extracted prompt admission (`routes/session-prompt-admission.ts`). Nothing yet observes a bound PR's head, CI or mergeability, and nothing detects a transition: `session-pr-refresh.ts` still only rewrites the sidecar `state` and `issues` for the sidebar. The store therefore has no writer.

## Current state

- `refreshWorkspaceSessionPrStates` (`packages/cli/src/serve/server/session-pr-refresh.ts`) sweeps one workspace's sidecars, runs a slim `gh pr list --state all` for `state`, a closing-issue lookup, and the Aone capped view loop. It has no head/CI/mergeability observation and no watch-file access.
- `startSessionPrRefreshTimer` walks trusted workspaces sequentially behind a `running` guard, advancing a per-workspace Aone offset. It computes no tick-level deadline and does not sweep the untrusted primary.
- `fetchGitHubPullRequestView(url, cwd, env?)` (`packages/core/src/utils/github-prs.ts`) returns `{ url, title, headSha, state, mergeable?, checks, failingChecks }` or a typed failure; it performs no host check (the caller must restrict hosts).
- `pr-watch-store.ts` (#16590) provides `readPrWatchStateSync`, `writePrWatchStateSync`, `deletePrWatchStateSync`, the owner-record claim/release, and the caps; its read/write take no lock of their own.
- The in-process bindings scan (`scanWorkspaceBindings` in `routes/session-pr-bindings.ts`) produces `SessionPrBindingSummary[]` with a `partial` flag; it is currently only called by the route handler.

## Goals

- Observe each bound PR's head, CI rollup and mergeability through one `gh pr view` by URL, under the master design §1 rules (view set, cap 30 rotating, tick-level deadline, allowed hosts, workspace environment, daemon-private working directory, cross-workspace per-tick dedup, untrusted-primary view-only).
- Detect the four transitions (§3) against the PR's watch file and persist the new observation, `ciFired` and `pending` entries in one atomic write under the PR's `PathMutexRegistry` lock.
- Keep the whole path behind an internal switch that stays **off**: with it off the refresh runs no view, writes no watch file, and its behaviour and API volume are unchanged (master acceptance criterion 4). The `sessionPrWatch` setting is not read.

## Non-goals (this increment)

- Delivery and the drain (§4–§5): `pending` entries are written but never admitted; recipient resolution, the shared restore, self-push suppression and role-aware actions land in the next increment.
- Configuration (§6) and the channel migration/aliases (§7).
- Watch-file deletion and `lastBoundAt` maintenance (§2): deletion needs the drain's scan-completeness rules; this increment only creates and updates files. The owner-record claim is wired so a non-owner observes nothing.
- The serve-lifecycle close reorder (§2): with no drain or restore in flight there is nothing to stop ahead of the record removal yet; the claim/release already exist.
- Daemon-level provision of the watch deps in `run-qwen-serve.ts` (allowed-hosts discovery from the `gh` config hosts and the hosted channels' web hosts, the lock registry and the watch dir): the timer exposes a `getPrWatchDeps` seam, but populating it is only exercised once the switch is on, so it lands with the enablement increment. With the switch off the seam is never read.
- Coupling the observation to the refresh's slim listing: the sweep accepts a `listedKeys` set (and tests it) so a closed PR the listing returned is not re-viewed, and master §1 also has the listing write a merged/closed PR's `state`/`observedAt` to the watch file. The orchestration itself does not run the listing; the enablement increment wired it through, so the refresh timer now carries `listedKeys` per workspace into the next tick and the listing writes `state`/`observedAt` — and the `state_change` the replaced view would have fired — to the watch file. A closed binding the listing covered is no longer re-viewed; one it did not cover still is, so a reopen is caught.

## Proposed changes

### New module `packages/cli/src/serve/server/pr-watch-observation.ts`

Two layers, both unit-testable without a daemon:

1. **Pure detection** — `detectPrTransitions(identity, previous, observation, detectedAt)`:
   - Input: the previous `PrWatchState` (or `undefined` for a first observation), a fresh observation (`state`, `title`, `headSha`, `checks`, `mergeable?`, `failingChecks`), and the observation's start timestamp.
   - Output: the next `PrWatchState` to write and the list of detected transitions (`type`, `key`, `summary`, `detectedAt`).
   - Rules exactly as master §3: `head_change` on a differing `headSha`; `ci_failure` when `checks` is `failing`, the previous observation of the same head was not, and the head is not in `ciFired` (append, cap 16); `merge_conflict` edge-triggered into `conflicting` (a never-known `mergeable` counts as non-conflicting once a `headSha` exists); `state_change` when `state` leaves `open`.
   - A first observation (no previous file, or a slim-only file with no `headSha`) initialises silently: it fills fields and fires nothing.
   - `mergeable: UNKNOWN` (absent in the observation) leaves the stored value in place and emits no transition; the no-overwrite is applied here when building the next state.
   - Keys use the master §3 shape `pr-state:<owner/repo>#<number>:<type>:<head or prev→next>:<detectedAt>`, hashed to `pr-state:h:<40 hex>` when the key plus the longest role-group suffix (`:untyped`, 8 chars) would exceed the prompt route's 200-character `idempotencyKey` cap — the suffix is appended at delivery (§4), so the base key reserves room for it.

2. **Observation sweep** — `observeWorkspacePrBindings(bindings, deps, options)`:
   - Builds the view set from the scan's bindings: open bound PRs plus closed PRs the slim listing did not return; merged is terminal by the newest observation. Foreign-host bindings are skipped with a log line before any `gh` call.
   - Restricts hosts to the allowed set (normalised lowercased, `www.` stripped): `github.com`, the daemon `gh` config hosts, and the hosted GitHub channels' web hosts.
   - Runs `fetchGitHubPullRequestView` by the binding URL with the workspace's `effectiveEnv` and the daemon-private watch directory as `cwd`, under a rotating offset and the tick deadline; the untrusted primary's views instead run with the daemon's own environment (master §1), so a credential planted in its checkout never authenticates a daemon request. The cap (30) bounds views actually started, not the rotated window: a PR already viewed by another workspace this tick is skipped without consuming the cap, so unique PRs past a skipped prefix are still observed (master §1 "a skipped view does not count against the cap"). A view that returns another host or number is logged and discarded, a renamed/transferred repository (same host and number, different `owner/repo`) is accepted and logged once per tick (the cross-workspace dedup views each PR once per tick). It asserts the workspace's generation guard before each view so a retired generation never runs `gh` with stale env.
   - For each accepted view, under the PR's `PathMutexRegistry` lock: read the watch file, discard an observation that started before the file's `observedAt`, run detection, and write the next state atomically. A read error other than absent/invalid skips the PR for the tick (fail closed).
   - Returns the consumed view count (for the timer's rotation) and per-PR failure isolation.

### Wiring in `session-pr-refresh.ts` and the timer

- An internal constant switch (off) gates the observation path; with it off `refreshWorkspaceSessionPrStates` and the timer are byte-for-byte behaviourally unchanged.
- The timer computes one tick-level deadline anchored at the tick start (half the refresh interval) and runs the observation phase BEFORE the state refresh, so a refresh that outruns half the interval cannot starve the observation of its deadline window. It rotates workspace order per tick, advances a per-workspace GitHub offset by the consumed view count, and sweeps the untrusted primary for views only. These apply only when the switch is on.
- The owner-record claim runs when the switch is on (reading the effective event set from config is deferred); a daemon that does not hold the record observes nothing. With the switch off no claim is attempted.

### Files affected

| File                                                               | Change                                                                                                                     |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| `packages/cli/src/serve/server/pr-watch-observation.ts` (new)      | pure detection + observation sweep + per-tick orchestration                                                                |
| `packages/cli/src/serve/server/pr-watch-observation.test.ts` (new) | detection rules, view-set/host/identity/rotation/deadline/dedup, fail-closed reads, owner gate                             |
| `packages/cli/src/serve/server/session-pr-url.ts` (new)            | `pullRequestKey`/`samePullRequest` moved out of the refresh, shared with the observation                                   |
| `packages/cli/src/serve/server/session-pr-refresh.ts`              | off-switch constant; gated timer hook with rotating order, GitHub offset and `getPrWatchDeps` seam                         |
| `packages/cli/src/serve/server/session-pr-refresh.test.ts`         | existing suite confirms the refresh is unchanged; adds a timer-level test that the off switch never reads `getPrWatchDeps` |
| `packages/cli/src/serve/routes/session-pr-bindings.ts`             | export `scanWorkspaceBindings` as the in-process scan entry point                                                          |
| `packages/cli/src/serve/run-qwen-serve.ts` (deferred)              | populate `getPrWatchDeps` (allowed hosts, lock registry, watch dir) with the enablement increment                          |

## Key design decisions

1. **Detection is pure and separate from I/O.** The transition rules are the part most likely to regress; isolating them lets the master §3 validation list be exercised directly without a daemon or `gh`.
2. **Off by default behind an internal constant, not a setting.** Matches master §7 PR A: no build ran the observer until a later increment enabled it, and the setting was not read yet. PR B (#17214) removed the constant outright rather than flipping it.
3. **No delivery, no deletion.** `pending` accumulates (bounded by the store cap) but is never drained; deletion and `lastBoundAt` wait for the drain increment so scan-completeness rules are decided in one place.
4. **Reuse, not reimplement.** The view fetch, rollup, store, lock registry and prompt contract are all merged; this increment adds only the observation orchestration and detection.

## Constraints and risks

- With the switch off (as shipped) there is no behaviour or API-volume change; the risk is confined to the new module's tests and the gated hook.
- The observation sweep must not stretch a tick past the deadline; the cap, rotating offset and tick-level deadline bound it, and a single in-flight view may outlive the deadline by its own timeout (master §1).
- Detection writes `pending` that nothing drains yet; the store's 16-entry cap bounds growth until the delivery increment lands. This is acceptable because the switch is off in every build.

## Validation plan

- Unit (detection): first observation silent; slim-only file fills silently; `head_change`; once-per-head `ci_failure` across a force-push revisit (`A failing → B failing → A failing` fires twice); per-head reset; edge-triggered conflict; first `conflicting` after `UNKNOWN`; `UNKNOWN` after `CONFLICTING` preserves and emits nothing; reopen → close; over-length key hashing.
- Unit (observation): view set (closed-not-listed viewed, merged terminal); allowed hosts (foreign host → no `gh` call; `www.github.com` equals `github.com`); identity (other host/number discarded; rename accepted); cap/rotation (two sweeps over 40 observe all 40, second wraps); tick deadline; cross-workspace per-tick dedup; fail-closed read skips the PR; per-PR failure isolation.
- Refresh: switch off → zero `gh pr view`, listing count unchanged; switch on with a fake view → watch files written, transitions in `pending`, nothing delivered.

## Acceptance criteria (this increment)

1. With the internal switch off, `refreshWorkspaceSessionPrStates` and the timer behave exactly as before: no `gh pr view`, no watch-file write, no claim.
2. With the switch on (tests), a bound PR's first observation initialises its watch file silently; a subsequent head/CI/conflict/state change appends the correct `pending` transition(s) under the PR lock, with once-per-head `ci_failure`.
3. A non-owner daemon observes nothing; a foreign-host binding causes no `gh` call; a view returning another host/number is discarded.
4. No transition is delivered and no watch file is deleted in this increment.

## Open questions

- Inherited from the master design (`review_decision`, Aone parity, manual-push ledger); none are decided here. On-by-default and the `cancelled`/`stale` CI predicate were settled on 2026-11-14: off by default, and core's predicate kept.

## Resolved implementation choices

- The internal switch is a module constant `SESSION_PR_WATCH_OBSERVATION_ENABLED` (off) gating the timer hook, with an `observationEnabled` timer-deps test seam defaulting to that constant so a fixture can exercise the on path; production omits the seam, so the constant governs. The sweep functions are exported and tested directly. Flipping the constant alone still no-ops until `getPrWatchDeps` is populated (fail closed).
