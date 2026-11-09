# Bound PR comment watch (conversation + inline review comments)

[English](2026-11-08-bound-pr-comment-watch.md) | [简体中文](2026-11-08-bound-pr-comment-watch.zh-CN.md)

Status: proposed (2026-11-08). Extends [GitHub Channel Events to PR-Bound Sessions](2026-11-02-github-channel-bound-session-events.md); it does not change the four PR-state watch events or the notification-driven comment lanes.

Revision 2026-11-08 (review): the watch only consumes a comment when it delivers it to at least one bound session — a comment its narrower `comment` class cannot route is left unconsumed (no shared dedupe key) so the notification lanes can still deliver it under the thread's own reason; the comment cursor is not advanced past a comment whose delivery was not durably claimed (a `dispatchEnvelope` false verdict keeps `commentSince` for retry); the two comment fetches use the state watch's fail-fast retry predicate and hand shared credential/rate-limit errors to the pass-abort logic; attribution requires the write flag in the same pipeline stage as the comments collection (a chained `stat -f` or a quoted `grep 'gh pr comment'` is a read), vetoes an explicit GET even with field flags, strips quoted spans, bounds the transcript scan cache, and runs only when there are candidates; a per-pass candidate cap drains outage backlogs without dropping the tail. The watch records `dispatchedCommentTimes` so its dedupe keys stay evictable, and a comment-only channel (empty `prWatchEvents`) skips the per-poll `pulls.get`. `prCommentWatch` carries no `deliverToBoundSessions` dependency validation because the editor emits its default for every channel. Attribution reads the active transcript plus the session's subagent transcripts (an archived session's own comments are a named best-effort residual). The watch scopes itself to SAME-account comments — the gap the notification lanes cannot see; other-account comments stay with the notification lanes, because consuming them under the watch's narrower `comment` class could reach only a subset of the configured roles and starve the rest. Author exclusion runs BEFORE the per-pass batch cap so a run of self-authored comments cannot occupy the batch slots and stall the cursor. Attribution also recognises a bare all-digit creation result (`--jq '.id'`) and a curl write whose flags precede the URL, vetoes a quoted GET method value, and treats a newline as a command boundary.

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

- When `deliverToBoundSessions` is true, poll each bound PR for new **same-account conversation comments and inline review comments** and deliver each into every bound session that did **not** post it. The watch closes exactly the gap the notification lanes cannot see: GitHub sends the channel account no notification for its own activity. Other-account comments produce notifications and stay with the notification lanes (see Non-goals).
- Marker-free and mention-free: no hidden HTML marker, no `@bot` requirement. A same-account comment posted by another session/agent/person is delivered regardless of markers; the sender gate is waived for this private lane only when the sender is the channel's own login.
- Suppress a comment for a target session only when that session itself posted it (loop prevention); exclusion is per target, so a fix/verify pair still delivers to the non-author.
- Reuse the existing bound-delivery contract: role-aware routing, stable-key dedupe, dead-letter/backpressure, dormant wake, private-only (never a public reply).
- Default-on with `deliverToBoundSessions`; an operator kill-switch (`prCommentWatch: false`) disables it.

## Non-goals

- Webhook push ingestion (unchanged future work).
- Changing the four PR-state events, `prWatchEvents`, or the notification-driven comment lanes (they keep working as today; the new watch is additive).
- **Other-account comments.** They produce GitHub notifications and are delivered by the notification lanes under the thread's own reason/role templates. The watch must not consume them: resolving only the narrower `comment` class could reach a subset of the configured roles and starve the rest. The two paths are sender-disjoint, so no cross-path dedupe is needed or possible.
- **Review bodies** (the verdict/summary posted via `gh pr review` / `pulls/<n>/reviews`). The watch fetches conversation comments and inline review comments only; a review body is neither, and no lane reads it. A review-object id also lives in a different id table than inline review comments, so attribution does not recognize review creations. Delivering review bodies is possible follow-up work (a third fetch with its own key namespace).
- Public replies: a watched comment with no remaining bound target is retired privately with a journal row, never answered in public.
- Attributing comments posted outside any local transcript (e.g. a human on github.com under another account). Those have no local authorship evidence; same-account ones are delivered to all bound sessions, which is correct.
- Reading inline review comments in the _notification_ lanes (existing limitation). This watch fetches them directly but delivers only the channel account's own; another account's inline review comments are delivered by no lane today.

## Design

### 1. Polling — channel PR watch

A separate `watchPrComments` runs alongside `watchOnePr` in the per-PR watch pass, gated on `deliverToBoundSessions` and the kill-switch, independent of `prWatchEvents`. A comment-only channel (empty `prWatchEvents`) skips `watchOnePr` entirely, so it pays no per-poll `pulls.get`:

- Fetch conversation comments (`issues.listComments`) and inline review comments (`pulls.listReviewComments`) for the bound PR, paginated with a `since` cursor. Re-check on a fixed interval (`COMMENT_RECHECK_INTERVAL_MS`, 2 minutes); there is no `updated_at` fast path. Both fetches use the state watch's fail-fast retry predicate and hand shared credential/rate-limit errors to the pass-abort logic.
- Only **same-account** comments become candidates (`user.login` equals the channel's `botUsername`); other-account comments are left to the notification lanes.
- Persist a per-PR comment cursor in `PrWatchEntry` (`commentBaseline`, `commentSince`, `commentLastFetchAt`). A first observation baselines silently (no backlog delivery). The cursor is floored to whole seconds because GitHub compares `since` at second granularity. A comment-only channel drains a merged/closed binding on the binding's terminal state (there is no `state_change` to observe), so it is not comment-fetched forever.
- Each candidate's **dedupe identity** is the comment's `node_id` (falling back to `String(id)`), recorded in `dispatchedComments` with its `created_at` in `dispatchedCommentTimes` so the key stays evictable. Authorship keys are separate: `ic:<id>` / `rc:<id>` (see §2).
- Author exclusion runs BEFORE the batch cap so self-authored comments cannot occupy batch slots and stall the cursor. A **pass-wide budget** (`MAX_WATCH_COMMENTS_PER_PASS`, shared by all watched PRs in the pass) bounds the outage burst; a PR that finds it spent keeps its cursor and resumes next pass, and a capped PR resumes before its last processed comment so the tail drains, never dropped.
- The cursor is not advanced past a comment whose delivery was not durably claimed (a `dispatchEnvelope` false verdict keeps `commentSince` for retry). A same-account comment with no deliverable target records a `comment_watch_no_target` skip row — the notification lanes can never see it, so the row is its only trace.

### 2. Attribution — daemon posted-comment lookup

New read-only route returning the set of comment identifiers a session has **posted**, derived from its transcript:

- Scan `<chatsDir>/<sessionId>.jsonl` `tool_result` entries. A result attributes a comment id to the session when the executed command is a comment **creation** at the command position (recognized: `gh pr comment`, `gh issue comment`, and `gh api`/`curl` POST to `issues/<n>/comments` or `pulls/<n>/comments`). Review bodies (`gh pr review`, `pulls/<n>/reviews`) are out of scope and not recognized. Harvest prefers the **structured result**: a single JSON object's top-level `id` is the created comment and a URL quoted in its body is data (not scanned); the leading balanced object is parsed even when a trailer line follows (`…}\nALL DONE`); a bare all-digit line is the `--jq '.id'` shape; a single comment URL (`issuecomment-(\d+)` / `discussion_r(\d+)`) is the `gh pr comment` shape. **Every** shape is gated on output origin: if the chain runs **more than one `gh`/`curl` command** (counted with the same wrapper/assignment prefixes as creation recognition), nothing is attributed. Another API command may have produced the comment-shaped output — a read before the creation, a read after it, or any of the many read shapes (collection list, single-comment endpoint `issues/comments/<id>`, `gh pr view --comments` / `--json comments`, …) — and enumerating read syntaxes cannot prove that no other command contributed comment output; command order alone does not prove authorship. A non-API companion (e.g. `| tee`) does not make it ambiguous. A shell conditional/loop (`if`/`case`/`while`/`for` and their `then`/`else`/`do`/… keywords) is also ambiguous: static analysis cannot prove which branch executed, so a creation in `if …; then gh pr comment …` may never have run while the visible output came from the condition or another branch; such commands attribute nothing (a named fail-open residual — the author may self-echo once). Ids normalize to `ic:<id>` / `rc:<id>` keyed to the creation's own collection. Ambiguous output attributes nothing (fail-open).
- Reads/lists do not attribute (only creations): an explicit GET is vetoed even with field flags (`--method`/`--request`/`-X`, including a quoted method value), `curl -G`/`--get` is a read, shell comments are dropped **during segmentation** (so `… # inspect; gh pr comment …` neither counts the comment text as a creation nor splits on the comment's `;`, and a write flag inside a comment is not a flag), the subcommand must sit at the command position (a quoted or unquoted `grep gh pr comment` is a read), and a chained `stat -f` is not a write flag. Heredoc bodies are consumed during segmentation: a quote character in the body (e.g. the apostrophe in `it's quoted`) does not open a shell quote that swallows the creation following the heredoc, and creation-shaped text inside the body is data, not a creation. A herestring (`<<<`), an arithmetic `<<`, and a `<<` inside a shell comment are not heredoc starts; a body is stripped only when its delimiter line is present. Backslash-newline continuations are joined before comment/heredoc detection, an escaped delimiter (`<<\EOF`) is read as its unescaped word, and a `#` after an escaped space is part of the word, not a comment. The visible output must also be provably the creation's: a command BEFORE the creation that writes to stdout (neither redirected nor a pure assignment) makes the origin ambiguous, so a read/print such as `cat url.txt` followed by a creation attributes nothing; a preceding heredoc that writes the body to a file (`cat > note.md <<EOF`) is redirected and does not block. A single command line carrying two heredocs (`cat > a <<'A' > b <<'B'`) consumes only the first body — a named fail-open residual (the author may self-echo once). A session that merely inspected a comment still receives the event.
- Incremental: cache per session keyed by a transcript watermark (size/mtime + scanned offset), bounded by a FIFO scan cache; rescan only appended lines. An unreadable/absent transcript returns an empty set (fail-open for delivery: better to deliver than to silently drop), never a reason to prune bindings. The worker logs a throttled diagnostic when the lookup fails with a non-200 or a thrown request, so the resulting self-delivery loop is distinguishable from a quiet PR.
- Extend `ChannelBoundSessions` with `postedCommentIds(sessionId): Promise<ReadonlySet<string>>`; the daemon worker implements it over the new route. Absent in standalone mode → no suppression (today's behavior).

Ownership: the route resolves the session's workspace runtime from the caller-asserted `workspaceCwd`, gates the read on project membership (`sessionPrSidecarBelongsToCurrentProject`, as the sibling `/sessions/pr-bindings` route does) so a caller cannot scan a foreign project's transcript, and is authenticated like other session routes. It reads the active transcript via core's canonical `getSessionTranscriptPath` accessor (not a re-derived sidecar sibling) and also scans the session's subagent transcripts (`<projectDir>/subagents/<sessionId>/agent-*.jsonl`, bounded by count), because a post delegated to a subagent is still the session's own comment and would otherwise echo back. It is read-only and adds no write surface.

### 3. Delivery — channel

For each candidate comment:

1. Resolve bound targets for the PR with the existing role-aware resolver (`resolveBoundTargets`), event class `comment`.
2. Drop every target whose `postedCommentIds` contains the comment's identifier.
3. Deliver to the remaining targets through the existing bound prompt path (`claimInboundTask` + `deliverToBoundSession`), with the stable comment id as the event/idempotency key. Reuse role templates (`fix:comment` / `comment` / `default`), dead-letter, backpressure and wake.
4. If no target remains (all posted it, or none bound), retire privately with a journal row; never fall back to a public reply.

The prompt envelope carries: author login, the comment body (sanitized + code-point capped), the comment URL, and — for inline comments — the file path and line/side (no diff-hunk context). The metadata identity line renders the last observed PR title, so the `%title%` bound-action variable is populated when a title has been observed (a comment-only pass that never observed a title renders it empty). All GitHub content is marked untrusted event data; the reply stays in the session.

### 4. Loop prevention and edge cases

- Own comments are suppressed by attribution, so a fix session's reply does not re-trigger it. Exclusion is per target: in a fix/verify pair where the fix session authored the comment, the verify session still receives it. Authorship is queried for every bound follower (not just the resolved targets) and the excluded set rides on the claimed task, so the delivery-time Gone fallback — which re-resolves over the followers — also skips a same-role author that was not the primary target instead of handing the comment back to it.
- Attribution miss (a posting method that leaves no recognizable creation result) can echo one self-comment; the stable-id dedupe bounds it to a single delivery, and it is documented. The dominant `gh`-based posting in this repo's skills is covered.
- A partial bindings snapshot never prunes watch state and defers rather than consuming (fail-closed, as the state watch). The comment watch applies the same trust gate: on an untrusted/partial/failed-refresh snapshot it neither retires a comment as no-target nor delivers to the visible subset and advances past it — it keeps `commentSince` (advancing only the fetch clock) so a trustworthy pass re-evaluates, since a session in the unscanned workspace would otherwise never receive the same-account comment.
- The watch and the notification lanes are **sender-disjoint** (same-account vs other-account), so they never deliver the same comment and no cross-path dedupe fires. The watch's private delivery waives only the sender gate when the sender is the channel's own login (the recommended `senders: allowlist` policy excludes that account); the public/notification path keeps denying senders outside the allowlist.

## Files affected

- `packages/channels/github/src/GithubAdapter.ts` — `watchPrComments`, candidate → per-target filtered bound delivery, cursor fields, pass-wide budget, comment-only terminal drain, no-target journal row, title carry-through, kill-switch config, inline-comment fetch.
- `packages/channels/base/src/types.ts` — `ChannelBoundSessions.postedCommentIds`.
- `packages/channels/base/src/ChannelBase.ts` — `waiveGroupSender` preflight option for the private same-account lane.
- `packages/cli/src/serve/server/posted-comment-attribution.ts` (new) — transcript creation detection and `ic:`/`rc:` authorship keys.
- `packages/cli/src/commands/channel/daemon-worker.ts` — implement the accessor over the new route, with a throttled failure diagnostic.
- `packages/cli/src/serve/routes/session-posted-comments.ts` (new) + route registration — transcript attribution lookup with the project-membership gate.
- `packages/web-shell/client/components/channels/*` + i18n — honour the declared boolean default and register `prCommentWatch` in the bound-session panel.
- `docs/users/features/channels/github.md` — document default-on comment watch, attribution and the kill-switch.
- Collocated tests for each changed file; an E2E plan under `.qwen/e2e-tests/`.

## Constraints

- Fail-open attribution: missing evidence must never turn "cannot tell" into "this session posted it"; narrowing attribution only ever delivers more, never suppresses more.
- Private-only: a watched comment is never answered in public; a comment with no deliverable target is journalled, not silently consumed.
- The notification lanes and the public sender gate are unchanged; the sender waiver applies only to the private same-account bound lane.
- A review-object id must not enter the `rc:` namespace (inline review comments use a different id table).
- The cursor and dedupe must survive restarts and rate-limit aborts without skipping a comment past or re-delivering it.

## Validation

- Unit: adapter comment-watch suite (same-account scope, per-target exclusion, cursor precision, batch cap, pass-wide budget, interval gate, default-on, terminal drain, no-target journal, title); attribution detector (creation-shaped harvest, GET/`-G` veto, quote-aware segmentation, literal `ic:`/`rc:` pins); route (trust + project-membership gates); worker accessor (fail-open + throttled diagnostic); web-shell editor default parity.
- Mutation witnesses: each load-bearing guard (sender waiver, per-target exclusion, no-target journal, title, terminal drain, pass budget, attribution diagnostic) reds a named test when removed.

## Acceptance criteria

- A same-account comment posted by one bound session is delivered to every other bound session that did not post it, under the recommended `senders: allowlist` policy, with no marker or mention.
- The author session does not receive its own comment; a mere reader of a comment still receives it.
- Other-account comments and review bodies are not consumed by the watch.
- A UI-created/edited channel keeps the watch default-on; an explicit `prCommentWatch: false` disables it.

## Open questions

1. Attribution precision: exotic silent posting that leaves no recognizable creation result is the documented residual (one self-echo, bounded by stable-id dedupe).
2. Review-body delivery (a third fetch with its own key namespace) is possible follow-up work, out of scope here.
3. A watch-aware dispatch-ring eviction floor (so a same-account-only channel's ring shrinks without notifications) needs a separate watch ring or lane-tagged keys to stay safe; tracked as follow-up.
