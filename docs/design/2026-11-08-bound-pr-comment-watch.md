# Bound PR comment watch (conversation + inline review comments)

[English](2026-11-08-bound-pr-comment-watch.md) | [简体中文](2026-11-08-bound-pr-comment-watch.zh-CN.md)

Status: proposed (2026-11-08). Extends [GitHub Channel Events to PR-Bound Sessions](2026-11-02-github-channel-bound-session-events.md); it does not change the four PR-state watch events or the notification-driven comment lanes.

Revision 2026-11-08 (review): the watch only consumes a comment when it delivers it to at least one bound session — a comment its narrower `comment` class cannot route is left unconsumed (no shared dedupe key) so the notification lanes can still deliver it under the thread's own reason; the comment cursor is not advanced past a comment whose delivery was not durably claimed (a `dispatchEnvelope` false verdict keeps `commentSince` for retry); the two comment fetches use the state watch's fail-fast retry predicate and hand shared credential/rate-limit errors to the pass-abort logic; attribution requires the write flag in the same pipeline stage as the comments collection (a chained `stat -f` or a quoted `grep 'gh pr comment'` is a read), vetoes an explicit GET even with field flags, strips quoted spans, bounds the transcript scan cache, and runs only when there are candidates; a per-pass candidate cap drains outage backlogs without dropping the tail. The watch records `dispatchedCommentTimes` so its dedupe keys stay evictable, and a comment-only channel (empty `prWatchEvents`) skips the per-poll `pulls.get`. `prCommentWatch` carries no `deliverToBoundSessions` dependency validation because the editor emits its default for every channel. Attribution reads only the active transcript (an archived session's own comments are a named best-effort residual).

## Problem

A session bound to a PR — especially a `fix`-role session that owns the whole development loop — must hear about new comments on that PR no matter who posts them: the operator by hand, another Qwen Code session, or a different agent/model, whether they use the same GitHub account or another one. Today it does not:

1. **Comments are notification-driven.** The adapter's comment lanes run only when GitHub notifies the channel account with a `mention`, `author`, `comment`, `review_requested` or `assign` reason. GitHub does not notify an account about its own activity, so a comment posted by the channel's own account never produces a notification.
2. **Self comments are filtered at the fetch.** `fetchNewComments` drops every comment whose `user.login` equals `botUsername` (`GithubAdapter.ts`), before any lane sees it. The bound mention-waiver (`waivesBoundMention`) additionally excludes `operators` for the same loop reason.

The practical failure (observed 2026-11-08 on PR #16587, session `7bddc58f`): a verify session posted a findings comment under the same `wenshao` account the channel authenticates as. The fix session bound to the PR received the `head_change`/`ci_failure` watch events but never the comment, so it could not act on the findings without the operator pasting the link by hand. The single-account identity, not the delivery machinery, is the gap.

## Current state

- Comment lanes: `processCommentLane` (mention / direct) and `processAggregateLane` (`author`/`comment` reasons) both fetch through `fetchNewComments`, which filters `botUsername` and the time window, then gate by sender and dispatch an envelope through `dispatchEnvelope` → `claimInboundTask` → `deliverToBoundSession`.
- PR state watch: `runPrStateWatch` / `watchOnePr` already poll every bound PR once per channel poll (capped by `prWatchLimit`), persist a per-PR `PrWatchEntry` baseline + pending queue + fired ring in `github-pr-watch.json`, and deliver `ci_failure` / `merge_conflict` / `head_change` / `state_change` privately.
- Delivery accessor: `ChannelBoundSessions` (`packages/channels/base/src/types.ts`) exposes `listPrBindings()` and `deliverPrompt(sessionId, prompt, idempotencyKey)`; the daemon worker implements both over HTTP. Bound delivery is role-aware (`boundSessionActions`), deduped by a stable event key, dead-lettered on backpressure, and wakes dormant sessions.
- No daemon-wide record of which comments a session posted. `/autofix-pr` keeps `postedCommentIds` in its own command-local state; that is not a shared attribution source.
- A session's transcript (`<chatsDir>/<sessionId>.jsonl`) records every shell tool result, including the comment-creation command and the returned `…#issuecomment-<id>` / review-comment JSON. This is the only marker-free, per-session evidence of authorship that covers any posting method.

## Goals

- When `deliverToBoundSessions` is true, poll each bound PR for new **conversation comments and inline review comments** and deliver each new comment into every bound session that did **not** post it.
- Marker-free and mention-free: no hidden HTML marker, no `@bot` requirement, no sender-allowlist waiver needed. Same-account comments from other sessions/agents/people and other-account comments are all delivered.
- Suppress a comment for a target session only when that session itself posted it (loop prevention).
- Reuse the existing bound-delivery contract: role-aware routing, stable-key dedupe, dead-letter/backpressure, dormant wake, private-only (never a public reply).
- Default-on with `deliverToBoundSessions`; an operator kill-switch disables it.

## Non-goals

- Webhook push ingestion (unchanged future work).
- Changing the four PR-state events, `prWatchEvents`, or the notification-driven comment lanes (they keep working as today; the new watch is additive and dedupes against them by comment id).
- Public replies: a watched comment with no remaining bound target is retired privately, never answered in public.
- Attributing comments posted outside any local transcript (e.g. a human on github.com). Those have no local authorship evidence and are delivered to all bound sessions, which is correct.
- Reading inline review comments in the _notification_ lanes (existing limitation); this watch fetches them directly.

## Design

### 1. Polling — channel PR watch

Add a comment observation to the existing per-PR watch pass (`watchOnePr`), gated on `deliverToBoundSessions` and the kill-switch, independent of `prWatchEvents`:

- Fetch conversation comments (`issues.listComments`) and inline review comments (`pulls.listReviewComments`) for the bound PR. To bound API cost, fetch only when the PR's `updated_at` advanced since the last comment observation or a periodic re-check interval elapsed (same shape as the CI re-check), and paginate with a `since` cursor.
- Persist a per-PR comment cursor in `PrWatchEntry` (last seen comment timestamps/ids and the last fetch time). A first observation baselines silently (no backlog delivery), matching the state-watch convention.
- Each new comment becomes a candidate event with a **stable identity** (conversation: `issuecomment-<id>`; inline: `reviewcomment-<id>`), so polls, restarts and multiple channel instances dedupe by GitHub id.
- Cap candidates per pass; record the cursor only after the delivery intent is durably claimed (same crash-window rule as the aggregate lane).

### 2. Attribution — daemon posted-comment lookup

New read-only route returning the set of comment identifiers a session has **posted**, derived from its transcript:

- Scan `<chatsDir>/<sessionId>.jsonl` `tool_result` entries. A result attributes its output's comment ids to the session when the executed command is a comment/review **creation** (recognized patterns: `gh pr comment`, `gh issue comment`, `gh pr review`, and `gh api`/`curl` POST to `issues/<n>/comments`, `pulls/<n>/comments`, `pulls/<n>/reviews`). Extract ids from the result output (`issuecomment-(\d+)`, `discussion_r(\d+)`, and comment/review JSON `"id"`), normalized to `ic:<id>` / `rc:<id>`.
- Reads/lists do not attribute (only creations), so a session that merely inspected a comment still receives the event.
- Incremental: cache per session keyed by a transcript watermark (size/mtime + scanned offset); rescan only appended lines. An unreadable transcript returns an empty set and is logged (fail-open for delivery: better to deliver than to silently drop), never a reason to prune bindings.
- Extend `ChannelBoundSessions` with `postedCommentIds(sessionId): Promise<ReadonlySet<string>>`; the daemon worker implements it over the new route. Absent in standalone mode → no suppression (today's behavior).

Ownership: the route resolves the session's workspace runtime like the prompt route, reads only that session's transcript, and is authenticated like other session routes. It is read-only and adds no write surface.

### 3. Delivery — channel

For each candidate comment:

1. Resolve bound targets for the PR with the existing role-aware resolver (`resolveBoundTargets`), event class `comment`.
2. Drop every target whose `postedCommentIds` contains the comment's identifier.
3. Deliver to the remaining targets through the existing bound prompt path (`claimInboundTask` + `deliverToBoundSession`), with the stable comment id as the event/idempotency key. Reuse role templates (`fix:comment` / `comment` / `default`), dead-letter, backpressure and wake.
4. If no target remains (all posted it, or none bound), retire privately with a journal row; never fall back to a public reply.

The prompt envelope carries: author login, the comment body (sanitized + code-point capped), the comment URL, and — for inline comments — the file path, line/side and a bounded diff-hunk context. All GitHub content is marked untrusted event data; the reply stays in the session.

### 4. Loop prevention and edge cases

- Own comments are suppressed by attribution, so a fix session's reply does not re-trigger it.
- Attribution miss (a posting method that leaves no recognizable creation result) can echo one self-comment; the stable-id dedupe bounds it to a single delivery, and it is documented. The dominant `gh`-based posting in this repo's skills is covered.
- A partial bindings snapshot never prunes watch state and defers rather than consuming (fail-closed, as the state watch).
- The notification lanes may also deliver the same comment (other-account `author`/`mention` threads); the shared stable comment id dedupes across both paths.

## Files affected

- `packages/channels/github/src/GithubAdapter.ts` — comment observation in the watch pass, candidate → filtered bound delivery, cursor fields, kill-switch config, inline-comment fetch.
- `packages/channels/base/src/types.ts` — `ChannelBoundSessions.postedCommentIds`.
- `packages/cli/src/commands/channel/daemon-worker.ts` — implement the accessor over the new route.
- `packages/cli/src/serve/routes/session-posted-comments.ts` (new) + route registration — transcript attribution lookup.
- `docs/users/features/channels/github.md` — document default-on comment watch, attribution and the kill-switch.
- Collocated tests for each changed file; an E2E plan under `.qwen/e2e-tests/`.

## Open questions

1. Attribution precision: creation-pattern detection (chosen) vs. broad "any tool_result mention". Creation detection is faithful to "posted by this session" and avoids suppressing comments a session only read; exotic silent posting is the documented residual.
2. Comment-fetch cadence and cap under many bound PRs (API budget); start with the `updated_at` + periodic re-check shape and the existing `prWatchLimit`.
3. Inline-comment prompt shape: how much diff-hunk context to include within the body cap.
