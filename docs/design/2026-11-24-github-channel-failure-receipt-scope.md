# Scope the GitHub channel failure receipt to explicit mentions

[English](2026-11-24-github-channel-failure-receipt-scope.md) | [简体中文](2026-11-24-github-channel-failure-receipt-scope.zh-CN.md)

## Problem

When a public-path inbound task fails on its last attempt, the GitHub channel
posts this comment on the thread:

```
⚠️ Failed to process this request. Please re-mention the bot to retry.
```

The receipt assumes that a sender is waiting for an answer. That assumption
fails for events nobody addressed to the bot. On 2026-11-24 a CI failure
notice from `github-actions[bot]` on PR #18009 produced the receipt three
minutes later, published under the maintainer's own account. The thread then
held a public message that (a) addressed no sender, (b) read as the PR author
reporting a failure, and (c) carried no detail about which request failed or
why.

## Current state

Two gaps produce the receipt:

1. The comment lanes exclude only the channel's own account
   (`comment.user?.login !== this.botUsername`). A comment from any other
   machine account enters the lane.
2. "Does this need a reply?" is answered only by the model, through the
   `<no-reply/>` sentinel. When the model call fails three times, no sentinel
   exists, so the adapter cannot tell an unanswered question from an event that
   never needed an answer. It falls back to the public receipt.

## Goals

- Do not spend model attempts on a machine-authored comment that does not name
  the bot.
- Do not publish a failure receipt unless the event names the bot.
- Keep the skip visible: the Channel event timeline records what was dropped
  and why.

## Non-goals

- Changing the receipt text, its author, or adding a hidden marker.
- Throttling receipts per issue (see open questions).
- Applying the same policy to the GitLab adapter, which has its own copy of the
  receipt logic.
- Filtering inline pull-request review comments, which use a separate lane.

## Proposed change

### 1. Skip unmentioned machine-authored comments

A comment is machine-authored when `user.type` is `Bot` or the login ends in
`[bot]`. When such a comment does not mention the bot, both the per-comment
lane and the aggregate lane skip it before a task is claimed, and record
`{ type: 'inbound', outcome: 'skipped', reason: 'machine_author' }` with the
comment key and actor.

A machine-authored comment that does mention the bot still enters the lane, so
bot-to-bot requests keep working.

### 2. Gate the receipt on an explicit mention

`Envelope` gains an optional `isExplicitMention` field. It is `true` only when
the message text names the bot, which is a narrower claim than `isMentioned`:
the adapter also sets `isMentioned` for an implicitly directed event (a thread
the account owns, an aggregate digest).

- Comment lane: `isExplicitMention: hasMention`.
- Aggregate lane: `true` when at least one comment of the batch names the bot.
- Issue event lane (`review_requested`, `assign`): `true`, because the event is
  itself a request.
- First-contact issue body: the same value as `isMentioned`, which is `true`
  only when the body names the bot.

`postErrorComment` now requires `envelope.isExplicitMention === true`. An
event without the flag still records each failed attempt in the task row and
the event timeline; it only loses the public receipt.

## Decisions and rationale

- **Two machine signals, not one.** The REST API returns `user.type`, but a
  cached or partial payload can omit it. The `[bot]` login suffix keeps the
  filter effective in that case.
- **A new field instead of reusing `isMentioned`.** `isMentioned` is already
  `true` for every comment in the author-triggered lane and for every digest,
  so it cannot separate a question from overheard traffic.
- **Digest decides per batch.** A digest that mixes one mention with ambient
  comments still has a sender waiting, so the batch-level flag is `true`. A
  batch with no mention has none.
- **Issue events stay `true`.** A review request or an assignment is a direct
  request even when the text has no `@`.

## Constraints

- Only the GitHub adapter changes. `Envelope` is shared, but the new field is
  optional, so other adapters keep their current behavior.
- A task created before this change has no `isExplicitMention`. On recovery it
  gets no receipt. This is a one-time upgrade effect.

## Risks

- **A first-contact body that does not name the bot fails silently.** A channel
  configured to watch every new issue loses the public receipt for those
  failures. The failed task row and the event timeline still record them.
- **A machine account that posts as a normal user** is not caught by the
  author filter. The channel's own bot account is already excluded by login.
- **The aggregate lane drops a machine comment even when the sender gate would
  have rejected it anyway.** The recorded reason becomes `machine_author`
  instead of the sender rejection, which is the more precise cause.
- **A skipped machine comment is re-listed by every later window.** It is never
  dispatched, so no cursor key covers it; the per-window journal keeps that to
  one `machine_author` row per window.

## Validation

- `packages/channels/github`: `npx vitest run src/GithubAdapter.test.ts
--coverage.enabled=false` — 827 passed.
- New cases: a machine-authored unmentioned comment is skipped and journaled on
  the aggregate lane and on the pairing lane; a machine-authored comment that
  names the bot is kept; a mixed batch drops the CI notice and keeps the human
  remark; an unmentioned batch that fails three times posts no receipt.
- Mutation check, four arms, each restored and re-run green afterwards:
  - disable the author filter: three skip cases red (`expected [ { …(12) } ] to
have a length of +0 but got 1`);
  - drop the mention exception: the keep case red (`expected [] to have a
length of 1 but got +0`);
  - remove the `isExplicitMention` condition: both receipt cases red
    (`expected "spy" to not be called at all, but actually been called 1
times`, `expected … to have a length of 1 but got 2`);
  - disable the comment-lane call site only: the pairing case red (`expected
[ { …(12) }, { …(12) } ] to have a length of 1 but got 2`).
- `npx tsc --noEmit -p tsconfig.json` in `packages/channels/base` and
  `packages/channels/github` — exit 0.
- `npx prettier --check` and `npx eslint` on the changed files — exit 0.

## Acceptance criteria

1. A comment from a machine account that does not name the bot creates no task,
   posts no comment, and records one `skipped` row with reason
   `machine_author`.
2. A comment from a machine account that names the bot is dispatched as before.
3. A public-path task whose event has no explicit mention posts no receipt after
   three failed attempts; its task row ends `failed`.
4. A public-path task whose event has an explicit mention still posts exactly
   one receipt after three failed attempts.
5. `docs/users/features/channels/github.md` states both rules.

## Open questions

- Should the receipt carry a hidden marker and a bot author instead of the
  maintainer's account? This is the larger fix for the identity problem and is
  out of scope here.
- Should receipts be throttled per issue? Issue #16228 reports duplicates when
  several tasks fail on one thread.
- Should the GitLab adapter adopt the same two rules?
