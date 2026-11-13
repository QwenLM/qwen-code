# Daemon PR watch: configuration and channel migration (PR B)

[English](2026-11-14-daemon-pr-watch-config-migration.md) | [简体中文](2026-11-14-daemon-pr-watch-config-migration.zh-CN.md)

Status: proposed. This is the increment the master design
([PR state transitions](2026-11-04-daemon-pr-state-transitions.md), §6 and §7)
calls **PR B**. Every code citation below was read at `bbdca16b52`
(`origin/main`), the commit this branch starts from.

PR A is complete: nine PRs are merged (#16577, #16590, #16611, #16656, #16732,
#16810, #16834, #16847, #17032). The daemon owns the watch store, observation,
drain, shared admission and restore, and deps provisioning. The internal switch
`SESSION_PR_WATCH_OBSERVATION_ENABLED` is still `false`
(`packages/cli/src/serve/server/session-pr-refresh.ts:82`), so production
behaviour is unchanged and the GitHub channel adapter still does all the
watching.

## Problem

An operator cannot configure the daemon's PR watch, and the daemon's watch never
runs. Two pollers would observe the same PRs if the switch were simply flipped,
so the setting, the migration and the enablement have to land together: the
master design forbids any build in which both pollers deliver.

Three claims in the master design's §7 do not survive reading the adapter, and
one cost in §6 is unmeasured. This increment corrects them before implementing;
each correction is cited under **Current state**.

The channel's delivery also lags the PR lifecycle by days in practice. While
this design was being written, one bound session received fifteen events for two
PRs merged three and four days earlier — head changes, a CI failure, a merge
notice, a stale `blocked` verification report whose blocking finding had already
been fixed, and several echoes of the author's own replies. A retirement that
only renames a file would neither count nor explain that backlog.

## Current state

**The adapter's pass is a shared carrier, not a state-watch-only function.**
`runPrStateWatch` (`packages/channels/github/src/GithubAdapter.ts:7782`) runs
when `prWatchEvents` is non-empty **or** comment watching is active, and comment
watching is default-on with `deliverToBoundSessions` (`:7786-7792`, gate at
`:3102-3106`). The budget gate's own comment says "The gate covers the comment
fetches too: they run inside the same pass and spend the same budget"
(`:3115-3117`). Deleting the pass would delete comment delivery.

**The state file is shared too.** `PrWatchEntry` carries the comment cursors
`commentBaseline`, `commentSince` and `commentLastFetchAt` (`:766-773`) beside
the watch baseline. `commentBaseline` is documented as "the first-observation
cutoff (no backlog delivery)". Renaming the whole file to `.retired`, as §7
proposes, discards that cutoff and lets the comment watch re-baseline.

**`title` has one writer and a different reader.** The field is documented "so
comment-watch prompts can render %title%" (`:717-718`), written only by the state
watch (`:8176-8180`), and read by the comment delivery path (`:8512`). Removing
the state watch therefore changes comment prompts, which §7 calls unchanged. The
user page already documents the empty case for comment-only channels
(`docs/users/features/channels/github.md:562-564`).

**There is no field-level deprecation mechanism.**
`ChannelConfigFieldDescriptorBase` has only `key`, `label`, `options`, `default`
and `description` (`packages/channels/base/src/types.ts:593-599`). §7's "the Web
Shell descriptor marks them deprecated" has no precedent to copy; the nearest
existing forms are a type-level `@deprecated` JSDoc (`types.ts:64`, `:86`) and
description text.

**The cap is three mechanisms, not one.** `prWatchLimit` defaults to 30 and
accepts up to 500 (`GithubAdapter.ts:575-578`, getter `:7745`), terminal PRs get
an extra 20% slice (`:7947-7960`), and a budget reserve gates the pass
(`:588-591`, `:5817`).

**Transitions have two producers.** `detectPrTransitions`
(`packages/cli/src/serve/server/pr-watch-observation.ts:95`) is called by the
view path (`:451`) and by the listing write
(`packages/cli/src/serve/server/session-pr-refresh.ts:283-305`). The listing
producer was added by #16847 precisely because the write suppresses the view
that would otherwise detect the closure.

**The drain's two configuration seams are dead switches.**
`PrWatchDrainDeps` declares `actions` and `wakeDormant`
(`packages/cli/src/serve/server/pr-watch-drain.ts:87-88`) and reads them
(`:700`, `:795`), but `createPrWatchDeps` sets neither
(`packages/cli/src/serve/server/pr-watch-deps.ts:210`). No caller in the
repository sets them.

**A startup snapshot cannot see the hosted channels.**
`channelWorkspaceGroups` is declared `undefined`
(`packages/cli/src/serve/run-qwen-serve.ts:4984`) and assigned only when a worker
commits its selection (`:10444`) or at listen (`:11118`), both after the refresh
timer is created (`:7821`). The existing deps therefore re-read on every call and
rebuild when a signature changes (`:7659-7684`); the comment there says building
once "would freeze the allowed set before the channels commit at listen". That
signature covers only the base-URL list.

**The fast-path summary is a structural whitelist.**
`ServeFastPathSettings` declares
`serve?: { channels?: unknown; tokenQr?: unknown; maxSessions?: unknown }`
(`packages/cli/src/serve/fast-path-settings.ts:56`) and the picker copies only
those keys (`:697-721`). A new `serve` sub-key added to the schema alone is
invisible to `bootSettings`. The full boot settings are loaded separately
(`run-qwen-serve.ts:5459-5470`) and are available before the timer is created.

**No `serve.*` setting has an environment override today.** The nearest
boot-time precedent is `advanced.runtimeOutputDir` (schema
`packages/cli/src/config/settingsSchema.ts:3840-3850`, read at
`run-qwen-serve.ts:5530-5545`).

**The three action validation rules already exist.**
`validateBoundActionEntries`
(`packages/channels/base/src/bound-session-prompt.ts:137-166`) rejects an unknown
key, an empty template and one over `BOUND_ACTION_TEMPLATE_MAX_CODE_POINTS`
(2,000, `:23`), with the vocabulary as a parameter. `boundActionTemplateEntries`
(`:118`) is separate so a producer can apply its own precondition.

**Three scans per workspace per tick, none of them today.**
`scanWorkspaceBindings` is called by the observation
(`pr-watch-observation.ts:544`), the listing write
(`session-pr-refresh.ts:553`) and the drain (`pr-watch-deps.ts:215` via
`pr-watch-drain.ts:560`). With the switch off none of the three runs: the listing
branch is gated by the watch seam, which is only assigned inside the enabled
block.

**Two host notions coexist.** `allowedHosts` and the watch identity use a bare
hostname with no port, deliberately (`pr-watch-deps.ts:141-150`), while the
push-ledger coordinate uses `host` with the port and `www.` stripped
(`pr-watch-deps.ts`, `readPushedHeads`).

## Goals

1. An operator can set `sessionPrWatch` and its two environment overrides, and
   the daemon's watch runs exactly when the effective event set is non-empty.
2. `actions` and `wakeDormant` reach the drain, so role-aware delivery and
   dormant retention become configurable rather than dead switches.
3. An operator who configured the channel's `prWatchEvents` keeps receiving
   transitions after the upgrade, per host, for one minor release.
4. The adapter stops detecting and delivering PR-state transitions, and no build
   runs both pollers.
5. Comment delivery keeps working, keeps its cursors, and its one user-visible
   change is named rather than implied away.

## Non-goals

- Turning the watch on by default. The master design's decision 7 leaves that a
  later product decision; this increment keeps the default off.
- Changing the CI predicate, the transition rules, the drain's locking, the
  restore concurrency or the delivery envelope. PR A settled those.
- A `review_decision` transition, Aone parity, or a manual-push ledger (master
  design open questions 3, 4 and 5).
- Rewriting the comment lane, its budget hooks or its ETag cache.

## Proposed changes

### 1. The `sessionPrWatch` setting

A `serve.sessionPrWatch` object in the settings schema
(`packages/cli/src/config/settingsSchema.ts`, `serve` section at `:335-401`):
`events` (array of the four transition types), `wakeDormant` (boolean, default
true) and `actions` (a string map, settings-only). Default: no events.

Both `ServeFastPathSettings.serve` and its picker gain the key, so the fast path
and the full boot agree. The daemon reads the full boot settings, which are
already merged before the timer is created.

`QWEN_SESSION_PR_WATCH_EVENTS` and `QWEN_SESSION_PR_WATCH_WAKE_DORMANT` override
the settings at boot, following `advanced.runtimeOutputDir`'s env-first shape.
They are read through the injected environment record, not a new
`process.env` access, so the per-file access multiset in
`packages/cli/src/serve/process-env-guard.test.ts` stays unchanged; if a direct
access proves necessary, its allowance entry is updated with a reason in the
same change.

An invalid `events` value falls back to the default with a warning, matching
`maxSessionsFromSettings` (`run-qwen-serve.ts:1901-1918`). An invalid `actions`
map refuses the boot, matching `validatePolicyConfig` (`:715-756`): a template
typo that silently disables delivery is worse than a loud failure, and the
channel already throws for the same three rules.

### 2. Enablement derived from the effective event set

The constant becomes `true` and the gate becomes "the effective event set is
non-empty", resolved per tick from the same source for both the periodic tick
(`session-pr-refresh.ts:812`) and the on-demand drain (`:981`). The test seam
`observationEnabled` stays. Deriving the two entry points from one resolver is
the point: #17032's last Critical was exactly two entry points disagreeing.

### 3. One event filter, inside the detector

`detectPrTransitions` gains the effective event set and drops transitions whose
type is not in it. Filtering at the two call sites instead would add a second
drift axis to a duplication whose residual drift risk is already on record
(#16847's review thread on the listing ladder, which declined extraction because
the view writes a whole state and the listing a partial one).

`ciFired` bookkeeping is **not** filtered: an unsubscribed `ci_failure` still
records its head, so subscribing later does not fire retroactively for a head
that was already failing. This matches the existing rule that a first
observation initialises silently.

### 4. `actions` and `wakeDormant` reach the drain

`createPrWatchDeps` passes both through from the resolved configuration. The
vocabulary is the four transition types; the channel's `watch:` prefix is
stripped when an alias contributes keys (§5). No new validation code: the
existing `validateBoundActionEntries` is called with that vocabulary.

### 5. The per-host alias

When `sessionPrWatch` is unset, each hosted GitHub channel contributes its
`prWatchEvents` and its `watch:*` actions for PRs on its web host, with the trust
gating `resolveChannelWorkspaceGroups` already applies. Two channels on one host
take the union of events; each type takes its actions from the first channel by
name that subscribes it and can deliver it, with a logged conflict. A channel
with a non-empty `boundSessionActions` stays role-aware under the alias even
when none of its keys applies to state events.

The alias rides the existing re-read and signature-rebuild mechanism, and the
signature is **extended** to cover `prWatchEvents`, `boundSessionActions` and
`deliverToBoundSessions` as well as the base URL. Without that extension an
operator editing those keys while the daemon runs would never be picked up —
the same freeze the base-URL signature was introduced to avoid.

Hosts are keyed by the watch identity's notion (bare hostname, no port), so the
alias and `allowedHosts` cannot disagree. Two channels on different ports of one
hostname therefore share one entry; that is a consequence of the identity, not a
new rule.

### 6. Splitting the adapter's pass, not deleting it

`runPrStateWatch` keeps its candidate selection, its per-PR state file, its
budget gate and its comment cursors. What goes is the state-transition detection
and delivery: `watchOnePr`'s four detectors, the CI re-check intervals, the
`fired`/`ciFiredSha`/`seq`/`pending` watch fields, the `watch:` task branches,
`prWatchLimit`, the terminal slice and the watch budget reserve. The comment
watch keeps riding the same poll.

`reconcilePendingWatch` and the subscription-disabled parking exist only for
watch pending; they go with it, after the one-time retirement (§7).

### 7. Retiring persisted state without harming the comment lane

The file is **not** renamed. At the first connect after the upgrade the adapter
counts the undelivered `pending` entries across all entries, logs that count
once, and strips the state-watch fields from each entry while preserving
`commentBaseline`, `commentSince`, `commentLastFetchAt` and `title`. A sentinel
file marks the retirement done, following `migrateLegacyPublicationState`
(`GithubAdapter.ts:6020-6048`), so the count is logged once and a failed
retirement is retried rather than silently skipped.

Persisted `watch:` inbound tasks are retired privately through `retireBoundTask`
(`:5332`), which dead-letters, logs and removes without the comment lane's public
fallback.

`title` keeps its last observed value and is no longer refreshed. Comment
prompts on a channel that had both subscriptions therefore render a stale title,
and one that never had a state subscription renders empty as it does today. This
is a user-visible change and is documented as such (§8); the alternative —
giving the comment path its own PR read — adds an API call per PR to a lane this
increment promises not to make more expensive.

### 8. The deprecation surface

`connect()` accepts `prWatchEvents` and the `watch:*` keys, logs exactly one
warning naming `sessionPrWatch`, and runs no state detection. The validation that
throws today (`normalizePrWatchEvents`, `GithubAdapter.ts:882-914`, reached
through `:982-987` and `:2093-2096`) becomes a warning for these keys only; the
notification-reason keys keep their current validation.

Because the descriptor has no deprecated field, the deprecation is expressed in
the field description and a type-level `@deprecated`, and the Web Shell editor
keeps preserving the keys on save as it does for `senderPolicy`. The user page's
configuration table, state-watch section and role-aware template examples are
rewritten, including the sentence that says the state watch records the title.

### 9. The per-tick scan cost

Enablement turns zero scans per workspace per tick into three. This increment
measures the cost on a realistic session directory before deciding, and records
the decision either way: consolidate the observation and listing scans (they are
in the same tick and the same module) and leave the drain's separate, or keep
three with the measurement as justification. The deferred note that postponed
this work cited "the watch switch off and the drain unprovisioned" as its reason;
this increment removes both premises, so it cannot inherit the deferral.

## Files affected

| Layer        | File                                                                                                                                             | Change                                                         |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------- |
| config       | `packages/cli/src/config/settingsSchema.ts`                                                                                                      | `serve.sessionPrWatch` (`events`, `wakeDormant`, `actions`)    |
| config       | `packages/cli/src/serve/fast-path-settings.ts`                                                                                                   | the summary type and picker gain the key                       |
| daemon       | `packages/cli/src/serve/run-qwen-serve.ts`                                                                                                       | boot read, env overrides, alias resolution, extended signature |
| daemon       | `packages/cli/src/serve/server/session-pr-refresh.ts`                                                                                            | enablement from the effective event set; listing scan decision |
| daemon       | `packages/cli/src/serve/server/pr-watch-observation.ts`                                                                                          | event set into the detector and the tick                       |
| daemon       | `packages/cli/src/serve/server/pr-watch-deps.ts`                                                                                                 | `actions` / `wakeDormant` threaded; alias hosts                |
| channel      | `packages/channels/github/src/GithubAdapter.ts`                                                                                                  | split the pass, retire state and tasks, deprecate keys         |
| channel      | `packages/channels/github/src/index.ts`                                                                                                          | descriptor descriptions and options                            |
| channel-base | `packages/channels/base/src/types.ts`                                                                                                            | `@deprecated` on the two config fields                         |
| web-shell    | `packages/web-shell/client/components/channels/ChannelEditorDialog.tsx`                                                                          | deprecation hints                                              |
| docs         | `docs/users/features/channels/github.md`, `docs/users/configuration/settings.md`, `docs/developers/daemon/17-configuration.md`, both design docs | the move, the setting, the title change                        |
| tests        | collocated `.test.ts` for each changed file                                                                                                      | see validation                                                 |

## Key design decisions

1. **The setting, the migration and the enablement land together.** The master
   design forbids a build with two delivering pollers, so they cannot be split.
2. **Filter inside the detector, not at its callers.** One rule, one site, on a
   duplication whose drift risk is already recorded.
3. **Strip fields, do not rename the file.** The comment cursors live in it.
4. **Accept a stale `%title%` rather than add an API call.** The empty case is
   already documented for comment-only channels; this extends it, and says so.
5. **Extend the rebuild signature.** An alias frozen at startup would be a dead
   switch for every operator who edits a channel while the daemon runs.
6. **Reuse the existing action validator.** The three rules and the vocabulary
   parameter are already in `channel-base`.
7. **`actions` refuses the boot; `events` warns and falls back.** A bad template
   silently disables delivery; a bad event list only narrows it.
8. **Keep core's CI predicate, with the trade-off named.**
   `FAILING_CHECK_RUN_CONCLUSIONS`
   (`packages/core/src/utils/github-prs.ts:187-194`) counts `CANCELLED` and
   `STALE` as failing because each leaves the head without a passing result. The
   channel deliberately excluded them and its reason is substantive: "a
   superseded run's cancellation is not a CI failure of this head"
   (`GithubAdapter.ts:9178-9189`). This repository cancels superseded runs
   routinely, so core's predicate will fire `ci_failure` on some of them.
   Keeping one definition is what PR A already shipped, and excluding them
   would require enumerating rollup contexts instead of reading `rollup.state`.
   The recurring noise is accepted explicitly under **Decisions and open
   questions** below.

## Constraints and risks

- **Latency rises for migrating operators**, from the channel's 60-second poll
  to the refresh interval (5 minutes by default). On the machine this design was
  written on, the primary workspace's channel subscribes all four events with no
  `boundSessionActions`, so after the upgrade it is a single-winner watch at the
  refresh interval. The master design's §6 lists what makes latency longer still.
- **A transition the channel had not delivered is not delivered.** The backlog
  observed while writing this design is the concrete case. The retirement counts
  it; it does not replay it.
- **`%title%` goes stale** on channels that had both subscriptions (§7).
- **The alias uses the daemon's `gh`, not the channel's token.** A PR the channel
  could read but the daemon's `gh` cannot gets nothing, with a warning after two
  consecutive failed views.
- **Scan cost** is unresolved until measured (§9).
- **The adapter keeps a per-PR pass and file.** Operators reading "the watch
  moved to the daemon" should not expect the channel's per-PR reads to disappear;
  only the state-detection reads do.

## Validation plan

- Unit tests beside each changed file: the setting's defaults and both env
  overrides; the fast-path picker carrying the key; enablement agreeing across
  both entry points; the detector's filter for each of the four types, with
  `ciFired` bookkeeping pinned separately; `actions` and `wakeDormant` reaching
  the drain; the alias's union, conflict, role-aware retention and trust gating;
  the extended signature rebuilding on an action-only edit.
- Adapter tests: the pass still runs with an empty `prWatchEvents` and comment
  watching on; the retirement preserves the three comment cursors and `title`,
  strips the watch fields, logs the count once and is idempotent across a
  restart; `watch:` tasks retire privately; the deprecation warning fires once.
- Mutation witnesses per guard, not per commit: each new rule mutated at its own
  site, including both transition producers and both enablement entry points.
- Real-environment verification against a local daemon with a stubbed `gh` on
  the workspace `PATH`: a bound session receives a transition through the daemon
  at the refresh interval, the channel delivers no state event, comment delivery
  still works with its cursors intact, and an alias-only operator keeps receiving
  events after the upgrade.
- `npm run build`, `npm run typecheck`, `npm run bundle`, the settings-schema
  freshness gate, and the serve fast-path bundle gate.

## Acceptance criteria

1. With no setting and no alias, the daemon runs no view, writes no watch file
   and claims no ownership; the adapter's state detection is gone.
2. With `events` set, a bound session receives each subscribed transition once,
   and an unsubscribed type is never recorded or delivered by **either**
   producer.
3. `actions` produces role-aware delivery; `wakeDormant: false` retains a dormant
   recipient's entry until its next live turn.
4. An alias-only operator keeps receiving transitions for PRs on its channel's
   host, and none for other hosts; an explicit setting wins.
5. Editing a hosted channel's `prWatchEvents` or `boundSessionActions` while the
   daemon runs takes effect without a restart.
6. After the upgrade the comment cursors and `title` survive, the retirement
   count is logged exactly once, and no `watch:` task remains.
7. No build delivers a state transition from both the adapter and the daemon.

## Decisions and open questions

Decided by the maintainer on 2026-11-14:

1. **Default off.** Per the master design's decision 7. The alias already
   preserves every configured operator, so turning it on by default would only
   add watchers nobody asked for.
2. **Keep core's CI predicate**, `cancelled` and `stale` included (decision 8).
   The channel's opposing rationale is quoted there and is not dismissed: this
   repository cancels superseded runs routinely, so the accepted cost is
   recurring noise rather than a rare edge. Excluding them would mean
   enumerating rollup contexts and changing a predicate PR A settled.
3. **Accept a stale `%title%`, documented.** The alternative adds an API call
   per PR to a lane this increment promises not to make more expensive. The
   empty case is already documented for comment-only channels; §7 extends it,
   and the user page is rewritten to say the title is no longer refreshed.

Still open:

1. **Scans: consolidate two, or keep three with a measurement?** To be decided
   with the measurement (§9), not before it.
