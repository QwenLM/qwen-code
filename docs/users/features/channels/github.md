# GitHub

This guide covers setting up a Qwen Code channel that monitors GitHub notifications and responds to mentions, review requests, assignments, and followed-thread activity.

## Prerequisites

- A GitHub account authenticated with the permissions needed to read notifications and post comments
- The [GitHub CLI](https://cli.github.com/) installed on the host running Qwen Code when using local `gh` authentication

Use a dedicated bot account when the authenticated account also needs to operate the channel. GitHub does not generate a usable notification for the account's own activity, and the adapter ignores its own comments to prevent reply loops.

## Authentication

To reuse the GitHub CLI login on the Qwen Code host, authenticate `gh` and explicitly set `useLocalGh: true` in the channel configuration:

```bash
gh auth login
```

Local `gh` authentication is account-wide and may expose notifications from every repository visible to that GitHub account. Enable it only when the workspace operator is trusted to use that account. Otherwise, configure a dedicated PAT.

For GitHub Enterprise Server, authenticate the same host used by `baseUrl`:

```bash
gh auth login --hostname github.example.com
```

You can instead configure a classic personal access token (PAT). An explicit `token` overrides local `gh` authentication. The PAT needs these scopes:

- **notifications** — read notification threads
- **public_repo** (or **repo** for private repos) — post comments

## Configuration

Add the channel to `~/.qwen/settings.json`:

```json
{
  "channels": {
    "my-github": {
      "type": "github",
      "useLocalGh": true,
      "pollInterval": 60000,
      "reasonFilter": ["mention", "review_requested", "assign"],
      "operators": ["operator-github-username"],
      "sessionScope": "chat_thread",
      "cwd": "/path/to/your/project",
      "groupPolicy": "open",
      "groups": {
        "*": {
          "requireMention": true,
          "senders": "allowlist",
          "allowedUsers": ["operator-github-username"]
        }
      }
    }
  }
}
```

To override local `gh` authentication with a PAT, add `"token": "$GITHUB_TOKEN"` to the channel and set the environment variable before starting Qwen Code:

```bash
export GITHUB_TOKEN="ghp_your_token_here"
```

The authenticated account cannot trigger its own channel. If that account needs to operate the channel, authenticate a separate bot account and put their usernames in the group `allowedUsers` and explicit `operators` lists. Startup warns when a group allowlist contains the authenticated account, which cannot trigger tasks; use a different account in the group allowlist.

### GitHub Enterprise

For GitHub Enterprise Server, set `baseUrl`:

```json
{
  "baseUrl": "https://github.example.com/api/v3"
}
```

Local `gh` authentication requires an HTTPS `baseUrl` so the daemon host credential cannot be sent over plaintext HTTP.

## Configuration Options

| Option                    | Default                  | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------- | ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `token`                   | unset                    | Optional classic PAT with `notifications` scope; overrides local `gh` authentication                                                                                                                                                                                                                                                                                                                                                                                                    |
| `useLocalGh`              | `false`                  | Explicitly reuse the daemon host's account-wide GitHub CLI authentication                                                                                                                                                                                                                                                                                                                                                                                                               |
| `pollInterval`            | `60000`                  | Poll interval in ms                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `baseUrl`                 | `https://api.github.com` | API base URL (for GHE)                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `groupPolicy`             | `"disabled"`             | Must be `"open"`, `"allowlist"` with the repo (`owner/repo`) listed in `groups`, or `"pairing"` with the repo approved for notifications to flow                                                                                                                                                                                                                                                                                                                                        |
| `groups.*.requireMention` | `true`                   | Require @mentions for ordinary comments; directed notification reasons still run                                                                                                                                                                                                                                                                                                                                                                                                        |
| `reasonFilter`            | unset                    | Optional allowlist of GitHub notification reasons to process                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `repoFilterMode`          | `"off"`                  | Repository event filter: `"allowlist"` processes only the repositories listed in `repoFilter`, `"blocklist"` processes all except them, `"off"` processes everything. Applies to notification intake only                                                                                                                                                                                                                                                                               |
| `repoFilter`              | unset                    | `owner/repo` repository names used by `repoFilterMode`; required while the mode is `"allowlist"` or `"blocklist"`                                                                                                                                                                                                                                                                                                                                                                       |
| `deliverToBoundSessions`  | `false`                  | Deliver events for PRs bound to a live session into that session as a prompt instead of a channel-owned session (daemon-managed channels only)                                                                                                                                                                                                                                                                                                                                          |
| `prWatchEvents`           | unset                    | Optional state transitions to watch for bound PRs: `ci_failure`, `merge_conflict`, `head_change`, `state_change`. Requires `deliverToBoundSessions`                                                                                                                                                                                                                                                                                                                                     |
| `prWatchLimit`            | `30`                     | Maximum bound PRs watched per poll, kept between 1 and 500. Open PRs are watched first; a reserved slice (20%, at least one) drains merged/closed bindings even when open PRs fill the limit. Each watched PR costs about one `pulls.get` per poll — ~60 requests/hour at the 60s default, so a 5000/hour PAT budget admits ~80 PRs; over budget, every watch pass aborts on rate limits. Raise `pollInterval` when raising this. Requires `deliverToBoundSessions` and `prWatchEvents` |
| `boundSessionActions`     | unset                    | Optional operator instruction templates for bound-session delivery, keyed by event class with optional role prefixes (`review:`, `verify:`, `fix:`). Enables role-aware fan-out. Requires `deliverToBoundSessions`                                                                                                                                                                                                                                                                      |

Use `reasonFilter` to drop noisy notification classes such as `ci_activity` or `state_change`. Do not use `reasonFilter: ["mention"]` as a replacement for `groups.*.requireMention`: GitHub's `mention` reason is sticky at the thread level, so real new @mentions can arrive later under `comment`, `subscribed`, `author`, or other reasons and would be skipped.

Valid `reasonFilter` values are `mention`, `review_requested`, `assign`, `author`, `comment`, `ci_activity`, `manual`, `state_change`, `subscribed`, `team_mention`, `security_alert`, `approval_requested`, `invitation`, `member_feature_requested`, and `security_advisory_credit`.

Filtered notifications are marked read only after all accepted work in the poll window completes. Removing the filter later will not replay notifications the channel already skipped.

### Repository event filter

Use `repoFilterMode` together with `repoFilter` to filter incoming notifications by repository:

```json
{
  "repoFilterMode": "blocklist",
  "repoFilter": ["octo/noisy-repo", "octo/archive"]
}
```

- `"allowlist"` processes only the listed repositories; `"blocklist"` processes every repository except the listed ones; `"off"` (the default) processes everything.
- Repository names are matched case-insensitively and must be written as `owner/repo`. An active mode with an empty or malformed list is rejected at save time and at channel start.
- While the mode is `"off"`, a stored list is ignored, so you can park a list without it affecting the channel.
- The filter composes with `groupPolicy`: when both restrict repositories, only the intersection is processed. It applies to every incoming notification, including notifications about PRs bound to a live session (`deliverToBoundSessions`); only the PR state watch events (`prWatchEvents`) bypass it.
- Filtered notifications are journaled as `repo_filter` skips in the Channel event timeline and do not hold the poll cursor. Like `reasonFilter` skips, they are marked read with the window and are not replayed when the filter changes.

In the Web Shell editor, **Repository Filter** offers Off / Allowlist / Blocklist, and the **Filtered Repositories** list appears while a mode is active. You can paste repository or PR URLs there; they are shortened to `owner/repo` on save. Only URLs on the channel's own GitHub host are shortened — `github.com`, or the GitHub Enterprise host derived from the API base URL; URLs on any other host are rejected. On that host, URLs under known non-repository GitHub areas (`orgs/`, `apps/`, `settings/`, `trending/`, and similar) are also rejected instead of shortened. That area list is best-effort: a URL from a GitHub area not on the list can still be shortened, so check the saved `owner/repo` entries after pasting.

### Editing from the Web Shell

Settings → Channels → GitHub exposes the poll interval under **Connection**, in milliseconds. It is kept between 1 and 86400000 (one day): a larger value is clamped to the ceiling and a smaller positive one is raised to 1, because Node rounds a sub-millisecond timeout to about 1 ms and clamps one above its 32-bit range to 1 ms as well — either would turn the poll loop into a hot loop. Leave it empty for the 60000 ms default. When `groupPolicy` is `"allowlist"`, the **Access control** section also shows one row per allowlisted repository, each with a require-mention control and a speaker control.

A repository with no stored setting starts at **Inherit**, and the option label names the value it inherits — for example `Inherit (require a mention)`. A repository that already stores a value opens on that value instead, so a stored `requireMention: false` shows _Answer without a mention_. A row left at Inherit writes no key, so the repository keeps following `groups["*"]` and any later change to `"*"` still reaches it.

Choosing an explicit value writes that repository's `groups` entry. Choosing Inherit again removes the **policy** key, and what happens to a speaker list you typed depends on the policy the row then inherits:

- It inherits an allowlist from `groups["*"]`: the names stay in force, and the speaker box stays visible so you can keep editing them.
- It inherits **Anyone**: the names stay in the file but are not applied, because an open policy admits every group member. They apply again if the channel-wide policy later becomes an allowlist. The speaker box is not shown in this case, so there is nothing to clear.

The speaker box appears whenever the row's effective policy is an allowlist, whether the row set it or inherited it. What an **empty** box will do depends on the row's own policy, and the hint under the box says which case you are in:

- The row is set to **Allowlist only**: saving an empty box writes `allowedUsers: []`, which means _nobody_. The repository admits no one and does not fall back to the channel-wide list.
- The row inherits its policy: saving an empty box removes the per-repository list, so the channel-wide `groups["*"].allowedUsers` applies. This is also what happens when you clear a box that was showing stored names — the repository widens back to the channel-wide list rather than locking down.
- A stored `"senders": "allowlist"` with no `allowedUsers` beside it inherits its members, so its empty box reads as _inherit_; a stored `allowedUsers: []` with no policy admits _nobody_. The hint distinguishes the two.

Switching the group policy away from `"allowlist"` hides the rows but does not delete these entries. Under `"open"` and `"pairing"` the runtime keeps enforcing them, because per-repository senders and `requireMention` are resolved without consulting `groupPolicy`; under `"disabled"` the group gate drops every notification first, so the entries are kept but nothing is processed. The editor names the repositories whose settings this save keeps **and that can still take effect**, says which of those two cases applies, and tells you to switch back to Allowlist to edit them. A repository you typed during this visit is named too, even though it is not in the stored file yet. An entry is only announced when it can still change something: its own `senders` is `"allowlist"`, or its `requireMention` differs from the value it inherits. An `allowedUsers` list beside an inherited `"open"` policy restricts nobody — every group member is admitted regardless — so it is kept in the file but not announced as a setting that still applies. Row edits you made before switching are still written — including on a channel that was already `"open"`, and including a repository you added while the policy was `"allowlist"` — so the save cannot report success while restoring the old value. The one exception is a repository stored under two spellings that disagree, such as `Acme/Widgets` and `acme/widgets`: the editor cannot tell which spelling an edit was meant for, so an untouched save leaves both entries exactly as stored — including an empty one, which is what makes the exact spelling inherit `groups["*"]` rather than fall through to the other. If you edit that row and then switch the policy away from `"allowlist"`, the save is refused with a message under **Group policy** asking you to remove one of the two entries from `settings.json`, so the narrowing you just typed is never quietly dropped. Switching back to `"allowlist"` reports the same conflict.

Per-repository settings the editor does not model, such as `dispatchMode` and `groupHistoryLimit`, are preserved when you save. An entry that is already empty is preserved as well when the channel never used an allowlist, so an unrelated edit does not rewrite the file.

If `settings.json` holds a group entry whose value is not an object, the editor refuses the save and names the entry: the daemon rejects such an entry on every save, and no row in the form can represent it. Fix or remove it in `settings.json` and reload the channel. The editor does not delete it for you — removing the exact key would hand that repository to a differently spelled entry through the runtime's case-insensitive fallback.

## ⚠️ Security

On a **public repository**, setting `groups: { "*": { "senders": "open" } }` allows **any GitHub user** who triggers a supported notification reason to submit prompts that drive the agent in your `cwd`. This includes reading code, spending tokens, posting comments, and (subject to permission policy) running tools.

Always use `groups["*"].senders: "allowlist"` with explicit group `allowedUsers` on public repos.

All GitHub traffic is group traffic. Group members default to `open`; set `groups["*"].senders` to `allowlist` and populate its `allowedUsers` to restrict authors. Private policy and user pairing never restrict repository members. Set `operators` explicitly for shared-session management.

Group member allowlists and operator lists follow the **username**, not the immutable account ID. If a listed user renames their GitHub account, remove the stale entry — GitHub releases the old username for anyone else to claim, and the new holder would inherit that authorization.

Note that under `groupPolicy: "pairing"`, access is granted per repository: once a repository is approved, **any GitHub user** can by default drive the bot through that repository's issues and pull requests. All GitHub traffic is group traffic, so `privatePolicy` and the top-level `allowedUsers` do not gate members of an approved repository; set `senders: "allowlist"` with `allowedUsers` on that repository's `groups` entry to narrow it. Approvals are keyed by the repository full name (`owner/repo`), which changes on rename or transfer — revoke stale group approvals after any repository rename, transfer, or deletion.

## Mention Detection

The adapter detects mentions by scanning comment text and first-contact issue or PR bodies for `@bot-username` using a case-insensitive regex. It does not trust `reason: "mention"` alone because that value is sticky at the thread level. Other reasons select review, triage, followed-thread, or fallback prompts.

## How It Works

The adapter uses GitHub's Notifications API as a wake-up signal:

1. **Poll** `GET /notifications` for unread threads
2. **Enumerate** comments via `listComments` within a cursor-based time window
3. **Persist accepted work** before dispatch, including the source envelope and deduplication keys
4. **Dispatch** by notification reason: strict mention matching, pull request review, issue triage, followed-thread comment aggregation, or per-comment fallback
5. **Commit the poll window** only after accepted work completes: mark notifications read and advance the cursor
6. **First-contact fallback**: a brand-new unread issue/PR body can be processed when no comment was dispatched; mention notifications still require an actual body mention

The comment window is `(previousCursor, currentMaxUpdatedAt]`. The notification cursor and the accepted, running, and failed tasks are stored under `~/.qwen/channels/<workspace-scope>/` with private file permissions, so two workspaces running a channel of the same name keep separate cursors. On restart, the channel recovers those tasks before polling GitHub again. Failed tasks are attempted up to three times, then become terminal; cancelled tasks are terminal and are not rerun. A task whose final reply was already posted, suppressed, or queued for definite no-write retry is not rerun.

The notification cursor does not advance while recoverable tasks remain, or when inbound task state cannot be read or written. It also stays put when GitHub fails while a notification is being read and may answer differently later. Mark-as-read takes a single timestamp, so every listed notification stays unread and the next poll reads the whole window again; comments already handled are not answered twice. A rate limit or a credential failure stops reading the rest of that poll and holds the window until GitHub answers again. A 5xx, or a network failure before GitHub answers (Octokit reports it as 500), holds the window for at most 30 polls: on the 30th poll that sees one, the threads that still fail are skipped and the window can be marked read. At the default interval that is about 30 minutes, plus the in-call retries of each failing read (three attempts with 1 s and 2 s pauses). The count is kept in memory, so a restart begins it again. A notification listed again at or before the cursor, because its mark-as-read did not apply, belongs to a window that already committed: a 5xx reading it neither holds the window nor spends the budget (a rate limit still holds it, since the threads after it have not been read). A permanent answer such as 404, or a local error, skips the thread at once, with two exceptions that hold the window already, so the thread is read again: an error from a failing task store, which holds the whole window on its own, and an error while one of the thread's own tasks has not settled (an error inside its run leaves it running), which holds the window until that task settles. In the Channel event timeline these failures carry the reason `github_api_error`: a `failed` row means the window is held and the thread will be read again, and a `skipped` row means the channel stopped holding the window for it, so a comment of the thread in that window is lost if the thread still fails when the window is marked read. A notification listed again at or before the cursor normally has no such comment, since its activity was read before an earlier window was marked read. While a window is held, the Channel event timeline records a failing thread on its first failing poll in that window and on every tenth, a rate limit or credential failure on its first and every tenth poll, and a skipped thread or comment once. The rows written once per window are tracked under up to 8,192 keys; a row whose key no longer fits is written on every poll. This prevents a crash, an agent failure, or a GitHub hiccup from losing a comment and preserves the deduplication keys needed to avoid a second dispatch from the notification feed. There are two deliberate exceptions. **Bound-session backpressure** (see below): a deferred bound delivery has its own durable retry and a bounded deferral horizon, so it does not hold the shared cursor — its notification is marked read while the event stays recoverable in the task store. **Watch tasks while pending-event reconciliation is blocked** (for example an unreadable watch state file): they cannot make progress until a reconciliation succeeds, and watch events are detected from PR state rather than notifications, so they leave the cursor free as well — unrelated comments keep flowing, and the watch events deliver exactly once after the state file recovers.

Non-comment activity (push, label changes) bumps the notification's `updated_at` but produces zero new comments in the window, so re-fetched threads are skipped without triggering the agent.

## Response Feedback

For an accepted issue or pull-request comment, the channel adds GitHub's `👀` reaction while the agent is working, then removes it when the run completes, fails, or is cancelled. Both operations are best-effort: a reaction API or permission failure is logged and never prevents the final response.

### Final-only output

The GitHub channel publishes only completed responses. Intermediate model chunks are never published as separate comments.

If GitHub returns a definite no-write delivery failure — its rate limiter
rejecting the comment with a 403 or 429 that carries a numeric
`x-ratelimit-remaining` header and shows the hourly budget exhausted, sends
`retry-after`, or names a secondary rate limit in its message — the channel
retries the comment twice more, waiting as
long as GitHub asks: `retry-after` when GitHub sends it, the budget reset when
the hourly budget is exhausted, and otherwise one minute and then two (also
when the reset already looks past, which means the local clock is ahead). If it
still fails, or the channel stops during the wait, the channel stores the
final reply in
`~/.qwen/channels/<workspace-scope>/<channel>-<name-hash>-github-pending-deliveries.json`
with private file permissions and retries it on the next channel start. That
retry stops sending at the first stored reply GitHub still rate-limits and
keeps the later ones for the following start, together with that reply when
GitHub's headers prove it was not posted; replies the audit already records as
posted are dropped. The corresponding inbound task
remains in `reply_pending` state until that delivery succeeds or reaches a
definite terminal failure. Ambiguous delivery failures are not retried
automatically because GitHub may have created the comment: the audit records
`failed_ambiguous` and the reply is not kept. A rate-limit answer without a
numeric `x-ratelimit-remaining` header, such as a 429 with only `retry-after`
from a proxy in front of GitHub, is one of them.

## PR-Bound Session Delivery

By default every event is handled by a channel-owned session. With
`deliverToBoundSessions: true`, events for a PR that is bound to a live session
(the PR bindings shown in the Web Shell sidebar, registered when a session
creates or reviews a PR) are delivered into that session as a prompt instead,
so the session that follows the PR handles the event with its existing context.

Public-path replies (events with no bound session, including the fallback
when a bound session has gone and no replacement exists) run in a background
task runner: the poll loop claims the event durably and moves on, so a long
agent turn on one PR never blocks watch detection, bound delivery, or intake
of new notifications. Public tasks execute one at a time in claim order —
which also serializes them against each other on a shared channel session —
and a turn interrupted by a restart is recovered from the durable task store.
While a thread's public turn runs, the channel stops re-fetching that
thread's comments on every poll of the frozen notification window; the
thread is re-read once the turn settles.

- The injected prompt marks all GitHub content as untrusted event data. The
  session's reply stays in the session; it is **not** published to GitHub
  automatically, and the session may act on GitHub through its own tools.
- Comment sender, repository and pairing gates still apply before delivery.
  When several sessions are bound to the same PR, the most recently updated
  non-archived session wins; channel-owned sessions are never candidates. With
  `boundSessionActions` configured, routing becomes role-aware instead: one
  winner per role, fan-out across roles (see below).
- A plain conversation comment on a bound PR reaches the session without a
  mention when the repository's group sender policy is an allowlist that lists
  the sender: the mention requirement (`groups.*.requireMention`) keeps ambient
  chatter out of public replies, and a bound event stays private. Accounts in
  `operators` keep the mention requirement: a bound session usually acts on
  GitHub as an operator's account, so list that account in `operators` (which
  also lets it manage shared sessions), or its own comments come back to it as
  new turns. Repositories that admit any sender (where every drive-by or bot
  comment would otherwise become a session turn), the PR's own description and
  unbound threads still need a mention, and unlisted senders are not delivered
  at all. Notifications GitHub gives the `author` or `comment` reason are the
  exception, as before: every comment there that passes the sender gate is
  forwarded, an operator's included. GitHub keeps a thread's `mention` reason
  once the bot is mentioned in it, so those rules then apply instead. With
  `messageRoutes` and no `defaultMessageRoute`, a plain comment also needs a
  route prefix. On threads GitHub lists as a mention, assignment or review
  request, such a comment is delivered as a `comment` event, so with
  `boundSessionActions` it reaches the roles whose templates cover `comment` or
  `default`, never through a template keyed by the thread's reason (`mention`,
  `review_requested`); and it is never answered in public: if no bound session
  is left, it is dropped. The channel only sees comments its account is
  notified about and reads PR conversation comments, not inline review comments
  (see Known Limitations); to follow comments on PRs the bot account did not
  open or review, have that account watch the repository, and include
  `subscribed` if you set `reasonFilter`.
- When no bound session exists (or it cannot be restored), **comment** events
  fall back to the normal channel path and its public-reply contract — on a
  complete binding snapshot; while the snapshot is partial or its refresh is
  failing, the fallback defers until a complete snapshot establishes that no
  follower exists. A bound
  session that is dormant after a daemon restart is woken automatically for
  the delivery, so restarts do not divert events into public replies.
  **Watch events (below) are private-only**: with no bound target they are
  logged and retired, never published as PR comments.
- A full prompt queue, a rate-limited daemon (HTTP 429), or a temporarily
  unavailable session defers the event without consuming the retry budget;
  the deferral is bounded (240 consecutive deferrals — ~4 hours at the
  default 60s poll, and proportionally longer with a larger `pollInterval`),
  and events that exhaust it are retired to a private dead-letter log
  (`~/.qwen/channels/<workspace-scope>/<channel>-<name-hash>-github-bound-deadletter.jsonl`)
  with a stderr alert rather than silently dropped. If the dead-letter write
  itself fails, the task is kept (not removed) so the event stays recoverable.
  Deferred bound events do not hold the shared notification cursor: their
  notifications are marked read while the durable task keeps retrying.
- **Two operator-visible states stop bound delivery from processing events.**
  (1) _Cold start_: with `deliverToBoundSessions` on, the comment lane waits
  for the first successful binding lookup. While the lookup has never
  succeeded — or keeps answering an **empty partial** snapshot (a workspace whose
  files the daemon cannot read) — `pollOnce` returns before fetching notifications, so
  no GitHub event is processed; a throttled stderr line names the
  state. The empty-partial deferral is bounded (30 consecutive polls): after
  that the lane opens, and events whose PR is still absent from the incomplete
  snapshot defer per-event (backpressure above) instead of taking the public
  path — an incomplete scan never establishes that a PR is unbound. That
  per-event deferral is PR-scoped: bindings are PR-only, so once the lane is
  open an issue event is never deferred by it (its absence needs no snapshot)
  and routes publicly even under a permanently partial scan. A partial
  snapshot only arises when part of the catalog could not be read (a chats
  directory the daemon could not list, a PR sidecar, transcript or live
  session list it could not read, or a workspace whose runtime is missing)
  or when the channel worker had to drop a malformed binding row (check that
  the worker and the daemon run the same version; the worker logs the
  drop); the number of active sessions never makes it partial. While such a failure persists, a
  comment on a PR that no session follows defers per-event until the
  dead-letter horizon (~4 hours at the default poll) rather than falling back
  to the channel; issue events are unaffected, since the per-event absence
  gate is PR-scoped. The lane-level
  cold start above still holds every notification, issue events included,
  until the first successful binding lookup. Once a complete snapshot lands,
  deferred events are re-resolved: delivered privately to a follower, or
  publicly once the complete snapshot establishes there is none. (2) _Backpressure_: a deferred bound event keeps its own durable
  retry (previous bullet) while the rest of the channel continues normally.
- The injected prompt names the comment author and marks truncation
  explicitly at every level: comment content is capped at 6,000 code points
  with an `[prompt truncated: N more characters omitted]` notice, an
  aggregate batch that drops older comments says so, and each aggregated
  comment's 400-character display cap carries its own
  `[comment truncated: N more characters]` marker — no tail is silently
  consumed.
- This feature requires a daemon-managed channel; standalone
  `qwen channel start` ignores the setting with a warning.

With `prWatchEvents`, the channel additionally watches bound PRs for state
transitions the Notifications API cannot deliver, inside its existing poll
cycle: `ci_failure` (checks turn red on a head, once per head — including
`startup_failure`), `merge_conflict` (`mergeable_state` becomes `dirty`,
edge-triggered: `dirty → clean → dirty` fires again), `head_change` (new commits
pushed, including a force-push revisit of a recent SHA), and `state_change`
(PR merged or closed; close → reopen → close fires again). Detection is
API-level and spends no model tokens until a transition fires. A quiet PR with
settled CI costs one API call per poll; a PR whose CI is still pending is
re-checked every 5 minutes until it settles, and settled heads are re-checked
every 10 minutes (GitHub does not advance a PR's `updated_at` on check
re-runs, so the periodic re-check is what catches a re-run turning red). At
most `prWatchLimit` bound PRs are actively polled (default 30). Open PRs take
priority, most recently bound first; a reserved slice of the budget (20%, at
least one) drains bindings already recorded as merged/closed — each needs
one final observation before it leaves the watch set, so dead bindings never
crowd out live PRs and the drain still progresses when open PRs fill the
limit. A binding the watch already observed closed is tiered as terminal
even if the registry still says open. When the budget cannot cover every
active binding, the channel logs `PR watch cap exceeded` with the excluded
list; raise `prWatchLimit` (and `pollInterval`) to cover more open PRs. Each
watched PR costs about one `pulls.get` per poll — ~60 requests/hour at the
60s default, so a 5000/hour PAT budget admits ~80 PRs; an over-budget
configuration makes every watch pass abort on rate limits. A credential
failure or rate limit (401/403/429) aborts the whole watch pass for that poll
— one shared failure must not issue one doomed request per watched PR —
while a per-PR permanent status (404/410/451) only skips that PR. A failing
Checks endpoint never suppresses the other three detections: their data
comes from `pulls.get`, and the last known CI aggregate stands until a fetch
succeeds again.
Transitions are persisted before delivery, so restarts do not re-fire them.

### Role-Aware Action Templates

With `boundSessionActions` configured, bound delivery becomes declarative and
role-aware: the operator states what each kind of session should do when an
event arrives, instead of relying on the session's own context to guess.

**Roles.** A binding can carry a role — `review`, `verify`, or `fix`. The
prompt-route backfill assigns `review` when a session runs `/review <N>` and
`verify` for `/verify-pr <N>`; `fix` is bound explicitly through the session
metadata API (`PATCH /session/:id/metadata` with `pr: { number, url, role:
"fix" }`; `role: null` clears it, an omitted role preserves it). Bindings
without a role are _untyped_. A later command re-offer never overwrites an
existing role.

**Keys and resolution.** Each key is an event class, optionally prefixed with
a role: `watch:head_change`, `comment`, `review:watch:head_change`,
`verify:default`, or the catch-all `default`. The `watch:` prefix matters:
`state_change` is both a watch transition and a notification reason — bare
`state_change` matches the notification, `watch:state_change` the transition.
For each role group the chain resolves `<role>:<event>` → `<role>:comment`
(for comment events) → `<role>:default` → `<event>` → `comment` → `default`;
**no match skips that role for the event** — the map is a per-role
subscription. Comment events carry the thread's notification reason
(`mention`, `subscribed`, `author`, ...), so `fix:comment` catches a comment
delivered under any of those reasons, while a reason-specific key such as
`fix:mention` still wins when configured. Untyped bindings resolve only the
bare chain.

**Routing.** One winner per role (the most recently updated follower within
the group), fan-out across matched roles — at most four deliveries per event
(review, verify, fix, untyped), never one per session. Each delivery is its
own durable task: a queue-full role defers independently without blocking
the others, and a lost session falls back only within its own role. Once any
role has accepted an event privately, it is never also answered publicly —
a durable delivery history enforces this even if every follower later
disappears. Comment events fall back to the channel path only when no role
has a live follower on a complete snapshot and no role ever accepted the
event.

**Templates.** Values are operator instruction templates with `%repo%`,
`%pr%`, `%url%`, `%title%`, `%event%`, `%sender%`, and `%role%` variables;
`%%` renders a literal `%`, and an unknown `%foo%` stays literal so typos are
visible. Substituted GitHub values are sanitized and capped at 200 code
points with a visible marker. The rendered instruction appears in a labeled
`[Operator instruction — trusted, from this channel's configuration]` block;
the untrusted-data warning explicitly covers the substituted values. Example
for a review / verify / fix split across three workspaces:

```json
{
  "deliverToBoundSessions": true,
  "prWatchEvents": ["head_change", "ci_failure", "merge_conflict"],
  "boundSessionActions": {
    "review:watch:head_change": "The PR head advanced. Run /review %pr% --resume and report the delta since your last review.",
    "verify:watch:head_change": "The PR head advanced. Run /verify-pr %pr% --publish.",
    "fix:watch:ci_failure": "CI failed on the current head. Diagnose the failed checks named below and fix them.",
    "fix:watch:merge_conflict": "The PR has a merge conflict. Resolve it.",
    "fix:comment": "New review comments arrived. Address the actionable ones."
  }
}
```

One head advance then produces two prompt turns (review + verify); the fix
session is only disturbed by CI failures, conflicts, and comments.

**Boundaries.** A template is an instruction, not an execution guarantee:
the session's model keeps discretion and its approval mode governs actions.
A template containing `--publish` is the operator's explicit publication
consent for the rounds it triggers — configure it deliberately. With
`boundSessionActions` absent, delivery keeps the legacy single-winner
behavior and the generic prompt, byte for byte.

## Known Limitations

- **First start skips existing unread notifications.** The cursor initializes to "now" on first launch. Notifications created before the bot starts are not processed unless the thread receives new activity afterwards.
- If a user marks a notification as read on github.com before the bot's poll cycle, the bot will not process it.
- The bot does not read comments before the current polling window; `author` and `comment` notifications may aggregate up to 20 comments from that window.
- Inline PR review comments and review summary bodies are not enumerated; only issue/PR comments are processed.
- The selected credential must support the Notifications API. Fine-grained PATs do not support it; use local `gh` authentication or a classic PAT with `notifications` scope.

## Starting the Channel

```bash
qwen channel start my-github
```
