# Managed channel third adapter: GitHub (H5f)

[English](2026-11-16-managed-channel-github-adapter.md) | [简体中文](2026-11-16-managed-channel-github-adapter.zh-CN.md)

Status: proposed. This is the third-adapter slice of stage **H5** of
[#12827](https://github.com/QwenLM/qwen-code/issues/12827), following the email
reference slice (H5b/H5c) and the DingTalk second adapter (H5d,
[design](2026-11-13-managed-channel-dingtalk-adapter.md)). The original
[managed-channels design](2026-10-04-managed-channels.md) explicitly deferred
GitHub to "a later adapter slice"; this is that slice. Product scope for the
first version was decided by the product owner on 2026-11-16: **@mention
comments only, no PR watch, token-only authentication**.

## Problem

The managed channel path serves email and DingTalk. GitHub conversations
(issue and PR comment threads) are a primary surface for coding agents, but
today the GitHub channel only runs on the Legacy daemon path
(`packages/channels/github/src/GithubAdapter.ts`), where the adapter owns
session routing, task execution and publication audit. A Managed Agent
deployment cannot admit GitHub mentions into control-plane Sessions or deliver
receipted replies back to the thread.

## Current state (what is already generic)

Verified on the current tree; the control plane is provider-agnostic, so this
is a TypeScript slice with **zero Java change**:

- The Java `ChannelPolicy.adapter` is validated by the pattern
  `[a-z][a-z0-9-]{0,63}` and `RegisterChannelRequest.platform` is a bounded
  string (`ChannelAdapterModels.java`); neither enumerates providers. The
  `ma_channel_instance.platform` column has no CHECK constraint. The reply
  context is adapter-opaque JSON: Java only passes it through
  (`ManagedChannelService` inbound forwarding and claim echo); the only parser
  is the adapter itself.
- Enablement lives in the TypeScript core:
  `MANAGED_SESSION_ENABLED_CHANNEL_ADAPTERS`
  (`packages/core/src/managed-runtime/managed-session-records.ts`), enforced by
  the authority on **every** `channel_route` revision.
- The shared adapter contract (`ManagedChannelPolicy`,
  `ManagedChannelControlPlane`, `ManagedInboundEvent`, `ManagedClaimedDelivery`,
  `ManagedReceipt`, `MANAGED_OUTBOUND_LIMIT`, `validManagedReceipt`) lives in
  `packages/channels/base/src/managed-channel.ts`; the union is
  `'email' | 'dingtalk'`.
- The CLI command shell is shared: `createManagedChannelCommand`
  (`packages/cli/src/commands/channel/managed-channel-command.ts`) holds the
  argument surface, the `HttpManagedChannelControlPlane` wiring and the
  connect → wait-for-signal → disconnect lifecycle; each provider supplies an
  adapter factory. The HTTP client is provider-agnostic.
- The multi-segment producer plans segments at 48 KiB **UTF-8 bytes** each,
  1–64 segments (`planChannelSegments`,
  `packages/core/src/managed-runtime/managed-channel-operations.ts`). A 48 KiB
  UTF-8 segment is at most 49,152 characters, below GitHub's 65,536-character
  comment body cap — so one ledger segment maps to one GitHub comment with no
  provider-side chunking.
- The GitHub package already depends on `@octokit/rest`,
  `@qwen-code/channel-base` and `https-proxy-agent`; the Legacy adapter
  provides the provider mechanics (notifications polling, mention detection,
  `extractFromSubjectUrl`, `issues.createComment`) but is not reused as a class.
- OpenAPI `PublicChannel.platform` is an unenumerated string; the channel
  contract tests pin wire shapes, not platform values; the Web Shell generated
  types exclude the channel routes (`Public Resources` tag). No contract,
  surface-capture or generated-type gate moves.

## Decision

Add a managed GitHub adapter beside the email and DingTalk ones, following the
DingTalk discipline: a deps-injected adapter that never drives a model, persists
every claim before its side effect, and replays on restart instead of re-sending.

### Contract and enablement

- Widen `ManagedChannelAdapter` to `'email' | 'dingtalk' | 'github'` in
  `channel-base`, and the command spec's `adapterType` union to match.
- Add `'github'` to `MANAGED_SESSION_ENABLED_CHANNEL_ADAPTERS`; update the
  pinned-list test. The Java pattern already admits the name.

### Identity, scope and policy

- **Authentication is token-only.** `token` is required (secret config field,
  credential rule mirrors DingTalk: non-blank, no CR/LF/NUL). `useLocalGh` is
  refused on the managed path: the gh CLI login is a machine-level identity
  that does not belong to a tenant-scoped deployment. `baseUrl` stays
  configurable (GitHub Enterprise and hermetic mock endpoints; default
  `https://api.github.com`). It must be an absolute `http(s)` URL with a host
  — a bare `host:port/path` parses as a URL with a bogus scheme and empty
  host, and would silently target nothing — and is normalized to
  `origin + pathname` with trailing slashes stripped, so endpoint spellings
  that differ only in case or a trailing slash key the same state directory.
- **Account identity** is the bot login resolved from `GET /user` at connect;
  `accountGeneration` starts at 1 and has no epoch event (like DingTalk). A
  token swap to a different login surfaces as the control plane's
  `channel_identity_conflict` registration refusal, visibly.
- **Scope** is `chat_thread` with `chatId = owner/repo` (lowercased) and
  `threadId = "issue:N" | "pr:N"`, extracted from the notification subject URL
  exactly as the Legacy adapter does. One repo + issue/PR number is one route,
  hence one Session.
- **Policy** is the flat email-shaped `senderPolicy` (allowlist / open /
  disabled, default allowlist) over GitHub logins (lowercased), with
  `allowedUsers` as the allowlist source and `dispatchMode` from config
  (default `followup`). The resolved policy comes from `resolvePrivatePolicy`
  (`privatePolicy`, else a `disabled` `dmPolicy`, else `senderPolicy`, else
  allowlist). `pairing` is refused explicitly — whether spelled as
  `groupPolicy` or resolved from `privatePolicy` — because the managed shape
  has no pairing arm and coercing it to an empty allowlist would skip every
  comment while reporting running. The Legacy per-repo `groups` map is not
  carried over: a non-empty `groups` object is refused, not silently dropped,
  since dropping it would admit senders the operator excluded (or drop ones
  they allowed).
- **`groupPolicy` is honored, not ignored.** The plugin's own schema documents
  `groupPolicy` as the GitHub admission gate. When the operator did not
  explicitly choose a managed policy (`privatePolicy` / `senderPolicy`) in the
  **raw pre-parse entry**, an active `groupPolicy` (`open` / `allowlist`) maps
  onto `senderPolicy`; any other value except `disabled` is refused. A channel
  configured `groupPolicy: "open"` must not resolve to an empty allowlist and
  silently consume every mention. **The choice is judged on the raw entry, not
  the parse result:** `parseChannelConfig` always injects `privatePolicy` and
  `senderPolicy` into the config the CLI hands the adapter, so a guard keyed on
  their absence in that config would be dead on the production path. The
  command therefore threads the pre-parse entry (`ParsedChannel.rawConfig`)
  into the adapter. **`disabled` stays inert:** absent `groupPolicy` collapses
  to `disabled` in the parse result, and it must keep the managed
  `resolvePrivatePolicy` result rather than clobber an `allowedUsers` allowlist
  into admit-nothing — the natural `allowedUsers`-only config still admits its
  listed senders, and the injected default is not a refusal trigger. An
  explicit raw managed policy still wins over an active `groupPolicy`.
- **`repoFilter` is an explicit allowlist.** An optional `repoFilter`
  (lowercased `owner/repo` entries) filters which repositories may admit
  events at all. Filtering activates only for `repoFilterMode: "allowlist"`
  with a list; that mode without a list is refused (it must not fail open to
  every repo), and a list with no mode is refused (require the explicit
  spelling rather than guess). **`off` starts as no filter:** the plugin
  descriptor defaults `repoFilterMode` to `off` and the Web Shell editor seeds
  `off` on save, so an `off` config — and a `blocklist` with no list — must
  start as "no repository filtering", not be refused; there is no list to
  invert. Only the invertible shape is refused: a `blocklist` **with** a list
  (reading it as an allowlist would answer only in the repos the operator
  blocked). The allowlist must be non-empty and every entry must match the
  Legacy `owner/repo` shape; an empty or malformed list would silently drop
  every event while reporting running. Sender gating runs in the adapter, the
  same layer as email's `senderAllowed`.
- **Poll floor.** The poll interval respects GitHub's `X-Poll-Interval` and
  rate-limit wait hints (`retry-after`, `x-ratelimit-reset`), capped at
  Node's 32-bit timer limit — the Legacy `MAX_TIMER_DELAY_MS` guard. An
  uncapped hint above 2^31-1 ms is clamped by Node to ~1 ms, turning a
  rate-limit cooldown into an immediate retry storm. The two hint families
  are stored as different quantities: `X-Poll-Interval` is a **duration**
  floor, while a rate-limit hint is an **absolute cooldown deadline**
  (`now + wait`). The effective floor is
  `max(pollFloor, deadline - now, 0)`, so a cooldown expires as the clock
  advances. Storing the rate-limit hint as a never-expiring duration would
  let one skewed `x-ratelimit-reset` or bogus `retry-after` pin the tick loop
  for weeks.

### Inbound pipeline (mentions only)

One poll tick:

1. Re-drive any persisted pending events first (crash recovery, below).
2. List notifications (`GET /notifications`, paginated, `since` = cursor
   watermark minus one second; the first poll after a fresh start uses the
   connect time — no historical backlog). Keep only `reason === "mention"`
   notifications whose subject is an Issue or PullRequest and whose repo
   passes `repoFilter`.
3. For each kept thread, list conversation comments
   (`GET /repos/{owner}/{repo}/issues/{n}/comments`) newer than the window.
   Keep comments that mention the bot login (reusing the Legacy `mention.ts`
   detector), are not the bot's own, are not in the dispatched ring, and whose
   author passes the sender policy.
4. Stage the resulting events as pending **before any side effect** (persist).
5. Submit each pending event; on admission or replay, record its comment key
   in the dispatched ring and remove it from pending (persist).
6. Mark a notification thread read only after all its events are submitted
   **and** its comment collection completed. A collection cut short by the
   32-claim cap leaves comments uncollected: the thread stays unread and the
   window holds, so the next poll collects the remainder instead of consuming
   a notification whose mentions were never staged. **Poison escape:** a
   thread whose comment read answers a definitive, unhealable refusal (a 4xx
   other than 401/408/429 and not a rate-limit answer — a deleted or
   inaccessible thread) would answer the same refusal forever and freeze the
   watermark for the life of the channel. It is dropped visibly (its mentions
   are unrecoverable), skipped for mark-read, and does **not** freeze the
   window. Transient read failures (401/408/429, rate limits, 5xx, network)
   still freeze the window, because dropping threads on a shared or retryable
   problem would consume notifications while the real issue is global. 429 is
   excluded by status alone — GitHub or a proxy may send it without
   `retry-after` or budget headers — mirroring the Legacy
   `classifyThreadFailure` "shared" arm.
7. Advance the cursor watermark only after the window's threads are marked
   read (persist). A failed mark-read freezes the window; the next poll
   re-lists it and dedupe absorbs the overlap. The watermark is a single
   shared value for the whole window, so **any** notification with an
   unparseable `updated_at` — even a sibling that was filtered out or dropped
   — holds the entire window: persisting it would throw RangeError on every
   later tick's `since` computation and fail `load()` on restart, while
   outbound keeps moving. A local flag gates the persist; the outer
   completeness check alone is not sufficient.

Event mapping:

- `platformEventId = "github:" + comment.node_id`, falling back to
  `"github:" + chatId + "/" + threadId + "/" + comment.id` when a response
  carries no `node_id`: the numeric id is only unique per repo, so the
  fallback is thread-scoped — two repos' comment #555 stay two events, not
  one replayed away. Stable across redelivery and comment edits. One comment
  is one event; an edit does not re-admit (the Legacy edited-mention journal
  is a daemon surface, out of scope here).
- `senderId = user.login` lowercased; `subject = notification.subject.title`
  clamped to the wire's 200-character bound; `text = comment body` verbatim,
  clamped by the DingTalk-shaped `fitInboundText` (≤ 32,000 UTF-16 units with
  trailing-high-surrogate backoff, plus the 64 KiB JSON-serialized envelope cut
  on code-point boundaries). GitHub bodies reach 65,536 characters, so an
  over-long comment is admitted truncated, never refused whole. The clamp is
  copied from the DingTalk adapter, not email's raw-UTF-8 budget.
- `attachments: []` — GitHub user-attachment staging is a follow-up.
- `replyContext = { owner, repo, issueNumber, senderId }` — adapter-opaque,
  committed with the input and echoed on claim; everything
  `issues.createComment` needs, plus the admitted sender so `send()` can
  re-check the current sender policy before posting.

### Pending claims persist the full event

The load-bearing inbound decision, per the H5d rule: notifications are
**ack-once** — marking a thread read removes it from the unread list, so a
restart cannot re-list it. The comment body could be re-fetched by id, but it
may have been edited or deleted since admission; re-driving must replay the
exact admitted event, not a reconstruction. Pending therefore persists the
full `ManagedInboundEvent` (DingTalk shape), bounded by the 32 in-flight
inbound quota. The state file holds no bearer capability (the token stays in
settings), so the 0600/0700 discipline protects platform data only.

Correctness against duplicate listing does not rest on the dispatched ring:
the control plane's `platformEventId` idempotency replays the same `inputId`
for any re-submission. The ring (bounded, tail-truncated) is a work-saving
filter; the Legacy second-boundary `boundaryComments` machinery is not needed
because a re-listed same-second comment is an idempotent replay, not a second
input.

Re-driving re-checks the **current** policy, not the policy at staging time:
each persisted pending event is tested against both `senderAllowed` and
`repoAllowed` before submission. A claim staged under a wider sender policy or
repo allowlist must not drive a Session — or post into a repo — that the
operator has since excluded. A refused claim drops visibly (recorded in the
dispatched ring so it is not re-staged) rather than replaying stale admission.

### Outbound delivery and receipts

Unchanged discipline from email/DingTalk: claim ≤ 16 deliveries per tick
(512 KiB claim budget, re-claim after receipts), send each delivery's segments
in ordinal order, persist the send outcome before reporting the receipt, stop
the rest of a delivery on any non-accepted segment.

- One segment = one `POST /repos/{owner}/{repo}/issues/{issueNumber}/comments`
  (PRs answer with conversation comments, never inline review comments — the
  Legacy send primitive). No provider-side chunking: the producer's 48 KiB
  byte cap is below GitHub's comment cap.
- **Send-time policy re-check (DingTalk/email parity).** Before posting,
  `send()` re-checks the current `senderAllowed(replyContext.senderId)` and
  `repoAllowed(owner/repo)` alongside the reply-target shape; a sender or repo
  the operator has excluded since admission is receipted `rejected` and not
  posted, and the rest of the claimed batch still sends.
- `providerMessageId = String(comment.id)` — GitHub returns a real platform
  id, a stronger receipt than email's minted Message-ID or DingTalk's UUID.
- Failure classification in the deps: definitive no-write refusals (401/403
  permission, 404, 422 validation) → `rejected`; rate-limit responses, 5xx and
  network ambiguity → `unknown` (the reconciler settles it after the lease;
  explicit resend remains the operator's duplicate-aware path). A
  rate-limited send is provably unwritten but transient, so it follows
  DingTalk's transient→unknown rule rather than terminating the reply.
- Restart: `reportOrphanedOutbound` replays persisted receipts and reports
  `unknown` for entries without one — never a second send.
- The Legacy `<no-reply/>` sentinel and eyes-reaction acknowledgement are not
  carried over: the publication-policy prompt that teaches the sentinel is a
  Legacy adapter injection, and managed Sessions take their instructions from
  the deployment's workspace context.

**Persist-failure discipline (DingTalk parity).** A state-save failure
(ENOSPC/EACCES/read-only directory) must never escape `send()`/`submit()` and
abandon an already-claimed batch. Every persist site is guarded exactly as the
DingTalk reference guards it: the outbound ledger append rolls back and
abandons the delivery _before_ the comment post (the ledger entry is the
double-send guard; the lease reconciler settles it `unknown`); the receipt
write logs but still reports the outcome (the comment is already on GitHub,
the server-side settle is the durable record); the settle removal and the
orphan removal log and leave the entry on disk for the next restart's orphan
re-drive. The inbound admission settle rolls back everything it touched
(pending, dispatched ring, refusal streak, stall flag) and latches its log so
the claim re-drives into the idempotent replayed answer; the held-claim,
refused-drop, policy-drop and sender-skip writes log without aborting the
batch. The store rethrows a fixed sentence (the state file may hold platform
data) but preserves the fs error on `cause`, and `persistErrorText` logs the
cause so the errno is diagnosable.

### State and ownership

- State directory:
  `~/.qwen/channels/<workspace-scope>/github-<sha256(name\0baseUrl)[:16]>/managed-state.json`,
  written 0700/0600 with the atomic temp-file + fsync + rename discipline.
  Credentials never define identity.
- Contents: `version`, `generation`, `instanceRefusals`, the cursor
  (`lastProcessedAt`, dispatched comment ring), `pending` (full events, ≤ 32),
  `outbound` (segment ledger, ≤ 64, receipts validated by the shared
  `validManagedReceipt`). The validator date-parses the watermark: a
  non-date string fails `load()` fail-closed instead of stalling every tick
  with a RangeError while connect reports running (the Legacy cursor
  validator parses the same field).
- The lock arbitrates managed instances of the same name + endpoint. It does
  not cross-lock the Legacy channel: running a Legacy and a managed adapter on
  the same token simultaneously would race notification mark-read and steal
  events; the operator must run exactly one consumer per bot identity.
- Registration-refusal re-register, instance-scoped refusal stall (first
  refusal drops as poison, second consecutive holds the claim as a probe;
  only a fresh admission lifts the stall), ownership-loss write refusal and
  the disconnect-under-lock ordering all mirror the DingTalk adapter.

### Command

A `managed-github` CLI command wires the adapter to
`HttpManagedChannelControlPlane` through `createManagedChannelCommand`,
mirroring `managed-dingtalk` (including the egress-proxy resolution). It is an
experimental, explicitly selected entry: `qwen channel start` never picks it,
and it drives no model.

The egress proxy is **applied**, not just resolved: `@octokit/request` v9 is
fetch-era and never reads the Legacy `request.agent` option (the Legacy
channel works only because its launcher installs a process-wide undici
dispatcher). The deps therefore build a per-client `undici.EnvHttpProxyAgent`
and ride the honoured `request.fetch` hook, destroyed on `disconnect()`. The
proxy is scoped to GitHub traffic; control-plane HTTP stays direct — the
DingTalk deps' decision. A proxy-traversal witness proves the request tunnels
through the proxy (the proxy's CONNECT log names the target authority; a
direct request would leave it empty).

## Files affected

- `packages/channels/base/src/managed-channel.ts` — union widened to three
  providers; collocated contract test updated.
- `packages/core/src/managed-runtime/managed-session-records.ts` — enablement
  list gains `'github'`; `managed-channel-record.test.ts` pin updated.
- `packages/cli/src/commands/channel/managed-channel-command.ts` —
  `adapterType` union widened; command-matrix and required-flag tests gain a
  `managed-github` row.
- `packages/cli/src/commands/channel/managed-github.ts` (new) and
  `packages/cli/src/commands/channel.ts` — the command and its registration.
- `packages/channels/github/src/managed-github-adapter.ts`,
  `managed-github-deps.ts`, `managed-state.ts` (new) — the adapter, its
  production deps (Octokit assembly, proxy, retry/backoff, failure
  classification) and its persisted state. The adapter and deps are exported
  from the package index; `managed-state.ts` is internal to the adapter (not
  re-exported). Collocated tests for each.
- `packages/cli/src/commands/channel/runtime.ts` — `ParsedChannel` carries the
  pre-parse `rawConfig` so the adapter can tell an operator's explicit policy
  choice from the defaults `parseChannelConfig` injects; `managed-github.ts`
  threads it into the adapter.
- This design doc and its Chinese version.
- No Java, schema, OpenAPI, surface-capture or Web Shell generated-type change.

## Scope boundaries

- No change to the segment ledger, claim budget, receipt write-once rule,
  partial/unknown recovery, or the ingress idempotency identity.
- No PR watch events (CI failure, merge conflict, head/state change), no
  bound-session delivery, no pairing, no per-repo sender lists, no attachment
  staging, no inline review comment replies, no issue-body-only mentions
  (a mention in an issue body with no comment admits nothing), no historical
  backlog on first start, no `<no-reply/>` sentinel, no reaction
  acknowledgement. Each is a named follow-up, not a silent gap.
- The Legacy `GithubChannel` is unchanged; the managed adapter reuses provider
  mechanics (mention detection, subject-URL extraction), not the Legacy class.
- No Java control-plane change; any provider-specific need discovered during
  implementation is called out before it is added.

## Validation plan

- Contract witnesses: the widened union accepts `github` and still accepts
  `email`/`dingtalk`; enablement admits `github` and still refuses an unknown
  adapter; the email and DingTalk suites stay green unchanged.
- Adapter witnesses (deps-injected, no live GitHub): a mention comment is
  admitted once and a re-listed notification replays; over-long text is
  truncated to the wire bound rather than dropped; non-mention reasons,
  own comments, filtered repos and refused senders admit nothing; a
  multi-segment claim posts each segment in order and receipts each by ordinal
  with the real comment id; a definitive refusal receipts `rejected` and stops
  the rest; an ambiguous failure receipts `unknown`, never a second send; a
  persisted receipt replays on restart; pending events re-drive after a crash
  between stage and submit; mark-read happens only after admission and the
  watermark freezes on mark-read failure; a thread whose comment collection
  the claim cap cut short is never marked read even when its staged claims
  all settle in the same tick; the instance-scoped stall, the
  registration-refusal re-register and the ownership-loss refusal each red
  their case. Round-3 hardening witnesses: an active `groupPolicy`
  (open/allowlist) maps onto the sender policy while the parse-default
  `disabled` stays inert and still admits an `allowedUsers` allowlist (and
  `pairing` / non-empty `groups` are refused);
  both `repoFilter` quadrants (mode-without-list, list-without-mode) are
  refused; a non-absolute or non-`http(s)` `baseUrl` is refused and endpoint
  spellings normalize; a definitively unreadable thread is dropped without
  freezing the window while a transient read failure still freezes it; an
  unparseable `updated_at` on any window sibling holds the shared watermark;
  a re-driven claim is dropped when the narrowed repo allowlist now excludes
  its repo; each ledger is accepted at its exact cap; and the real-timer tick
  loop honors a poll floor above the configured interval. Persist-failure
  witnesses (a spy that fails the Nth `store.save`, fs error on `cause`): a
  failed outbound ledger write posts nothing and still sends the batch's next
  delivery; a failed receipt write still reports `accepted`; a failed settle
  removal keeps the entry on disk for the restart's orphan re-drive; and a
  failed admission settle rolls back so the claim re-drives instead of being
  dropped from the process.
- Deps witnesses against a local fake GitHub HTTP endpoint (real Octokit):
  pagination, `since` window, failure classification (401/404/422 definitive,
  rate-limit/5xx/network ambiguous), proxy traversal (the CONNECT tunnel goes
  through the proxy) and dispatcher teardown on disconnect; a rate-limit
  cooldown expires as the clock advances while the `X-Poll-Interval` duration
  floor is clock-independent.
- The real-control-plane leg (register → inbound → Session turn → claim →
  receipt against a running Java server) and a GitHub fault-gate driver
  variant are follow-ups, not merge gates, mirroring the DingTalk slice's
  live-tenant smoke posture.

## Decisions (proposed)

1. Token-only auth; `useLocalGh` refused on the managed path.
2. Mentions only (`reason === "mention"`), conversation comments only; issue
   body mentions and inline review comments are follow-ups.
3. Pending persists the full inbound event (ack-once mark-read), DingTalk
   shape; the dispatched ring is an optimization over control-plane
   idempotency, not the correctness boundary.
4. One segment = one comment; `providerMessageId` is the real comment id;
   rate-limit is transient (`unknown`), not terminal.
5. Flat sender policy plus an optional repo allowlist (non-empty, Legacy
   `owner/repo` shape; the allowlist mode must be stated explicitly in both
   directions, and `blocklist`/`off` configs are refused, not reinterpreted).
   An active `groupPolicy` (open/allowlist) is honored when no managed policy
   spelling is present, while the parse-default `disabled` stays inert;
   `pairing` and non-empty per-repo `groups` are refused. No sentinel or
   reaction surfaces in v1.
6. The poll floor splits a duration (`X-Poll-Interval`) from an absolute
   rate-limit cooldown deadline, so a skewed hint cannot pin the loop; a
   definitively unreadable thread escapes the window instead of freezing it
   forever, and any unparseable window sibling holds the shared watermark.
