# Aone channel plugin (polling, command-prefix triggered)

[English](2026-11-16-aone-channel-plugin.md) | [简体中文](2026-11-16-aone-channel-plugin.zh-CN.md)

> Status: implemented (local unit + E2E verification complete; not yet
> merged). Sibling of `2026-08-15-review-aone-provider.md` and
> `2026-08-27-session-pr-aone-provider.md` (reuses their probed platform
> facts; touches none of their code paths).

## Problem

Channels turn a platform's inbound messages into agent prompts and post the
agent's reply back. Code-platform channels exist for GitHub (Notifications
API polling) and GitLab (Todos API polling). Aone Code — Alibaba's internal
code platform (`code.alibaba-inc.com`, git host `gitlab.alibaba-inc.com`) —
has no channel, so an agent cannot hear CR comments or answer them.

The two existing code-platform channels are driven by a cross-repository
notification inbox addressed to the bot account. Aone has no verified
equivalent: the `a1` CLI exposes no Notifications/Todos inbox API.

## Verified platform facts (probed 2026-11-16, a1 0.2.51)

Full probe journal: `.qwen/investigations/aone-channel-inbound-probe.md`
(git-ignored). Key facts, all read-only probes against `middleware/tddl5`:

| Capability              | Command / shape                                                                                           | Notes                                                                                                                                                                                                                                                       |
| ----------------------- | --------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Inbound event stream    | `a1 events repo <group/project> --type comments --format json [--per-page 100] [--page N]`                | Per event: `id` (monotonic event id), `createdAt`, `author` (username), `user.name`, `note.id`, `note.note` (full body), `note.noteable_type`, `mergeRequest.{id,iid}` (`id` is the GLOBAL CR id), `projectDetail.path_with_namespace`. Descending by time. |
| Window / paging         | documented default window = today − 3 days → today; max range 30 days; `--per-page` ≤ 100, `--page` ≤ 100 | FAQ page「events 活动事件」describes auto-completion, but a1 0.2.51 REJECTS omitted dates ("--since and --until are required and must be used together", probed live). The adapter passes the 3-day window explicitly, in local-calendar dates.             |
| `events user` semantics | activity authored BY the user, NOT an inbox                                                               | Discriminating probe: querying a user returns that user's own fresh comments. No cross-repo "@me" API exists in a1.                                                                                                                                         |
| Inline comments         | appear in the event stream                                                                                | AGit-Flow stale-patchset inline comments vanish from every `comment list` mode but remain in events — events are the more complete source.                                                                                                                  |
| Outbound                | `a1 repo mr comment create --repo <g/p> --mr <global-id> -m <body> [--reply-to <note-id>]`                | Write-once semantics (review provider precedent): never retry a write.                                                                                                                                                                                      |
| Identity                | `a1 auth whoami --format json` → `account`                                                                | The bot identity is the a1-authenticated account on the channel host.                                                                                                                                                                                       |
| Errors                  | exit code UNRELIABLE                                                                                      | a1 may answer `{"schemaVersion":"a1.error/v1",...}` at exit 0 OR exit 1 (stdout). The parsed shape is the error signal.                                                                                                                                     |
| Trigger convention      | command prefixes, not @mentions                                                                           | 103 comments over 6 days on tddl5 contain zero @mentions; the team's existing agent workflow uses prefixes (`force-review:`, `precheck_all`, `test_coverage`). Platform bot precedent: `codereview-copilot`.                                                |
| URL discipline          | `mr view` `detailUrl` is the only sanctioned CR URL                                                       | List output carries empty `detailUrl`/`webUrl`; Aone links are never assembled (nested-group collapse is non-injective).                                                                                                                                    |

## Goals

- An Aone channel adapter, packaged as an **extension plugin** (the
  `plugin-example` pattern): a workspace package under `packages/channels/aone`
  with a `qwen-extension.json` manifest, loaded through
  `loadChannelsFromExtensions()`. **No builtin registration, no core change.**
- Inbound: poll the comment event stream of each configured repository,
  dispatch comments that start with a configured trigger prefix.
- Outbound: post the agent reply as an MR comment via `a1`.
- Reuse `PollingChannelBase` (cursor persistence, poll loop, backoff) and the
  shared gating/routing/bridge pipeline.

## Non-goals (v1)

- @mention triggers (syntax unverified; prefix triggers cover the team's
  existing convention). Mention support is a follow-up.
- Issue comments (`noteable_type !== 'MergeRequest'` is skipped).
- Webhook inbound (no CR-event webhook receiver documented in a1/FAQ).
- Proactive send, acknowledgement reactions, platform message chunking.
- Backlog digest for outages longer than the 3-day default window.
- Builtin registry entry / Web Shell builtin catalog.

## Design

### Package layout

```
packages/channels/aone/
  package.json            # @qwen-code/channel-aone, deps: channel-base, zod
  qwen-extension.json     # channels.aone → dist/index.js
  tsconfig.json           # extends root, references ../base
  vitest.config.ts        # sibling pattern (gitlab)
  src/
    index.ts              # plugin object + management descriptor
    AoneAdapter.ts        # PollingChannelBase adapter
    a1-client.ts          # async a1 exec + error-object contract + test seam
    trigger.ts            # prefix match / strip
    *.test.ts             # collocated tests
```

Added to the workspaces lists in BOTH `package.json` and
`pnpm-workspace.yaml` (the mirror is pinned by
`scripts/tests/package-scripts.test.js`). Not added to `ensureBuiltins()`.

### Configuration

```json
{
  "channels": {
    "aone-tddl": {
      "type": "aone",
      "cwd": "/path/to/an/aone/workspace",
      "repos": ["middleware/tddl5"],
      "triggerPrefixes": ["qwen:"],
      "groupPolicy": "allowlist",
      "groups": {
        "middleware/tddl5": {
          "senders": "allowlist",
          "allowedUsers": ["shaojin.wensj"]
        }
      },
      "sessionScope": "chat_thread",
      "pollInterval": 60000
    }
  }
}
```

The sample is restrictive on purpose: on a company-wide code host any
commenter can otherwise drive the agent in the channel's `cwd` as the
a1-login account and answer publicly. `groupPolicy: "open"` with
`groups: { "*": { "senders": "open" } }` is a deliberate opt-in for trusted
hosts (it is what the local E2E harness used), not the recommended default.

- `repos` (string-list, required, ≥1): repository full paths to watch.
  There is no inbox, so the watch list is explicit. Matched and stored
  lowercased (GitLab `normalizeGroupId` precedent); the event's canonical
  `path_with_namespace` is used for routing when present.
- `triggerPrefixes` (string-list, required, ≥1): a comment triggers when its
  trimmed body starts with any prefix, case-insensitively. The matched
  prefix is stripped from the prompt text (GitHub mention-strip precedent).
- `promptTemplate` (string, optional): metadata template rendered into
  `envelope.metadata` (kept separate from `text` so slash-command parsing
  sees the comment body alone). Variables: `%repo%`, `%mr_id%`, `%mr_iid%`,
  `%author%`, `%comment_id%`, `%title%`, `%url%`; `%%` escapes a literal `%`.
  `%title%`/`%url%` lazily fetch `a1 repo mr view` (once per MR per poll,
  cached — GitLab `descriptionCache` pattern; a FAILED view is negatively
  cached for the poll too, so N events on a forbidden MR cost one call, not
  N × the 20s timeout); `detailUrl` is taken verbatim from the view, never
  assembled. An empty or whitespace-only value falls back to the default
  template (the descriptor documents "leave empty for the default"); it
  must not silently strip the CR context header. Default template:
  `Aone CR %repo% !%mr_id% (iid %mr_iid%) | author: %author% | comment: %comment_id%`.
- Access boundary: every Aone inbound is group-shaped (`isGroup: true`),
  so `ChannelBase.senderGateFor` uses the GROUP sender gate —
  `groups[<repo>].senders` (falling back to `groups["*"].senders`, default
  `open`) with the allowlist resolved as `groups[<repo>].allowedUsers`
  falling back to `groups["*"].allowedUsers`, and to an EMPTY list (which
  admits nobody) when neither entry names one. The TOP-LEVEL
  `allowedUsers`/`privatePolicy` apply only to DM-shaped traffic, which
  this channel never produces; configuring them alone restricts nothing.
  `groupPolicy` must be `open`/`allowlist`/`pairing` for dispatch (connect
  warns otherwise); the plugin declares the field with default `open`
  because the shared injected field defaults to `disabled`, which would
  dispatch nothing for an editor-created channel. The management UI seeds
  `groupPolicy` from that default, and its shared group-sender fields DO
  write `groups["*"].senders` / `groups["*"].allowedUsers` (channel-wide),
  and its allowlist membership field creates `groups[<repo>]` entries;
  what it cannot write for this plugin is a per-repository SENDERS
  override (those rows exist only for the repository-only types
  github/gitlab), so a membership entry's senders fall back to the
  channel-wide `*` policy. A UI-created channel is therefore permissive
  only while the operator leaves Group senders at its default.
  `connect()` warns about the watched repos that are ACTUALLY open — open
  senders AND reachable: under `groupPolicy: allowlist` the group gate
  rejects a repo with no `groups` entry as `not_allowlisted` BEFORE the
  sender gate runs, so such a repo is dead, not open, and is excluded from
  the permissive warning (a per-repo allowlist with no `*` entry is
  likewise restricted and does not warn). It separately diagnoses the dead
  repos: when EVERY watched repo lacks an entry it warns that nothing
  dispatches; when only SOME lack entries (a mixed watch list) it names
  those repos so the operator knows their triggers silently drop while the
  reachable repos still warn normally. Under allowlist `*` is a default
  config, not a wildcard allow. The sample below shows the per-repository tightening
  a hand-written config must do. `sessionScope` defaults to `chat_thread`
  (one session per repo+MR thread). No `token` field — a1 authenticates
  through its own login on the channel host.

### Inbound pipeline (`pollOnce`)

Each configured repo is polled in its own try/catch: a failing repo logs
its error, records a durable `repo_failed` journal event (the round
resolves on partial failure, so the base loop's own poll record would
otherwise show ok and the broken repo would leave no trace the status
page can show), and the round CONTINUES with the remaining repos. The
round rethrows ONLY when EVERY repo failed, so the base loop records a
failed poll and backs off; a PARTIAL failure completes normally and keeps
the configured `pollInterval` cadence (the base failure path skips the
interval sleep — rethrowing on a partial failure would poll the healthy
repos on the backoff ladder, ~30s instead of 60s, 120× at a one-hour
interval). Without the isolation an uncaught throw unwinds the round, the
base loop restarts from `repos[0]`, and a permanently broken repo starves
every repo listed after it (their comments age out of the window unseen).

Per repo:

1. The `--since <today−3d> --until <today>` window (explicit local-calendar
   dates — a1 0.2.51 rejects omitted ones) is computed ONCE per poll, not
   per page: a walk crossing local midnight would otherwise shift the
   window between pages, drop the oldest day where the not-yet-reached
   events sit, break on the short page, and save the cursor above the
   unfetched events — permanent silent loss. Fetch `events repo <repo>
--type comments --per-page 100 --format json`, paging (ascending page
   number = older events) until an event with `id ≤ cursor[repo]` appears
   or a page is partial/empty. Events are de-duplicated by id during
   collection: offset pagination over a newest-first list can repeat a
   boundary event when a comment lands between two page fetches and
   shifts every offset, and one comment must never dispatch twice in one
   poll. The walk pages to the tail whenever the backlog is deeper than
   one page (a1 caps `--page` at 100), so the slice never crosses an
   unfetched gap WITHIN the window. The invariant is window-scoped: when
   the cursor event itself has aged out of the 3-day window (downtime or
   a drain slower than arrival), the walk ends without meeting it and
   the cursor jumps over the aged-out ids — the poll LOGS that jump when
   it resumes with events to dispatch (a dormant repo with an empty
   window skips nothing and does not warn). Each repo's slice dispatches at most the
   oldest 100 events (`DISPATCH_BUDGET`, universal and monotonic — a
   500-event backlog caps at 100 just like a 1200-event one; a poll's
   worst case is repos.length × 100 dispatches); the remainder drains on
   later polls. A full page 100 — beyond the platform's addressable
   window — throws with the cursor untouched (defensive; see Risks).
2. First observation of a repo (no cursor entry): baseline to the max event
   id, dispatch nothing (GitLab first-poll drain precedent). A repo added to
   the config later baselines the same way — no historical backlog dispatch.
   `connect()` prunes cursor keys for repos no longer watched AND saves the
   pruned cursor immediately (before whoami/polling), so a removed-then-
   re-added repo baselines fresh even if a later connect attempt fails.
3. New events (`id > cursor[repo]`) are processed in ASCENDING id order:
   - skip the bot's own comments (`author.username` equals the whoami
     account, lowercased) — loop prevention;
   - skip non-MR notes and events without `mergeRequest.id`;
   - skip bodies that match no trigger prefix;
   - build the envelope: `senderId` = author username (lowercased),
     `senderName` = `user.name` fallback username, `chatId` = repo path,
     `threadId` = `mr:<global id>`, `messageId` = `note.id`,
     `text` = body minus the matched prefix, `isGroup: true`,
     `isMentioned: true` (forced — GitLab pattern; GroupGate still applies),
     `isReplyToBot: false`, `metadata` = rendered template;
   - `handleInbound(envelope)`; on failure, log and post a best-effort error
     comment (GitLab pattern), then continue;
   - advance `cursor[repo]` to the event id and `saveCursor()` AFTER EACH
     dispatched/skipped event. Aone has no server-side "mark read" (unlike
     GitLab todos), so the persisted cursor is the only dedupe state.
     Saving after each event minimizes the crash window; a crash between
     dispatch and save still re-dispatches that one event (at-least-once,
     the same trade-off as GitLab's todo-done ordering).

Cursor shape (zod-validated, GitLab pattern):
`{ baselineAt: string, repos: Record<string, number> }`. `baselineAt` is the
channel creation time (ISO, parseable — an unparseable value fails cursor
validation and re-baselines). It is a dispatch floor: events created before
it never dispatch. Without the floor, a repo whose first poll sees an EMPTY
window baselines to id 0, and the next poll would dispatch the whole 3-day
window as "new" — a historical backlog. The per-repo entry's presence is the
"initialized" state; there is no separate flag. Drift-prone fields fail
LOUD: an event whose `createdAt` does not parse, whose author is missing,
or whose note body is not a string is skipped fail-closed but LOGGED — a
payload rename would otherwise mute the channel silently while the cursor
advances past every event. The bot's own comments and non-MR notes are
legitimate silent skips, not drift.

Downtime longer than the 3-day default window loses events older than the
window — documented limitation, no digest in v1.

### Outbound (`sendThreadMessage`)

`threadId` must match `mr:<digits>`; `sendMessage` without a thread throws
(GitLab pattern). The reply is posted with
`a1 repo mr comment create --repo <chatId> --mr <id> -m <text> --format json`,
write-once (no retry — a retried write could double-post). Text passes
`formatMarkdownAttributedText` (source-label contract). v1 posts a
top-level comment; `--reply-to` threading is a follow-up (its behavior on
inline roots is unverified).

### a1 client (`a1-client.ts`)

Async `execFile` (promisified), 20s timeout, 16 MiB maxBuffer, no env
override (a1 owns its auth config), `--no-update-check` on every call (a
days-long poller must not pick up an update banner mid-run) — the
`serve/server/aone-mrs.ts` transport shape, re-implemented locally because
channel packages cannot import from `packages/cli`. Error contract: ENOENT → actionable "install a1 / a1 auth
login" error; exit-1 stdout and exit-0 bodies are both parsed for
`a1.error/v1` objects; non-JSON output → error. Test seam
`setA1ExecForTest(exec?)` mirrors aone-mrs. No version floor: the events
command's introduction version is unprobed; a missing subcommand surfaces as
an actionable a1 error, and `whoami` at connect validates auth.

### Plugin object

`channelType: 'aone'`, `displayName: 'Aone'`,
`requiredConfigFields: ['repos', 'triggerPrefixes']`,
`defaultSessionScope: 'chat_thread'`, management fields for `repos`,
`triggerPrefixes`, `groupPolicy`, `promptTemplate`, `pollInterval` (kinds
`string-list`/`string-list`/`enum`/`string`/`number`, the number bounded by
`exclusiveMinimum: 0` and `MAX_POLL_INTERVAL_MS`). `groupPolicy` is
declared with default `open` and all four options — the shared injected
field defaults to `disabled`, which would dispatch nothing for an
editor-created channel (GitLab declares it the same way). Connect
validates: repos non-empty, prefixes non-empty, groupPolicy warning,
whoami success. Validation messages are shared between the descriptor and
connect where a rule exists (GitHub `validateRepoFilterConfig` pattern).

## Files affected

- New: `packages/channels/aone/**` (package, manifest, adapter, client,
  trigger, tests), this design pair.
- Edited: root `package.json` + `pnpm-workspace.yaml` (workspace lists),
  `.pnpmfile.mjs` (workspace rewrite set),
  `scripts/tests/unit-vitest-configs.test.ts` (vitest-config registration:
  static import, `configs`, `configModules`, `OFF_POOL_DEFAULT`),
  `pnpm-lock.yaml` (regenerated).
- Untouched: channel registry, `ChannelBase`, every existing adapter, the
  review/serve Aone code paths.

## Risks and constraints

- **a1 exit codes lie** — every read parses the JSON shape; a permission
  error (`SYSTEM_FORBIDDEN_ERROR`) on one repo is logged, not a silent
  skip, and the per-repo isolation keeps the other watched repos polling
  at the configured interval (only a TOTAL failure backs off).
- **Event-window loss** — outages > 3 days lose older events (v1 limit);
  when the cursor itself ages out, the resuming poll logs the jump.
- **Flood bounded in the 100–10 000 band, PER REPO** — each repo's slice
  dispatches at most the oldest 100 events per poll (universal budget,
  monotonic), so a poll's worst case is repos.length × 100 dispatches; a
  deeper backlog walks to the window tail first so the slice never
  crosses an unfetched gap within the window, and the remainder drains
  on later polls. Under a sustained flood heavier than the drain rate,
  events older than the 3-day window still age out — the bounded slice
  keeps the channel live and the loss is the window's, not a silent
  cursor jump. **Above 10 000 in-window events PER REPO** (a full page
  100, ~2.3 repo-wide comments/minute sustained) the walk cannot reach
  the tail: that repo's poll throws with its cursor untouched,
  dispatches NOTHING, and repeats the up-to-100-call walk every round
  until window aging drops its backlog below the ceiling — per repo it
  recovers only by losing events; the round throws (dragging the channel
  onto the backoff cadence) only when EVERY watched repo is in this band,
  since a partial failure resolves at the configured interval. The walk
  and the slice are both per repo, so the a1 fan-out is one events call
  per repo per poll in steady state, rising to repos.length ×
  PLATFORM_MAX_PAGES while backlogs drain. That band is a documented
  limitation, not a protected state; the constants are PAGE_SIZE 100,
  PLATFORM_MAX_PAGES 100, DISPATCH_BUDGET 100, A1_TIMEOUT_MS 20 000.
- **Write-once** — a failed comment create is surfaced, never retried; the
  agent's reply may be lost on a transient write failure (same trade-off as
  the review provider).
- **Shared-host auth** — the channel acts as the a1-login account on the
  host. The access boundary is `groupPolicy` plus the GROUP sender gate
  (`groups[<repo>].senders` / `groups[<repo>].allowedUsers`); top-level
  `allowedUsers` does not apply to this channel's group-shaped traffic.
  The shipped config sample is restrictive (allowlist on both layers).

## Validation plan

- Unit tests (collocated, mock a1 exec seam): trigger match/strip; cursor
  baseline/advance/validation/prune (prune persisted by connect itself);
  dispatch filters (self/non-MR/no-prefix); error-object handling at exit 0
  and 1; outbound argv (numeric-only threadId); envelope fields; pagination
  boundary dedup, cursor-in-full-page-10 break, tail-walk + universal
  bounded oldest slice + drain progress + monotonic budget (500 caps at
  100), platform-window defensive throw pinned at 100 pages, midnight-
  crossing walk keeps one window; per-event cursor save; failure isolation
  (dispatch-error continuation, cross-repo disk persistence, bad-repo-first
  no starvation, partial failure keeps interval cadence, total failure
  rethrows); negative view cache incl. per-poll scope (two-poll retry);
  empty AND whitespace template fallback; createdAt/author/body drift
  diagnostics incl. author TYPE drift (no public error comment);
  permissive-config warning scoped to actually-open AND reachable repos
  (allowlist-dead repos excluded) + all-dead and mixed dead-repo
  diagnostics + case-normalized groups entry; senderName/chatId fallback
  on sibling-field type drift; empty-string author skip; durable
  repo_failed journal record on partial failure (error bounded to 200
  code points, single line — enforced by the journal write path); aged-out
  cursor jump diagnostic (dormant repo silent); descriptor groupPolicy
  default; repo-path lowercasing. Mutation-witnessed: dedup, per-repo
  isolation, overflow walk, cursor-reached break, prune save, whitespace
  fallback, partial-failure cadence, universal budget, platform ceiling,
  per-poll cache clear, permissive warning, drift diagnostics, midnight
  window, aging diagnostic, author type guard, durable failure record,
  warning scope, dead-posture warning, reachability exclusion, mixed
  dead-repo naming, warning repo naming, case-normalized entry,
  senderName fallback, chatId fallback, empty-author guard.
- Live read-only smoke: real `a1 events repo middleware/tddl5` fetch+parse,
  no dispatch, no writes (env-gated).
- Full-loop E2E with a stubbed `a1` on PATH (canned whoami/events; comment
  create records argv): extension linked, `qwen channel start`, one trigger
  event → agent reply recorded by the stub. No Aone writes.
- Baseline dry-run: global `qwen` without the extension rejects type `aone`
  (`Channel type "aone" is not supported`, exit 1).

## Acceptance criteria

- `qwen extensions link packages/channels/aone` + config above → channel
  connects, baselines, and dispatches a prefix-triggered comment to the
  agent; the reply lands as one MR comment (stub-verified argv).
- Bot's own comments, non-MR notes, and non-prefix comments never dispatch.
- Restart resumes from the persisted cursor without re-dispatch.
- a1 error objects (exit 0 or 1) surface as poll errors: a single-repo
  watch list backs off; a multi-repo list logs a durable repo_failed
  record and keeps the configured interval unless EVERY repo fails. A
  missing a1 binary fails connect with an actionable message.
- Build, typecheck, and the package's unit tests pass; the workspace-mirror
  meta-test stays green.

## Open questions

- @mention syntax (`@account` vs `@花名`): needs one live write probe or Web
  UI observation; follow-up issue material.
- `--reply-to` behavior on inline comment roots: unverified; follow-up.
- Aone comment size limit (chunking): unknown; v1 posts one comment.
- Rate limits of the a1 backend under multi-repo polling: unquantified;
  the default 60s interval keeps steady-state fan-out at one events call
  per repo per poll, rising to repos.length × PLATFORM_MAX_PAGES calls
  per poll while backlogs drain (the walk is per page, not per repo).
