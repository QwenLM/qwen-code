# PR state transitions from the daemon PR refresh

[English](2026-11-04-daemon-pr-state-transitions.md) | [简体中文](2026-11-04-daemon-pr-state-transitions.zh-CN.md)

Status: proposed (2026-11-04). Once implemented, this supersedes the "PR state watch" part of [GitHub Channel Events to PR-Bound Sessions](2026-11-02-github-channel-bound-session-events.md); the comment-delivery part of that design is unchanged.

## Problem

The daemon tracks the state of every PR a session is bound to twice, with two credentials, two schedules and two definitions of "CI failed":

1. `packages/cli/src/serve/server/session-pr-refresh.ts` already sweeps every trusted workspace's PR sidecars every 5 minutes (`QWEN_SESSION_PR_REFRESH_MINUTES`), runs `gh pr list` with the daemon host's `gh` credential, and rewrites each sidecar's `state` (open / merged / closed) and closing issues. The Web Shell sidebar reads the result. Nothing is delivered to the session.
2. The GitHub channel's PR state watch (`runPrStateWatch` in `packages/channels/github/src/GithubAdapter.ts`) polls every bound PR once per channel poll (60 s by default) with the channel's own token through Octokit: `pulls.get` per PR, plus `checks.listForRef` and the combined status on a conditional schedule, capped at 30 PRs, with its own `github-pr-watch.json` state file, pending queue, fired ring, dead-letter and reconciliation rules. It detects `ci_failure`, `merge_conflict`, `head_change` and `state_change`, and delivers them into the bound session through the daemon's prompt route.

The second poller exists only where an operator configured a GitHub channel with `deliverToBoundSessions` and `prWatchEvents`. A session that follows a PR without such a channel never hears that its CI went red. Where both run, the same PR is fetched by both, the channel's CI aggregate excludes `cancelled` / `stale` while core's rollup (`aggregateChecks` in `packages/core/src/utils/github-prs.ts`) counts them, and the channel's API budget at the cap is roughly 1,800 `pulls.get` calls per hour plus bounded re-checks, against 12 `gh pr list` calls per hour per workspace for the refresh.

## Current state

- Sidecar schema (`packages/core/src/services/session-pr-service.ts`, `SessionPr`): `number`, `url`, `createdAt`, `state?`, `source?`, `issues?`. No head SHA, CI rollup or mergeability is persisted, so a refresh cannot see a transition.
- The refresh's GitHub path fetches `gh pr list --state all --limit 500` in **slim** mode (`number,url,headRefName,state`) because the CI rollup field makes large `--state all` queries hit GitHub GraphQL server timeouts (504). `GH_PR_LIST_FIELDS` (non-slim) already carries `statusCheckRollup`, `isDraft`, `reviewDecision`, `updatedAt`, but not `headRefOid` or `mergeable`.
- The daemon already injects prompts into sessions it does not own the keyboard of: the channel bound relay (`POST /session/:id/prompt` with the `qwen.channel.prompt` / `qwen.daemon.channelBoundRelay` markers and an `idempotencyKey`), and it restores dormant sessions through the `/session/:id/resume` path. Both are in-process code paths the refresh can call without HTTP.
- The channel watch's user-facing semantics are documented in `docs/users/features/channels/github.md` and were merged on 2026-11-03 (#16117) and shipped in v0.26.7 (2026-11-04), whose release notes name the feature; `prWatchEvents` is therefore a released, operator-configurable setting.

## Goals

- One source of PR state: the daemon refresh. It observes head, CI and mergeability alongside the state it already refreshes, and delivers the four transitions into the session that follows the PR.
- No GitHub channel needed to receive PR state events; the channel keeps delivering GitHub _conversation_ events (comments, review requests, assignments).
- No new polling loop and no new state file: the sidecar is the snapshot and the durable queue.
- Remove the adapter's PR state watch and its configuration.

## Non-goals

- Webhook push ingestion (unchanged future work).
- Aone merge requests: the refresh's Aone path keeps refreshing `state` only; transitions for Aone can follow the same shape later.
- Comment events: they stay in the GitHub channel's notification lane and its bound-session delivery.
- New event types (`review_decision` is fetched already and is an open question below, not part of this change).

## Design

### 1. Observation

The refresh keeps its slim `--state all` listing for `state` and adds one `gh pr view <number> --json headRefOid,mergeable,state,statusCheckRollup` per **open** bound PR of the workspace, capped at 30 per sweep with a rotating window of the same shape as the Aone path's `sweepStart`; the GitHub path reports its own consumed count and the timer advances a GitHub offset per workspace (today only the Aone path reports one), so two consecutive sweeps over 40 open bound PRs view disjoint windows and a workspace with more than 30 open bound PRs still observes every one over consecutive sweeps. The loop runs under the Aone loop's aggregate view budget (`AONE_SWEEP_VIEW_BUDGET_MS`, 60 s): once the budget is spent the sweep starts no further views, the rotation advances by the views actually started, and a failed view or delivery for one PR is isolated so the rest of the workspace's sweep continues — otherwise 30 views hanging at `GH_TIMEOUT_MS` could occupy the whole interval and the re-entrancy guard would skip the next tick for every workspace. A PR bound in several workspaces is viewed once per sweep cycle: the sweep that views it stamps the block in every sibling sidecar (§4), and a later sweep in the same cycle skips the view when the PR's newest sibling `observedAt` is younger than the refresh interval. A single-PR view does not hit the bulk-rollup timeout. Merged and closed PRs are observed only through the slim listing; nothing is fetched per PR for them, but that observation updates the `watch` block (its `state` and `observedAt`) exactly as a view does, so the recovery rule below holds for terminal states too. With `sessionPrWatch.events` unset, no `gh pr view` runs at all and the listing is unchanged (acceptance criterion 4).

`mergeable` is mapped `MERGEABLE → mergeable`, `CONFLICTING → conflicting`, `UNKNOWN → undefined` (GitHub still computing; never overwrites the last known value). The no-overwrite rule is a merge rule in the sidecar write, not in the mapper: an `UNKNOWN` observation leaves the stored `mergeable` in place and emits no transition. CI uses core's existing `aggregateChecks` rollup (`passing` / `failing` / `pending` / `none`): one definition for the sidebar and for events.

### 2. Snapshot in the sidecar

`SessionPr` gains an optional `watch` block, written by the same mutation queue and cross-process lock as `state` through its own mutation helper (`updateSessionPrWatch`): `updateSessionPrStates` returns early when neither `state` nor `issues` moved, so a head-only observation routed through it would never persist and the baseline would never move:

```ts
watch?: {
  /** Observation version: the time of the observation that last updated this block — a `gh pr view` for an open PR, the slim listing for a merged or closed one. The newest sibling block is the detection baseline. */
  observedAt?: string;
  /** The state seen at `observedAt`, paired with it so a baseline carries the state of the same observation; the top-level `state` stays the sidebar field. */
  state?: 'open' | 'merged' | 'closed';
  headSha?: string;
  checks?: 'passing' | 'failing' | 'pending' | 'none';
  mergeable?: 'mergeable' | 'conflicting';
  /** Heads for which ci_failure already fired, oldest first (cap 16). */
  ciFired?: string[];
  /** Detected but not yet delivered transitions, oldest first (cap 16). PR-scoped: the same entries are written to every active sidecar bound to the PR, so the queue survives the recipient being archived or outranked. */
  pending?: Array<{ type: PrTransitionType; key: string; summary: string; detectedAt: string }>;
}
```

The first observation of a PR initializes the block silently. Entries persisted before this change have no block and are initialized on their next sweep.

### 3. Transition rules

The channel watch's transition rules, so operators who move over see the same transitions, with one deliberate CI-predicate difference (key decision 5, open question 2: core's rollup counts `cancelled` / `stale` runs as failing where the channel's aggregate excluded them):

| Event            | Fires when                                                                                                                                                     |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `head_change`    | `headSha` differs from the previous observation (a force-push back to a recent SHA is a new transition).                                                       |
| `ci_failure`     | `checks` becomes `failing` and `headSha` is not in `ciFired`; appends it, so it fires once per head even if CI flaps or a force-push revisits an earlier head. |
| `merge_conflict` | `mergeable` becomes `conflicting` from a non-conflicting observation (edge-triggered; `conflicting → mergeable → conflicting` fires again).                    |
| `state_change`   | `state` leaves `open` (merged or closed). A reopen returns `state` to `open`, so a later close fires again.                                                    |

Each transition's key is `pr-state:<owner/repo>#<number>:<type>:<headSha or previous→next>:<detectedAt>`; `detectedAt` keeps re-detected instances distinct across sidecar resets while `ci_failure` stays once-per-head through `ciFired`. `ciFired` is the daemon's equivalent of the channel's durable `fired` ring: bounded per-head history, so `A failing → B failing → A failing` after a force-push back to `A` does not fire a second time for `A`. The bound differs deliberately: the channel keeps 64 keys shared by all four event types per PR and pins only the current head once they are evicted, while the daemon keeps the last 16 failing heads of each PR; a head revisited after more than 16 other failing heads fires again, as it does in the channel after eviction. A key longer than the prompt route's 200-character `idempotencyKey` cap is hashed deterministically into `pr-state:h:<first 40 hex of sha256>`, the channel's shape, so retries still dedupe (a long `owner/repo` with the two-SHA `previous→next` form reaches 275 characters).

### 4. Delivery

- **Target.** One recipient per PR across the whole daemon, never one per workspace. Observation stays per workspace (each sweep views the open bound PRs of its own workspace, deduplicated by freshness as §1 says), but detection and delivery are PR-scoped. When a sweep detects a transition it writes the new snapshot, the fired record and the `pending` entry to **every active sidecar bound to the PR, in every trusted workspace** — the process-global sidecar scan behind `GET /sessions/pr-bindings` enumerates them — through each sidecar's own mutation queue and lock. The recipient is resolved lazily, at delivery time: among every eligible session bound to the PR across all trusted workspaces, the most recently active one (transcript mtime, refined by the bridge's live activity), the rule the channel applies to the whole bindings snapshot today, dispatched through that session's owning runtime. Because `pending` is PR-scoped, a recipient that is archived or outranked between detection and drain loses nothing: the drain finds the same entry in a sibling sidecar and delivers it under its original key. **Baseline rule:** detection never compares the fresh view with the sweep's own sidecar alone; before comparing, the sweep reads the PR's `watch` block from every sidecar bound to it and takes the newest by `observedAt` as the baseline — the whole block of that one observation (`state`, `headSha`, `checks`, `mergeable`, and its still-pending entries), never fields mixed from several sidecars. A sibling left behind by a crash adopts the newer block silently, pending entries included — no transition, no new key. A `partial` answer from the scan is no baseline evidence: if the scan could not enumerate every sidecar bound to the PR (a draining, transitioning or blocked workspace, a failed sidecar read), the sweep skips detection for that PR this sweep instead of comparing against an unconfirmed baseline; the slim-listing `state` refresh is unaffected. **Trust and retirement:** each sibling is re-resolved immediately before its write, and the recipient immediately before dispatch; a workspace that is no longer registered or trusted, or whose runtime generation is retired (`assertGenerationOpen()`), is skipped with a log line and treated as the crash window (its sidecar catches up through the baseline rule later), and an untrusted workspace is never a delivery target. Two registered workspaces for one repository, each with a session following the same PR, therefore produce one delivery, not two, with or without a crash in between. Archived sessions are refreshed for `state` but never delivered to. Channel-owned sessions (`sourceType: 'channel'`) and machine-owned hidden-catalog sessions are never targets.
- **Mechanism.** The refresh calls the daemon's prompt admission in-process — the code behind `POST /session/:id/prompt` — with a daemon-origin classification that admission treats like the channel bound relay: not an interactive user prompt (no loop-detected rejection, no PR-binding backfill on the injected text, a "PR event" display projection), with the transition key as the `idempotencyKey` so a retry within the daemon's lifetime deduplicates into the original admission. The classification is provenance-bound, not string-bound: it is passed as a trusted in-process parameter of the admission call (the shape `context.channelPrompt` already has, which the route and the bridge re-arm only from trusted context, never from request `_meta`). The marker name `qwen.daemon.prStateEvent` appears in the display projection and in both strip lists (route and bridge) as defence in depth; a client body carrying it is stripped and gains nothing, pinned by a route test like the existing forged-`qwen.channel.prompt` cases.
- **Dormant sessions.** A session that is bound but not live is restored through the same resume path the channel accessor uses, then delivered to; `wakeDormant` is on by default so a daemon restart does not lose events; with `wakeDormant: false` the transition stays in `pending` and is delivered on the session's next live turn (the drain also runs on resume), the 16-per-PR cap still applies and eviction logs, so nothing vanishes silently. A session that cannot be restored (record deleted, archived, worktree superseded) drops the transition with a log line; nothing is ever published anywhere.
- **Prompt text.** The channel's bound prompt shape: an event header, the untrusted-event-data notice, PR identity (repo, number, title, URL), an `Event:` line and the summary (`ci_failure` names up to five failed checks from the rollup). The reply stays in the session.

### 5. Durability

Detection and the new snapshot are persisted by one sidecar write per sidecar bound to the PR, each with the transition appended to its `pending`; delivery then drains `pending` oldest-first, grouping identical keys across the PR's sidecars, admits each key once to the recipient resolved at that moment, and clears the key from every sidecar after admission. The four crash windows resolve as: before the first write, the transition is re-detected next sweep (no loss, nothing delivered); between sidecar writes, the sidecars left behind catch up through the baseline rule — adopting the newer block and its pending entries without detecting anything — and the next sweep drains the key once; after all writes and before delivery, the next sweep drains `pending` first; after delivery and before the clear, the next sweep re-delivers and the admission ring deduplicates it within the daemon's lifetime (at-least-once across a restart, the same trade the channel made). `pending` is capped at 16 per PR; overflow drops the oldest with a log line.

### 6. Configuration

A daemon-level setting read the way the refresh interval is: `sessionPrWatch: { events: ['ci_failure', 'merge_conflict', 'head_change', 'state_change'], wakeDormant?: boolean }` with `QWEN_SESSION_PR_WATCH_EVENTS` and `QWEN_SESSION_PR_WATCH_WAKE_DORMANT` as the environment overrides. Default: no events (off); `wakeDormant` defaults to true, and `false` keeps transitions for dormant sessions in `pending` until their next live turn (§4). Latency is the refresh interval (5 minutes by default; values below one minute fall back to the default and `0` disables the sweep).

### 7. Channel migration

The GitHub channel's `deliverToBoundSessions` is unchanged. `prWatchEvents`, the watch pass, the watch state file, its task-store branches, the 30-PR cap and the CI re-check intervals are removed from the adapter; `connect()` keeps accepting `prWatchEvents` for one minor release as a deprecation window: it logs exactly one warning naming `sessionPrWatch`, ignores the field (no watch pass runs), and the Web Shell descriptor marks it deprecated; the first minor release after PR B rejects it at `connect()` with the same message. The setting shipped in v0.26.7, and a shipped, release-noted option is not rejected on sight even though it is opt-in behind `deliverToBoundSessions` and adoption is plausibly near zero. Overlap rule for the window between A and B: while a configured GitHub channel still has `prWatchEvents` set for a repository, the daemon skips that repository's PRs (no observation, no delivery) and logs once, so the two pollers never deliver the same transition twice or fetch the same PR twice; once B lands, or the operator clears `prWatchEvents`, the daemon takes over. Two PRs: A adds the daemon observation, delivery and configuration; B removes the adapter watch and updates the channel docs, landing after A.

## Key decisions

1. **The daemon owns PR state.** It already polls it for the sidebar with the host credential; adding three fields and a delivery step is cheaper than a second poller, and it serves every bound session, not only those behind a configured channel.
2. **Per-PR `gh pr view`, not the bulk rollup.** The refresh's slim bulk listing exists because the rollup field times out on large `--state all` queries; single-PR views avoid that and are bounded by the number of open bound PRs (cap 30 per sweep, rotating).
3. **Same selection and transition rules as the channel watch**, so operators moving over see the same events, with one deliberate CI-predicate difference (decision 5, open question 2).
4. **The sidecar is the queue.** No new state file: the snapshot and the pending transitions ride the existing serialized, cross-process-locked sidecar write.
5. **One CI definition** (core's rollup), accepting that `cancelled` and `stale` count as failing until the open question below is settled.
6. **One-release deprecation window** for `prWatchEvents`: v0.26.7 shipped it (#16117, released 2026-11-04) and names it in the release notes, so it is not rejected on sight; adoption is plausibly near zero (hours old, opt-in behind `deliverToBoundSessions`), so one minor release of warn-and-ignore is enough before `connect()` rejects it.
7. **Off by default** in this change; turning it on by default is a product decision for later.

## Files affected

| Layer          | File                                                                                             | Change                                                                                                                                                                                     |
| -------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| core           | `packages/core/src/services/session-pr-service.ts`                                               | `watch` block on `SessionPr`; `updateSessionPrWatch` mutation helper (snapshot + PR-scoped pending; `updateSessionPrStates` returns early without a `state`/`issues` change); drain helper |
| core           | `packages/core/src/utils/github-prs.ts`                                                          | `fetchGitHubPullRequestView(number)` with `headRefOid`, `mergeable`, rollup; mapping                                                                                                       |
| daemon         | `packages/cli/src/serve/server/session-pr-refresh.ts`                                            | per-PR observation (cap 30, rotating GitHub offset, aggregate view budget), transition detection, delivery through prompt admission and resume                                             |
| daemon         | `packages/cli/src/serve/routes/session.ts`, `packages/acp-bridge/src/session-control-plane.ts`   | provenance-bound daemon-origin classification in prompt admission; `qwen.daemon.prStateEvent` added to both strip lists                                                                    |
| config         | settings schema + `packages/cli/src/serve/server.ts`                                             | `sessionPrWatch` / `QWEN_SESSION_PR_WATCH_EVENTS`                                                                                                                                          |
| channel (PR B) | `packages/channels/github/src/GithubAdapter.ts`, `index.ts`, Web Shell descriptor                | remove the watch pass and state file; deprecate `prWatchEvents` (warn-and-ignore)                                                                                                          |
| docs           | `docs/users/features/channels/github.md`, a new user page for `sessionPrWatch`, both design docs | document the move                                                                                                                                                                          |
| tests          | collocated `.test.ts` for each changed file                                                      | see validation                                                                                                                                                                             |

## Constraints and risks

- **Latency** is the refresh interval (5 minutes by default) instead of the channel's 60-second poll. Operators who need faster signal lower `QWEN_SESSION_PR_REFRESH_MINUTES` (values below 1 fall back to the default; `0` disables the sweep).
- **Credential.** Requires `gh` authenticated on the daemon host, which the refresh and the PR sidebar already require. Workspaces without it keep today's behaviour (no state refresh, no events).
- **API budget.** At most 30 `gh pr view` calls per workspace per sweep: 360·W per hour for W trusted workspaces at the default interval (1,800 per hour at W = 5, the channel watch's figure for one channel at its cap), on top of the existing listing, under a 60-second aggregate view budget per workspace sweep. The per-sweep view set is deduplicated by `owner/repo#number` across workspaces through the freshness skip in §1, so a PR bound in several workspaces is fetched once per cycle.
- **Untrusted content into an interactive session.** The event prompt carries the PR title and check names as data, marked untrusted, the same contract as the channel's bound prompt; the session's approval mode governs its actions.
- **Admission classification.** A daemon-origin classification that is not an interactive prompt must stay unforgeable from clients. The strip is defence in depth, not the mechanism: the channel markers are granted only to a caller holding the worker credential, and the refresh holds none, so the grant here is bound to provenance — a trusted in-process parameter of the admission call — and never to a string read from the request body (§4).

## Validation plan

- Unit: view mapping (`headRefOid`, `mergeable` states, rollup); transition rules including once-per-head `ci_failure` across a force-push revisit (`A failing → B failing → A failing` fires twice, not three times), edge-triggered conflict, reopen → close; selection among several binders, including binders in different workspaces; pending persistence and drain across simulated crashes, including a crash between the recipient's sidecar write and the sibling writes for a head change and for a terminal `state_change` observed through the slim listing (the sibling adopts the newer baseline by `observedAt`, detects nothing, and the pending transition is admitted exactly once under its original key); configuration parsing; the over-length key hashing; the `partial`-scan skip (no detection, no second key); `UNKNOWN` after `CONFLICTING` preserving the stored value and emitting no transition; a recipient archived or outranked between detection and drain (one admission under the original key from a sibling sidecar); `wakeDormant: false` holding the entry until the next live turn; and the setting unset → zero `gh pr view` invocations with the listing count unchanged.
- Refresh tests (existing harness with a fake `fetchPullRequests`): events delivered once per transition, dormant session restored, archived and channel-owned sessions skipped, cap and rotation (two consecutive sweeps over 40 PRs view disjoint windows), the aggregate view budget, trust/retirement re-resolution before a sibling write, and the overlap rule (a repository owned by a configured channel watch is skipped).
- E2E (daemon + stubbed `gh` binary): bind a PR in a session, flip the stub's rollup to failing, observe one injected prompt in that session after the next sweep and none after a daemon restart.

## Acceptance criteria

1. With `sessionPrWatch.events` set, a bound session receives exactly one prompt per transition instance for CI failure, merge conflict, head change and merge/close, with the same recurrence semantics as the channel watch, without any GitHub channel configured.
2. A daemon restart between detection and delivery delivers the transition once; a restart after delivery re-delivers at most once.
3. The GitHub channel no longer issues any PR-state API call; a configuration with `prWatchEvents` still connects, logs exactly one deprecation warning naming `sessionPrWatch`, and runs no watch pass; from the first minor release after PR B it is rejected at `connect()` with the same message.
4. With the setting unset, the refresh's behaviour and API call volume are unchanged.
5. Two trusted workspaces for one repository, each with a session bound to the same PR, receive one delivery per transition, to the most recently active of those sessions, also when the daemon restarts between sidecar writes or the recipient is archived or outranked between detection and drain; and a force-push back to a head whose CI failure already fired does not fire `ci_failure` again while that head is within the PR's 16-head history.
6. With `wakeDormant: false`, a transition for a dormant session is retained in `pending` and delivered on its next live turn; during the A→B window, a repository with a configured channel watch receives each transition once.

## Open questions

1. Should `sessionPrWatch` be on by default for the four events?
2. Should `cancelled` / `stale` check runs count as `ci_failure`? Core's rollup counts them (a concurrency-cancelled superseded run would fire); the channel watch excluded them.
3. `reviewDecision` is already fetched: add a `review_decision` transition (approved / changes requested) in the same mechanism?
4. Aone parity: expose the same transitions for Aone MRs once the Aone backend returns head and pipeline state.
