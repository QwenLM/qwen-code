# GitHub Channel: Dispatch By Notification Reason

## Goal

Route GitHub notifications by `notification.reason` so each trigger type
dispatches a purpose-built prompt to the agent, instead of the current
one-size-fits-all "fetch every new comment and dispatch" behavior.

Issue #7807 tracks this feature.

## Background

`packages/channels/github/src/GithubAdapter.ts` `pollOnce` currently treats all
notifications identically: for each notification it enumerates the thread's new
comments (since the cursor window) and dispatches every one of them via
`handleInbound`, regardless of `notification.reason`. The `isMentioned` flag is
computed but only used as a marker — it does not gate dispatch.

This has two problems:

1. **Noise**: a `mention` notification whose thread also received non-mention
   comments dispatches all of them — the agent fires on comments that did not
   @ the bot.
2. **Coverage gap**: `review_requested` and `assign` — the two highest-value
   trigger types for a coding agent — are not covered at all. The bot won't
   automatically pick up a review request or an assignment.

The mechanical layer (octokit pagination, rate-limit retry, cursor persistence,
`postErrorComment`) is already complete (PR #7632, #7727). This is a pure
semantic-layer enhancement that builds on it without architectural change.

## Scope

In scope:

- Route at the notification level by `notification.reason` into five lanes:
  `mention`, `review_requested`, `assign`, `aggregate` (author/comment), and
  `generic` (everything else).
- `mention` lane: only dispatch comments that actually @ the bot; strip the
  @mention from the prompt text (already done); skip non-mention comments.
- `review_requested` lane (PR only): fetch PR meta via `octokit.rest.pulls.get`
  (title / author / state / draft / head→base) and dispatch one envelope with a
  review-specific prompt, even when there are no new comments (the review
  request itself is the trigger).
- `assign` lane: fetch issue meta via `octokit.rest.issues.get` and dispatch one
  envelope with a triage-specific prompt, even when there are no new comments.
- `aggregate` lane (`author` / `comment`): combine the window's new comments
  into one envelope with a "review and respond if needed" prompt, instead of one
  turn per comment.
- `generic` lane: keep current behavior (dispatch all new comments) with a
  generic framing note in metadata.
- Cursor dedup: add `dispatchedComments` (by comment `node_id`) and
  `dispatchedNotifications` (by notification `id`), bounded like the existing
  `dispatchedBodies`. These survive a `markNotificationsAsRead` failure that
  leaves the cursor un-advanced and causes the next poll to re-fetch the same
  notifications.

Out of scope:

- Configurable / extensible reason→prompt mapping (suggested by triage, not
  requested by the issue — added only if a follow-up asks).
- `state_change` (reopen/close) handling.
- Changes to `ChannelBase.handleInbound` or the dispatch-mode machinery — all
  routing is local to the GitHub adapter; the envelope contract is unchanged.

## Design

### Cursor

```ts
interface GithubCursor {
  lastProcessedAt: string;
  dispatchedBodies?: string[]; // existing — by chatId|threadId
  dispatchedComments?: string[]; // NEW — by comment node_id
  dispatchedNotifications?: string[]; // NEW — by notification id
}
```

All three lists share the same `MAX_DISPATCHED = 500` bound and eviction
(`slice(-MAX)`). `validateCursor` normalizes falsy-non-array values to `[]`,
mirroring the existing `dispatchedBodies` handling.

### Routing

A `routeByReason(reason)` helper maps the reason string to a lane:

| reason              | lane                         |
| ------------------- | ---------------------------- |
| `mention`           | `mention`                    |
| `review_requested`  | `review_requested` (PR only) |
| `assign`            | `assign`                     |
| `author`, `comment` | `aggregate`                  |
| everything else     | `generic`                    |

### pollOnce structure

The notification loop records `dispatchedNotifications` for a notification
**after** its lane finishes (success or per-thread error caught), so a
`markNotificationsAsRead` failure that aborts the poll before the cursor
advances does not re-dispatch already-handled notifications on the next poll.
Notifications that errored mid-lane are not recorded, so they retry on the next
poll (same as today).

The shared comment-fetching (`listComments` since `windowSince`, filter bot's
own + out-of-window) stays. What changes per lane is the dispatch decision and
the metadata framing:

- **`mention`**: iterate new comments; dispatch only those with
  `isMentioned === true`. First-contact body dispatch (existing
  `tryFirstContactBody`) stays for the no-mention-comment + unread case.
- **`review_requested`**: fetch PR meta; dispatch one envelope whose `text` is
  the PR body (or the first new comment when the body is empty) and whose
  `metadata` carries the review framing + PR meta + a summary of new comments.
  Skips PRs authored by the bot. New comments are listed only to surface them
  in metadata — they are not dispatched individually.
- **`assign`**: same shape as `review_requested` but with issue meta and a
  triage framing; reuses `octokit.rest.issues.get`.
- **`aggregate`**: list new comments; if none, skip; otherwise build one
  envelope whose `text` joins each comment body prefixed with its sender and
  whose `metadata` carries the "check and respond" framing + issue meta.
- **`generic`**: current per-comment dispatch; metadata gains a generic
  framing line. First-contact body dispatch stays.

`dispatchedComments` is recorded after each `handleInbound` (success or
error-comment-posted) keyed on `comment.node_id ?? String(comment.id)`.

### Metadata framing

Reason-specific framing is appended to the existing `Type | Title | URL`
metadata so the agent sees the trigger context. Example for
`review_requested`:

```
Type: Pull Request | Title: feat: add X | URL: https://github.com/owner/repo/pull/99
Trigger: review_requested. You were asked to review this PR. Author: alice | State: open | Draft: false | branch: feature-x → main
```

## Testing

Package-local tests in `packages/channels/github/src/GithubAdapter.test.ts`,
extending the existing `TestableGithubChannel` capture harness:

- each lane dispatches the expected envelope count / text / metadata
- `mention` lane skips non-mention comments (the noise-reduction assertion)
- `review_requested` lane calls `pulls.get` and dispatches with review framing
  even when there are no comments
- `assign` lane calls `issues.get` and dispatches with triage framing
- `aggregate` lane joins multiple comments into one envelope and skips when no
  new comments
- `generic` lane keeps current dispatch behavior
- cursor dedup: a re-fetched notification (same id) is skipped; a re-fetched
  comment (same node_id) is skipped
- existing tests updated where the new `mention` gating changes their outcome

## Risks

- The `mention` gating changes an existing tested behavior (non-mention
  comments under a `mention` notification no longer dispatch). Tests that
  asserted the old behavior are updated to assert the new, intended behavior.
- `review_requested` / `assign` add two extra API calls per matching
  notification (`pulls.get` / `issues.get`). Both ride the existing
  `githubApi` retry wrapper and only fire for their respective reasons, so the
  added call volume is bounded.
