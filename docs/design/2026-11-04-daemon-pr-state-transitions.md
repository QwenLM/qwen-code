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

The refresh keeps its slim `--state all` listing for `state` and adds one `gh pr view <number> --json headRefOid,mergeable,state,statusCheckRollup` per **open** bound PR of the workspace, capped at 30 per sweep with the rotating window the Aone path already uses (`sweepStart`), so a workspace with more than 30 open bound PRs still observes every one over consecutive sweeps. A single-PR view does not hit the bulk-rollup timeout. Merged and closed PRs are observed only through the slim listing; nothing is fetched per PR for them.

`mergeable` is mapped `MERGEABLE → mergeable`, `CONFLICTING → conflicting`, `UNKNOWN → undefined` (GitHub still computing; never overwrites the last known value). CI uses core's existing `aggregateChecks` rollup (`passing` / `failing` / `pending` / `none`): one definition for the sidebar and for events.

### 2. Snapshot in the sidecar

`SessionPr` gains an optional `watch` block, written by the same mutation queue and cross-process lock as `state`:

```ts
watch?: {
  /** When this snapshot was observed (the `gh pr view` time); the newest sibling snapshot is the detection baseline. */
  observedAt?: string;
  headSha?: string;
  checks?: 'passing' | 'failing' | 'pending' | 'none';
  mergeable?: 'mergeable' | 'conflicting';
  /** Heads for which ci_failure already fired, oldest first (cap 16). */
  ciFired?: string[];
  /** Detected but not yet delivered transitions, oldest first (cap 16). */
  pending?: Array<{ type: PrTransitionType; key: string; summary: string; detectedAt: string }>;
}
```

The first observation of a PR initializes the block silently. Entries persisted before this change have no block and are initialized on their next sweep.

### 3. Transition rules

Identical to the channel watch so behaviour does not change for operators who move over:

| Event            | Fires when                                                                                                                                                     |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `head_change`    | `headSha` differs from the previous observation (a force-push back to a recent SHA is a new transition).                                                       |
| `ci_failure`     | `checks` becomes `failing` and `headSha` is not in `ciFired`; appends it, so it fires once per head even if CI flaps or a force-push revisits an earlier head. |
| `merge_conflict` | `mergeable` becomes `conflicting` from a non-conflicting observation (edge-triggered; `conflicting → mergeable → conflicting` fires again).                    |
| `state_change`   | `state` leaves `open` (merged or closed). A reopen returns `state` to `open`, so a later close fires again.                                                    |

Each transition's key is `pr-state:<owner/repo>#<number>:<type>:<headSha or previous→next>:<detectedAt>`; `detectedAt` keeps re-detected instances distinct across sidecar resets while `ci_failure` stays once-per-head through `ciFired`. `ciFired` is the daemon's equivalent of the channel's durable `fired` ring: bounded per-head history, so `A failing → B failing → A failing` after a force-push back to `A` does not fire a second time for `A`. The bound differs deliberately: the channel keeps 64 keys shared by all four event types per PR and pins only the current head once they are evicted, while the daemon keeps the last 16 failing heads of each PR; a head revisited after more than 16 other failing heads fires again, as it does in the channel after eviction.

### 4. Delivery

- **Target.** One recipient per PR across the whole daemon, never one per workspace. Observation stays per workspace (each sweep views the open bound PRs of its own workspace), but when a sweep detects a transition it selects the recipient among every eligible session bound to that PR in every trusted workspace — the process-global sidecar scan behind `GET /sessions/pr-bindings` — taking the most recently active one (transcript mtime, refined by the bridge's live activity), the rule the channel applies to the whole bindings snapshot today, and dispatches through that session's owning runtime. The new snapshot and the transition's fired record are then written to every sidecar bound to the PR, in every workspace, through each sidecar's own mutation queue and lock — the recipient's sidecar first (snapshot plus `pending`), then the siblings. Because these are separate file writes, a crash can leave a sibling behind; detection therefore never compares the fresh view with the sweep's own sidecar alone. **Baseline rule:** before comparing, the sweep reads the PR's `watch` block from every sidecar bound to it (the same process-global scan) and takes the newest by `observedAt` as the baseline. A sibling left at H0 while the recipient already holds H1 adopts H1 silently — no transition, no key — and the only key for the H0→H1 episode is the one already in the recipient's `pending`, which the drain delivers once. Two registered workspaces for one repository, each with a session following the same PR, therefore produce one delivery, not two, with or without a crash in between. Archived sessions are refreshed for `state` but never delivered to. Channel-owned sessions (`sourceType: 'channel'`) and machine-owned hidden-catalog sessions are never targets.
- **Mechanism.** The refresh calls the daemon's prompt admission in-process — the code behind `POST /session/:id/prompt` — with a daemon-origin marker (`qwen.daemon.prStateEvent`) that admission classifies like the channel bound relay: not an interactive user prompt (no loop-detected rejection, no PR-binding backfill on the injected text, a "PR event" display projection), with the transition key as the `idempotencyKey` so a retry within the daemon's lifetime deduplicates into the original admission.
- **Dormant sessions.** A session that is bound but not live is restored through the same resume path the channel accessor uses, then delivered to; `wakeDormant` is on by default so a daemon restart does not lose events. A session that cannot be restored (record deleted, archived, worktree superseded) drops the transition with a log line; nothing is ever published anywhere.
- **Prompt text.** The channel's bound prompt shape: an event header, the untrusted-event-data notice, PR identity (repo, number, title, URL), an `Event:` line and the summary (`ci_failure` names up to five failed checks from the rollup). The reply stays in the session.

### 5. Durability

Detection and the new snapshot are persisted in one sidecar write with the transitions appended to the recipient's `pending` (the other sidecars of the PR receive the snapshot and the fired record only); delivery then drains `pending` oldest-first and clears each entry after admission. The four crash windows resolve as: before the recipient's write, the transition is re-detected next sweep (no loss, nothing delivered); after the recipient's write and before the sibling writes, the siblings catch up through the baseline rule without detecting anything and the next sweep drains `pending` once; after all writes and before delivery, the next sweep drains `pending` first; after delivery and before the clear, the next sweep re-delivers and the admission ring deduplicates it within the daemon's lifetime (at-least-once across a restart, the same trade the channel made). `pending` is capped at 16 per PR; overflow drops the oldest with a log line.

### 6. Configuration

A daemon-level setting read the way the refresh interval is: `sessionPrWatch: { events: ['ci_failure', 'merge_conflict', 'head_change', 'state_change'], wakeDormant?: boolean }` with `QWEN_SESSION_PR_WATCH_EVENTS` as the environment override. Default: no events (off). Latency is the refresh interval (5 minutes by default; values below one minute fall back to the default and `0` disables the sweep).

### 7. Channel migration

The GitHub channel's `deliverToBoundSessions` is unchanged. `prWatchEvents`, the watch pass, the watch state file, its task-store branches, the 30-PR cap and the CI re-check intervals are removed from the adapter; `connect()` keeps accepting `prWatchEvents` for one minor release as a deprecation window: it logs exactly one warning naming `sessionPrWatch`, ignores the field (no watch pass runs), and the Web Shell descriptor marks it deprecated; the first minor release after PR B rejects it at `connect()` with the same message. The setting shipped in v0.26.7, and a shipped, release-noted option is not rejected on sight even though it is opt-in behind `deliverToBoundSessions` and adoption is plausibly near zero. Two PRs: A adds the daemon observation, delivery and configuration; B removes the adapter watch and updates the channel docs, landing after A.

## Key decisions

1. **The daemon owns PR state.** It already polls it for the sidebar with the host credential; adding three fields and a delivery step is cheaper than a second poller, and it serves every bound session, not only those behind a configured channel.
2. **Per-PR `gh pr view`, not the bulk rollup.** The refresh's slim bulk listing exists because the rollup field times out on large `--state all` queries; single-PR views avoid that and are bounded by the number of open bound PRs (cap 30 per sweep, rotating).
3. **Same selection and transition rules as the channel watch**, so operators moving over see the same events.
4. **The sidecar is the queue.** No new state file: the snapshot and the pending transitions ride the existing serialized, cross-process-locked sidecar write.
5. **One CI definition** (core's rollup), accepting that `cancelled` and `stale` count as failing until the open question below is settled.
6. **One-release deprecation window** for `prWatchEvents`: v0.26.7 shipped it (#16117, released 2026-11-04) and names it in the release notes, so it is not rejected on sight; adoption is plausibly near zero (hours old, opt-in behind `deliverToBoundSessions`), so one minor release of warn-and-ignore is enough before `connect()` rejects it.
7. **Off by default** in this change; turning it on by default is a product decision for later.

## Files affected

| Layer          | File                                                                                             | Change                                                                                                    |
| -------------- | ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| core           | `packages/core/src/services/session-pr-service.ts`                                               | `watch` block on `SessionPr`; `updateSessionPrStates` writes snapshot + pending; drain helper             |
| core           | `packages/core/src/utils/github-prs.ts`                                                          | `fetchGitHubPullRequestView(number)` with `headRefOid`, `mergeable`, rollup; mapping                      |
| daemon         | `packages/cli/src/serve/server/session-pr-refresh.ts`                                            | per-PR observation (cap 30, rotating), transition detection, delivery through prompt admission and resume |
| daemon         | `packages/cli/src/serve/routes/session.ts`, `packages/acp-bridge/src/session-control-plane.ts`   | `qwen.daemon.prStateEvent` classification in prompt admission                                             |
| config         | settings schema + `packages/cli/src/serve/server.ts`                                             | `sessionPrWatch` / `QWEN_SESSION_PR_WATCH_EVENTS`                                                         |
| channel (PR B) | `packages/channels/github/src/GithubAdapter.ts`, `index.ts`, Web Shell descriptor                | remove the watch pass and state file; deprecate `prWatchEvents` (warn-and-ignore)                         |
| docs           | `docs/users/features/channels/github.md`, a new user page for `sessionPrWatch`, both design docs | document the move                                                                                         |
| tests          | collocated `.test.ts` for each changed file                                                      | see validation                                                                                            |

## Constraints and risks

- **Latency** is the refresh interval (5 minutes by default) instead of the channel's 60-second poll. Operators who need faster signal lower `QWEN_SESSION_PR_REFRESH_MINUTES` (values below 1 fall back to the default; `0` disables the sweep).
- **Credential.** Requires `gh` authenticated on the daemon host, which the refresh and the PR sidebar already require. Workspaces without it keep today's behaviour (no state refresh, no events).
- **API budget.** At most 30 `gh pr view` calls per workspace per sweep (360 per hour at the default interval) on top of the existing listing; well under the channel watch's budget.
- **Untrusted content into an interactive session.** The event prompt carries the PR title and check names as data, marked untrusted, the same contract as the channel's bound prompt; the session's approval mode governs its actions.
- **Admission classification.** A daemon-origin marker that is not an interactive prompt must stay unforgeable from clients: the route strips it from client bodies the way it strips the channel markers today.

## Validation plan

- Unit: view mapping (`headRefOid`, `mergeable` states, rollup); transition rules including once-per-head `ci_failure` across a force-push revisit (`A failing → B failing → A failing` fires twice, not three times), edge-triggered conflict, reopen → close; selection among several binders, including binders in different workspaces; pending persistence and drain across simulated crashes, including a crash between the recipient's sidecar write and the sibling writes (the sibling adopts the newer baseline, detects nothing, and the pending transition is admitted exactly once under its original key); configuration parsing.
- Refresh tests (existing harness with a fake `fetchPullRequests`): events delivered once per transition, dormant session restored, archived and channel-owned sessions skipped, cap and rotation.
- E2E (daemon + stubbed `gh` binary): bind a PR in a session, flip the stub's rollup to failing, observe one injected prompt in that session after the next sweep and none after a daemon restart.

## Acceptance criteria

1. With `sessionPrWatch.events` set, a bound session receives exactly one prompt per transition instance for CI failure, merge conflict, head change and merge/close, with the same recurrence semantics as the channel watch, without any GitHub channel configured.
2. A daemon restart between detection and delivery delivers the transition once; a restart after delivery re-delivers at most once.
3. The GitHub channel no longer issues any PR-state API call; a configuration with `prWatchEvents` still connects, logs exactly one deprecation warning naming `sessionPrWatch`, and runs no watch pass; from the first minor release after PR B it is rejected at `connect()` with the same message.
4. With the setting unset, the refresh's behaviour and API call volume are unchanged.
5. Two trusted workspaces for one repository, each with a session bound to the same PR, receive one delivery per transition, to the most recently active of those sessions, also when the daemon restarts between the recipient's sidecar write and the sibling writes; and a force-push back to a head whose CI failure already fired does not fire `ci_failure` again while that head is within the PR's 16-head history.

## Open questions

1. Should `sessionPrWatch` be on by default for the four events?
2. Should `cancelled` / `stale` check runs count as `ci_failure`? Core's rollup counts them (a concurrency-cancelled superseded run would fire); the channel watch excluded them.
3. `reviewDecision` is already fetched: add a `review_decision` transition (approved / changes requested) in the same mechanism?
4. Aone parity: expose the same transitions for Aone MRs once the Aone backend returns head and pipeline state.
