# GitHub Channel Events to PR-Bound Sessions

[English](2026-11-02-github-channel-bound-session-events.md) | [简体中文](2026-11-02-github-channel-bound-session-events.zh-CN.md)

Status: proposed (decisions confirmed by the maintainer on 2026-11-02: prompt-injection delivery, in-channel state watch, event scope = CI failure + merge conflict + new comments + head change / merged / closed).

## Problem

A user who follows a PR in a Qwen Code session (a Web Shell or CLI session that created, reviewed, or verified the PR) gets no help from the GitHub channel when that PR changes:

1. **Two disconnected session systems.** The GitHub channel routes every event to a channel-owned session keyed by `github:<owner>/<repo>:pr:<N>` (`SessionRouter`, `chat_thread` scope). The session that actually follows the PR — the one with the worktree, the context, and the PR binding in its `prs` sidecar — never sees the event.
2. **Event coverage gaps.** The adapter polls the Notifications API and enumerates comments. A pure CI failure (reason `ci_activity`, no new comment) dispatches nothing. A merge conflict produces no GitHub notification at all. New pushes and merge/close transitions are likewise invisible unless someone comments.

The building blocks for closing both gaps already exist:

- **PR bindings**: `packages/core/src/services/session-pr-service.ts` persists `<chatsDir>/<sessionId>.pr.json`; the daemon refresh timer (`packages/cli/src/serve/server/session-pr-refresh.ts`) already scans every trusted workspace's sidecars on a cycle. There is no reverse lookup (PR → sessions) yet.
- **Delivery into an existing session**: `POST /session/:id/prompt` accepts prompts for any live session, resolves the owner runtime by session id (cross-workspace capable), and FIFO-queues while the session is busy (`DEFAULT_MAX_PENDING_PROMPTS_PER_SESSION = 5` in `packages/acp-bridge/src/session-control-plane.ts`; queue full → HTTP 503 `prompt_queue_full` + `Retry-After`).
- **Session creation**: the channel's existing `SessionRouter` path already creates a channel session when no route exists.

## Goals

- When a GitHub event concerns a PR that is bound to a live session, deliver the event into that session as a prompt turn, so the session can handle it with its existing context.
- Sense the events the Notifications API cannot deliver: CI failure on the PR head, merge-conflict appearance, head advancement, and PR merged/closed transitions — for the set of PRs bound to sessions.
- When no bound session exists, keep today's behavior: the event flows through the normal channel path and creates (or reuses) a channel session.

## Non-goals

- No webhook push ingestion. The daemon's `POST /channels/:channelName/webhooks/:source` route stays as it is (static targets); true push delivery is future work.
- No channel takeover of bound sessions (`SessionRouter.activateManagedSession` is not used): a bound session's replies must NOT be auto-published as GitHub comments under the channel publication contract.
- No cross-session peer messaging for this path (review-class gating and external-peer registration add complexity without benefit here).
- No automatic PR binding of channel-created sessions. Channel sessions keep their existing routing and public-reply behavior.
- No support for standalone `qwen channel start` (non-daemon ACP mode): the reverse lookup is a daemon route. The feature degrades to today's behavior there.
- Inline PR review comments remain out of scope (existing adapter limitation).

## Design

### Layer 1 — daemon reverse-lookup route

New process-global, read-only route:

```
GET /sessions/pr-bindings
→ { "bindings": [ { sessionId, workspaceCwd, sourceType, sourceId, updatedAt, prs: [{number, url, state?}] } ], "partial": false }
```

- Ownership class: **process-global** (same class as `POST /sessions/backfill-prs`). It iterates the registry's trusted workspace runtimes and enumerates active sessions through the live-merged session-list path (`listWorkspaceSessionsForResponse`, which enriches summaries from the PR sidecars), paginating up to a bounded page cap. Untrusted workspaces are skipped.
- Archived sessions are excluded. `sourceType`/`sourceId` are included so callers can exclude channel-owned sessions. `prs` entries are projected to `{number, url, state?}`.
- **`partial`** is true when the answer is incomplete: a workspace failed to list, a page reported truncation, or the page cap was exhausted with cursors remaining. Consumers must not treat a missing entry in a partial answer as an authoritative absence (the adapter skips watch-state pruning on partial snapshots).
- Authenticated like the other session routes (bearer when `--require-auth`). No new write surface.
- The route is a scan, not an index: at the scale of the sidecar system (tens of sessions per workspace) a per-poll scan is acceptable; the adapter caches the result for one poll cycle.

### Layer 2 — worker-provided delivery accessor

`ChannelBaseOptions` (in `packages/channels/base/src/ChannelBase.ts`) gains one optional field; the `ChannelAgentBridge` contract is unchanged:

```ts
boundSessions?: {
  listPrBindings(): Promise<{ bindings: PrBindingSummary[]; partial: boolean }>;
  deliverPrompt(sessionId: string, prompt: string): Promise<void>;
};
```

- The daemon channel worker (`packages/cli/src/commands/channel/daemon-worker.ts`) implements it with the SDK client it already holds: `listPrBindings` calls the new route and rebuilds its session→cwd cache from each complete answer (sessions that left the bindings drop out); `deliverPrompt` posts the prompt as a text content block and treats acceptance into the FIFO queue as delivery — the worker does not wait for the target session's turn to finish.
- **Dormant wake**: the bindings route lists persisted active sessions, but the prompt route only serves live ones; after a daemon restart a bound session is dormant and answers 404. On 404 the accessor restores the session through the same resume path the channel bridge uses for its own dormant sessions (workspace cwd taken from the cached bindings, refreshed once if unknown), then retries the prompt once. The restored client is discarded: the admitted prompt holds the session for its turn, and the daemon's idle cleanup returns it to dormant afterwards.
- **Wake error classification**: only a 404 restore (the session record is truly gone) becomes `BoundSessionGoneError`. Restore conflicts, session limits, timeouts and bindings-refresh failures propagate as transient errors so the adapter retries instead of degrading into public channel delivery.
- `deliverPrompt` surfaces 404-after-wake (session gone) and 503 `prompt_queue_full` as distinct errors so the adapter can fall back or retry.
- When the option is absent (standalone mode, tests), adapters behave exactly as today.

### Layer 3 — GitHub adapter changes

All in `packages/channels/github/src/GithubAdapter.ts` plus the plugin descriptor in `index.ts`.

#### Configuration

Two new management fields:

| Field                    | Kind        | Default    | Meaning                                                                                                  |
| ------------------------ | ----------- | ---------- | -------------------------------------------------------------------------------------------------------- |
| `deliverToBoundSessions` | boolean     | `false`    | Route events for PRs bound to a live session into that session instead of the channel session.           |
| `prWatchEvents`          | string-list | `[]` (off) | State transitions to watch for bound PRs: `ci_failure`, `merge_conflict`, `head_change`, `state_change`. |

`validateConfig` rejects a non-empty `prWatchEvents` when `deliverToBoundSessions` is off (the watch set is defined by bindings; watching without delivery has no MVP meaning). The descriptor delegates to the adapter's shared validator (`validateBoundSessionConfig`), so the management UI and `connect()` enforce one vocabulary and cannot drift. Both fields are opt-in; existing deployments are unaffected.

#### Bound-session selection

At the start of each poll, when `deliverToBoundSessions` is on, the adapter fetches `GET /sessions/pr-bindings` and builds a map `owner/repo#number → session`. The key lowercases the repo path on both sides: GitHub URLs are case-insensitive (core's `canonicalSessionPrUrl` lowercases them), binding URLs may carry any case while notification subject URLs carry the canonical case. Binding URL parsing tolerates trailing tab segments (`/files`, `/commits`, `/checks`) because the binding routes accept any http(s) URL naming the PR.

- Keep only bindings whose PR URL host matches the channel's GitHub host (Aone and other-provider bindings are ignored).
- Keep only entries with recorded `state` not `merged`/`closed` for the watch set; delivery candidates for comment events accept any recorded state (a comment on a just-merged PR still deserves delivery while the binding refresh catches up).
- Exclude sessions with `sourceType === 'channel'` — channel sessions are reached through the normal channel path, which preserves their public-reply contract.
- Multiple candidates: pick the most recently updated session (`updatedAt` desc; the route falls back to `createdAt` for live summaries that lack `updatedAt`, so a fresh live session is never outranked by a stale persisted one). Deterministic, no broadcast.
- A failed refresh keeps the previous map (stale candidates fail at delivery time and fall back); the watch pass is skipped for that poll so a transient failure cannot prune the persisted baseline. A `partial` snapshot keeps the map but disables watch-state pruning.

#### Comment delivery intercept

`dispatchEnvelope` is the single funnel for accepted comment/body/review/assign events. Before claiming the inbound task it consults the bound-session map:

- **Bound session found** → the persisted `InboundTaskRecord` gains `delivery: { kind: 'bound-session', sessionId }`. `runInboundTask` delivers the event prompt through `boundSessions.deliverPrompt` instead of `handleInbound`. Because this bypasses `handleInbound`, the bound path runs the same `preflightInbound` (group policy, sender gate, pairing — side effects included) before delivering; watch events are exempt (no human sender, operator opt-in). Dedupe keys, cursor semantics, and the recoverable-task machinery are unchanged — only the terminal delivery differs.
- **No bound session** → today's path (`handleInbound` → channel session).
- **Delivery fails**: 404 → the accessor first tries the dormant wake (Layer 2); only a session that cannot be restored surfaces as gone, and the adapter then re-resolves once from a fresh binding fetch; a different candidate is re-delivered, no candidate left → fall back to `handleInbound` for this event. 503 queue full is backpressure, not failure: it does not consume the retry budget, so a busy session defers the event instead of losing it after `MAX_INBOUND_TASK_ATTEMPTS = 3`. Other transient errors re-attempt up to that cap; the cursor does not advance while the task is recoverable. Recovery after restart honors the persisted `delivery` field.

The injected prompt reuses the webhook-task prompt shape (`buildChannelWebhookPrompt` style): event header, explicit "untrusted event data" warning, PR identity (repo, number, title, URL), the lane's `Trigger:`/`Event:` lines plus the direct lane's factual `Author:` details, the comment author/body or event details, and guidance that the reply stays in this session (the session is not under the channel publication contract; it acts on GitHub through its own normal tools if needed). Channel-facing publication wording never reaches the bound session: the metadata's publication instructions are dropped, and the aggregate lane's "output exactly `<no-reply/>`" prefix is replaced with a plain "New comments on the PR" header.

#### PR state watch

When `prWatchEvents` is non-empty, `pollOnce` runs a watch pass after notification processing:

1. **Watch set**: bound PRs from the same binding fetch, filtered to recorded-open state and the channel's GitHub host, capped at 30 (most recently updated bindings first). No bound PRs → zero API calls. Persisted entries are pruned against the full candidate set (not the capped watch set, so PRs rotating out of the cap keep their baseline), and only when the snapshot is complete — a partial snapshot never prunes.
2. **Per PR**: `pulls.get` every poll (head SHA, `mergeable`, `mergeable_state`, `state`, `updated_at`). Check runs (`checks.listForRef`) and combined commit status (`repos.getCombinedStatusForRef`) are fetched only when the head SHA changed since the last poll, the last observed CI aggregate was pending/in_progress, no CI observation exists yet, the PR's `updated_at` advanced (any thread activity — check re-runs included — bumps it, so a settled head that turns red later is still caught), or the aggregate is `none` within a 10-minute grace window after the head was first observed (checks register asynchronously; beyond the window `none` means the repo has no CI and stays settled). Steady-state cost is one call per PR per poll.
3. **Transition detection** against persisted watch state (`channelFilePath('github-pr-watch.json')`, bounded to the watch set):
   - `ci_failure`: aggregate turns to failure (any completed check run with `failure`/`timed_out`/`action_required` conclusion, or combined status `failure`/`error`). Fires once per head SHA; a new head that fails fires again. The event summary names the failed checks (up to 5) so the session can act without re-querying.
   - `merge_conflict`: `mergeable_state` enters `dirty`. Edge-triggered; `dirty → clean → dirty` fires again. `mergeable === null` (GitHub still computing) never overwrites the last known state.
   - `head_change`: head SHA differs from the last observed SHA (first observation initializes silently).
   - `state_change`: PR `state` leaves `open` (merged or closed). First observation initializes silently.
4. **State before dispatch**: the new watch state is persisted before the event task is claimed, so a crash cannot re-fire the same transition; the claimed inbound task (with `delivery` resolved at claim time) owns retries. Event tasks use `source.messageId = watch:<eventType>:<headSha|state>` and flow through the same bound-session-or-fallback delivery as comments.
5. **Binding state upkeep** stays with the existing 5-minute refresh timer; the adapter does not PATCH metadata. Once the timer records `merged`/`closed`, the PR leaves the watch set.

#### API budget

Default 60 s poll, cap 30 watched PRs: steady state ≤ 1 800 calls/hour; CI-active bursts add at most 2 calls per affected PR per poll. Notification polling overhead is unchanged. The adapter logs and skips the watch pass when the binding fetch fails (notifications still flow).

## Key decisions

1. **Prompt injection, not channel attach.** `activateManagedSession` would bind the followed session's outbound target to the GitHub thread, so every final reply of an interactive session would be published as a public PR comment (publication contract). Injection keeps replies in the session and leaves GitHub actions to the session's own judgment and tools.
2. **In-channel state watch, not webhooks.** The watch reuses the channel's existing poll loop and credentials; detection happens at the API layer and costs zero model tokens until a real transition. Webhook push would need a public tunnel plus repository webhook creation (operator consent) and a rework of the static webhook targets. The watch is polling, but it is the gate-probe shape the maintainer accepts: cheap detection outside the model, model only on change.
3. **Reverse lookup lives in the daemon.** Bindings span workspaces; the worker is workspace-scoped and already talks to the daemon over authenticated HTTP. A read-only process-global route reuses the refresh timer's scan pattern instead of duplicating sidecar access in the worker.
4. **One candidate, most recently updated.** Broadcasting to every bound session multiplies model cost and produces duplicate GitHub actions; the freshest non-archived, non-channel session is the one most likely to hold the working context.
5. **Channel sessions excluded from candidates.** A channel-created session bound via `/review` backfill must keep its public-reply contract; the normal channel path already serves it.
6. **Opt-in defaults.** Public-repository events driving an interactive session is a new trust surface; operators enable it explicitly, and comment sender gates still apply before delivery.
7. **Wake dormant sessions instead of falling back.** E2E showed that after a daemon restart the bound session is dormant and the prompt route 404s; treating that as "gone" silently diverted every post-restart event into public channel delivery — breaking the feature's core private-delivery promise. The accessor therefore restores the session (the same resume path the channel bridge already uses) and retries once; only an unrestorable session falls back. The wake registers a transient client that the daemon's client-close sweep reclaims after the turn, so sessions are not pinned live.

## Files affected

| Layer        | File                                                                        | Change                                                                                 |
| ------------ | --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| core types   | `packages/core/src/services/session-pr-service.ts`                          | none (reused as is)                                                                    |
| daemon route | `packages/cli/src/serve/routes/session-pr-bindings.ts` (new) + registration | `GET /sessions/pr-bindings` scan route                                                 |
| channel base | `packages/channels/base/src/ChannelBase.ts`, `types.ts`                     | optional `boundSessions` option + `PrBindingSummary` type                              |
| worker       | `packages/cli/src/commands/channel/daemon-worker.ts`                        | implement the accessor with the SDK client                                             |
| adapter      | `packages/channels/github/src/GithubAdapter.ts`, `index.ts`                 | config fields, selection map, delivery intercept, state watch, watch-state persistence |
| docs         | `docs/users/features/channels/github.md`                                    | document the two fields, event semantics, limits                                       |
| tests        | collocated `.test.ts` for each changed file                                 | see validation                                                                         |

## Constraints and risks

- **Untrusted content into an interactive session.** Event payloads are marked untrusted in the injected prompt (same contract as webhook tasks). Comment sender gates apply unchanged. State events have no human sender; they exist only because the operator opted in. The target session's own approval mode governs its actions.
- **Queue pressure.** A burst of events can fill the target's 5-slot prompt queue; queue-full is treated as backpressure (it does not consume the retry budget), delivery retries on later polls and the cursor holds. A bound event is never silently dropped while its task is recoverable; only non-backpressure failures exhaust the 3-attempt cap, and those log a terminal error.
- **Rate limits.** The watch caps and conditional check fetches keep the steady state well under the 5 000 calls/hour token budget; a rate-limited watch pass is skipped with a log, notifications unaffected.
- **Stale bindings.** A dormant bound session is woken by the accessor (Layer 2), so daemon restarts do not divert events into public channel delivery. A binding whose session was truly deleted fails the wake → fallback to the channel path; the next poll's binding fetch heals the map.
- **Closed sessions.** `DELETE /session/:id` closes a session without deleting its record; the record stays resumable and bound, so such sessions are still woken for delivery (verified in E2E). Only record deletion (`POST /sessions/delete`) or archiving removes a session from the candidate set. Closing is a resource action, not an unsubscribe; the binding expresses the follow intent.
- **Scan cost.** The route scans sidecars per call; at current scale this is milliseconds. If it grows, an in-memory index invalidated by `session_metadata_updated` is the follow-up, not part of this change.

## Validation plan

- **Unit**: route scan (trusted/untrusted, archived exclusion, sidecar corruption tolerance); adapter selection (host filter, state filter, channel-source exclusion, recency tie-break); delivery intercept (bound → inject, unbound → channel path, 404 fallback, queue-full retry, recovery honors persisted delivery); watch transitions (each event type, dedupe per head, null-mergeable guard, first-observation silence, state-before-dispatch ordering); config validation.
- **E2E** (daemon + local build): bind a PR to a session via PATCH metadata; simulate events with a stubbed GitHub API layer; assert the bound session receives exactly one injected prompt per transition, replies stay in-session, and an unbound PR still creates a channel session. Plan details in `.qwen/e2e-tests/github-channel-bound-session-events.md`.

## Acceptance criteria

1. With both fields enabled, a new comment on a bound PR arrives as a prompt in the bound session (not the channel session), and the session's reply is not auto-posted to GitHub.
2. A CI failure on the bound PR's head, a transition to `mergeable_state: dirty`, a head advance, and a merge/close each produce exactly one injected prompt per transition, surviving daemon restarts without re-firing.
3. With no bound session, every event class behaves exactly as today (channel session created/reused, public reply contract intact).
4. With the fields disabled (default), behavior and API call volume are unchanged.
5. Queue-full and session-gone paths retry or fall back without losing or duplicating events.

## Open questions

None. Webhook push delivery and an in-memory binding index are recorded as future work, not blockers.
