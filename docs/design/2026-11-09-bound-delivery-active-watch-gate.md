# Bound Delivery Active-Watch Gate

[English](2026-11-09-bound-delivery-active-watch-gate.md) | [简体中文](2026-11-09-bound-delivery-active-watch-gate.zh-CN.md)

Status: proposed (2026-11-09)

## Problem statement

With the GitHub channel's `deliverToBoundSessions` enabled, every daemon
session bound to a PR receives that PR's events: notification comments,
`prWatchEvents` state transitions, and (where configured) role-aware fan-out.
Bindings are minted automatically by the backfill for any session that ran
`/review <n>` or `/verify-pr <n>` — one-shot commands whose sessions are not
watching the PR afterwards. Those sessions keep receiving events they never
asked for: a verification session that finished its round is woken by every
later comment and CI transition, and in legacy mode (no `boundSessionActions`)
it receives fix-style guidance it must not act on.

The operator's intent: a `/review` or `/verify-pr` session should receive
bound events only while it has an **active watch** on that PR — an
`/autofix-pr` watch or a `/verify-pr <n> --watch` standing trigger it installed
itself. Sessions without a watch stay bound (the badge and the binding remain)
but are not delivery targets.

## Current state

- Bindings live in the `<chatsDir>/<sessionId>.pr.json` sidecar
  (`packages/core/src/services/session-pr-service.ts`): entries carry
  `number`, `url`, `state?`, `role?` (`review` | `verify` | `fix`), `source?`.
  There is no watch marker. The backfill
  (`packages/cli/src/serve/routes/session-pr-backfill.ts`) mints role `review`
  for `/review` and `verify` for `/verify-pr`; an explicit metadata-route role
  outranks the backfill.
- `GET /sessions/pr-bindings`
  (`packages/cli/src/serve/routes/session-pr-bindings.ts`) scans the sidecars
  of every trusted/primary workspace and returns `PrBindingSummary` rows; the
  channel worker (`packages/cli/src/commands/channel/daemon-worker.ts`,
  `listPrBindings`) validates and forwards them to the adapter.
- The adapter (`packages/channels/github/src/GithubAdapter.ts`) picks targets
  in two modes: legacy single-winner (routing map `boundSessionByPr`, most
  recently updated follower per PR) and role-aware fan-out
  (`boundSessionActions` configured; one winner per role group whose template
  chain matches). `resolveBoundTargets` returns `followed` to distinguish
  "nobody follows this PR" (public absence gate) from "followers exist but no
  role matched" (private retire, `no_role_matched`).
- Session-level watches exist as two artifacts, neither exposed to the
  channel today:
  - `/autofix-pr` watch: state file `.qwen/tmp/autofix-pr-<n>-state.json` in
    the preparing worktree, owning `sessionId`, `host`, `owner/repo`,
    `prNumber`, plus the `ended` terminal marker; the `stopped`
    (merged/closed) marker lives in the separate gate cursor file. The
    daemon already lists both synthesized file-only via
    `listAutofixPrWatches(cwd)`
    (`packages/cli/src/serve/routes/autofix-pr-watches.ts`, built on
    `runStatus`).
  - `/verify-pr <n> --watch`: a durable recurring scheduled task bound to the
    session (`sessionMode: "current"`), whose gate runs
    `scripts/verify-pr-watch-gate.mjs <n> --repo <owner>/<repo> --cli <qwen>`.
    The gate claim file records no session id, so the task is the only
    session-attributed artifact. Tasks live in the per-project durable cron
    file read by core's `readCronTasks(projectRoot)`.

## Goals

- A new opt-in channel option gates bound delivery for role `review` and
  `verify` bindings on an active watch of the SAME PR by the SAME session.
- Events left without an eligible target retire privately — never fall back
  to the public channel path (operator decision, 2026-11-09).
- No new persisted state: the watch signal is derived at scan time from the
  artifacts the watch flows already write.

## Non-goals / scope boundaries

- Roles `fix` and untyped bindings are unaffected.
- The sidecar schema does not change; no watch toggle UI is added.
- The PR-state watch polling set is unchanged: ineligible bindings are still
  polled (they keep baselines and terminal observation), and their events
  retire at drain through the existing no-candidate paths. Skipping their
  `pulls.get` is a possible follow-up optimization, not part of this change.
- This branch has no comment-watch (`prCommentWatch`) feature; the design
  targets the notification/comment lanes and the PR-state watch as they exist
  here.
- Detection is best-effort and fail-open (decision D3): it is a noise gate,
  not a security boundary.

## Proposed changes

### 1. Watch detection (daemon, `packages/cli/src/serve`)

New helper `routes/session-pr-watches.ts` (collocated tests):

`collectActivePrWatches(workspaceCwd): Promise<Map<string, Set<string>>>` —
keyed `sessionId` → set of PR keys, the union of:

1. **autofix-pr watches** — `listAutofixPrWatches(workspaceCwd)`; keep entries
   with non-empty `session`, `stopped === null`, `ended === null`. This covers
   in-place watches and watches whose task lives in a session-only scheduler,
   and honors takeover (the state file's `sessionId` is authoritative).
2. **verify-pr watches** — `readCronTasks(workspaceCwd)`; keep tasks with
   `enabled !== false`, `recurring === true`, non-empty `sessionId`, and a
   `gate` that names `verify-pr-watch-gate.mjs`. The gate parse MIRRORS the
   script's own `parseArgs`: `--repo`/`--cli`/`--state-root` consume the
   following token, the first non-flag positional is the PR number, and a
   gate carrying `--check`/`--claim`/`--release` is a one-shot probe
   invocation, never a standing watch. Token-based (whitespace split, edge
   quotes stripped) because the gate is model-authored; a gate missing the
   number or the repo contributes nothing.

Key derivation: both sources key a watch by `prWatchKey(url, number)` =
`repoKeyFromWebUrl(url)#number` — the SAME function the bindings route
applies to the binding URL, so host spellings (non-default port, leading
`www`, case) normalize identically on both sides. The autofix source uses
the watch's own `url`; the verify-pr source builds
`https://github.com/<repo>/pull/<number>` (the gate script takes no host).

Failure semantics: the helper returns `undefined` (detection unavailable)
when either source throws, AND on the listing's non-throwing failure shapes:
`available: false` (the clone's worktrees could not be enumerated — git
failure or not a repository) and a non-empty `unreadable` (individual state
files failed to read). A partial listing must never stamp `watching: false`
on an active watch. The route logs one line per workspace scan — the same
shape as the existing bindings-scan diagnostics.

### 2. Bindings route (`session-pr-bindings.ts`)

After a workspace's rows are built (sidecar rows and live-merge rows alike),
call the helper once per workspace. For every PR entry, look up
`prWatchKey(entry.url, entry.number)` in the session's watch set and set
`watching: true/false` (an unparseable URL leaves the field absent). When
the helper returns `undefined`, leave `watching` absent on that workspace's
entries (unknown). `watching` is computed for every entry, not only
review/verify ones — the adapter owns the policy.

The route's `partial` semantics are unchanged: a watch-detection failure does
not make the snapshot partial (it degrades only the new field, fail-open).

### 3. Wire types and worker validation

- `packages/channels/base/src/types.ts`: `PrBindingEntry.watching?: boolean`
  with a doc comment (absent = unknown; the adapter must treat unknown as
  eligible).
- `daemon-worker.ts` `listPrBindings`: accept `watching` only when strictly
  boolean; any other value drops the field (not the entry) — an unknown value
  is "unknown", and dropping the entry would fabricate absence. Existing
  drop+partial rules for malformed core fields are unchanged.

### 4. Channel option (`packages/channels/github`)

`requireBoundWatch?: boolean`, default `false`, validated by
`validateBoundSessionConfig`: must be boolean; requires
`deliverToBoundSessions: true` (same pattern as `prWatchEvents`). Descriptor
entry in `src/index.ts` (boolean, default `'false'`), Web Shell i18n labels
(en + zh) and editor field order. The adapter parses it next to
`deliverToBoundSessions` into the `requireBoundWatch` field (reset to false
in standalone mode alongside `deliverToBoundSessions`); the eligibility
predicate `watchGateExcludes` reads it, so the gate is active only when both
are true and existing deployments are untouched.

### 5. Adapter filtering (`GithubAdapter.ts`)

Eligibility predicate (gate on): an entry is INELIGIBLE iff its role is
`review` or `verify` and `entry.watching === false`. Absent `watching`
(unknown) and every other role stay eligible.

Filter at the target-resolution layer, never at the snapshot layer — the raw
binding list must keep naming ineligible followers so `followed` / absence
semantics stay correct (decision D4):

- **Routing-map construction** (`refreshBoundSessions`, both the fresh-scan
  and the partial-retention loops): skip ineligible entries when choosing the
  per-PR winner. The map then holds the most recent ELIGIBLE winner;
  `resolveBoundDelivery` (watch freeze, legacy drain, recovery re-resolve,
  legacy revalidation) inherits the filter with no further change.
- **`resolveBoundTargets`**: legacy branch — when the map has no winner,
  `followed` becomes `boundFollowersOf(...).length > 0` under the gate (raw
  existence), so an ineligible-only PR reads "followed, no target", not
  "unbound". Role-aware branch — drop ineligible followers before the
  per-role grouping; `followed` stays the raw count.
- **`resolveBoundDeliveryExcluding`** (gone-fallback iterator): skip
  ineligible followers.
- **`revalidateBoundTarget`** role-aware branch: drop ineligible followers
  inside the task's role group before picking the winner.

Private-retire outcomes for "followers exist, zero eligible targets" on a
complete fresh snapshot:

- `dispatchEnvelope`: the existing `no_role_matched` retire branch extends to
  legacy gate mode. Reason stays `no_role_matched` in role-aware mode; legacy
  gate mode retires with a new reason `bound_watch_required`. Under a
  partial/failing scan the branch does not fire (an unscanned follower might
  be eligible) — the untargeted claim defers through the absence gate as
  today.
- `deliverToBoundSession` delivery-time revalidation: legacy comments keep
  the frozen target today when revalidation finds no candidate; under the
  gate, `!current` retires privately (`bound_no_candidate`) exactly like
  watch/role-aware events, so a watch stopped between claim and delivery does
  not slip through.
- Gone-fallback exhaustion: the `siblings_still_follow` retire branch extends
  to gate mode — raw followers still listed (the ineligible ones) mean
  private retire, not the public fallback.
- Recovery's legacy backpressure re-resolve: when the filtered map yields no
  delivery but raw followers exist on a complete snapshot under the gate,
  retire (`retireBoundTask`) instead of leaving the task to the public
  absence gate — mirroring the existing role-aware `no role matched` retire.

The mention-exemption probes in `processCommentLane` consume
`resolveBoundTargets(...).targets` and need no change: an ineligible-only PR
loses the exemption, and its plain comments are dropped by the lane instead
of claimed-then-retired — same observable outcome (no delivery, no public
reply).

Watch events need no new code: detection freezes `resolveBoundDelivery`
(filtered), and both drains already retire without a candidate
(`watch_no_target` / `watch_no_candidate`, role-aware drain retire).

## Key design decisions

- **D1 — gate by role, per (session, PR).** The user scoped the gate to
  `/review` and `/verify-pr` sessions; role is the binding's record of that
  origin. A watch on PR A never qualifies the same session's binding to PR B.
- **D2 — derive, don't persist.** No sidecar field, no new write path, no
  sync to keep correct: the scan reads the artifacts the watch flows already
  maintain. Install/stop a watch and the next complete snapshot reflects it.
- **D3 — fail-open.** Unknown `watching` (detection failure, older daemon,
  malformed value) means eligible. The gate reduces noise; degrading to
  today's delivery is safer than starving a session that is watching.
- **D4 — filter targets, not bindings.** Removing ineligible bindings from
  the snapshot would pollute `followed`/absence and open the irreversible
  public path for PRs that ARE bound. The raw list keeps them; only target
  selection filters.
- **D5 — opt-in.** `requireBoundWatch` defaults off; existing deployments
  keep byte-identical behavior. Requires `deliverToBoundSessions`.
- **D6 — polling set unchanged.** Ineligible bindings keep their watch
  baselines and terminal observation; events retire at drain. Cost is bounded
  by `prWatchLimit`; optimizing the poll set is a follow-up.
- **D7 — retirement is surfaced.** Every new retire path writes the existing
  stderr line + channel-event journal row (skip/retire with reason), so a
  gated-away event is never silent.

## Files affected

| File                                                                    | Change                               |
| ----------------------------------------------------------------------- | ------------------------------------ |
| `packages/cli/src/serve/routes/session-pr-watches.ts` (+ test)          | new: watch detection                 |
| `packages/cli/src/serve/routes/session-pr-bindings.ts` (+ test)         | wire `watching` into entries         |
| `packages/cli/src/commands/channel/daemon-worker.ts` (+ test)           | validate/pass `watching`             |
| `packages/channels/base/src/types.ts`                                   | `PrBindingEntry.watching?`           |
| `packages/channels/github/src/GithubAdapter.ts` (+ test)                | option, filter, retire paths         |
| `packages/channels/github/src/index.ts` (+ test)                        | descriptor + validation              |
| `packages/web-shell/client/i18n.tsx`                                    | en + zh labels                       |
| `packages/web-shell/client/components/channels/ChannelEditorDialog.tsx` | field order (parity suite covers it) |
| `docs/design/…` (this pair)                                             | design                               |

## Risks

- **Gate-parse fragility.** The verify-pr gate string is model-authored per
  the skill contract; an unusual spelling contributes no watch (fail-open:
  the session keeps receiving events). The token parse accepts flag order
  variation and quoting of the script path.
- **Scan cost.** One `git worktree list` (10 s timeout) + cron-file read per
  workspace per binding poll (default 60 s). Same machinery the Web Shell
  watches page already uses on demand.
- **Stale `watching` under partial snapshots.** Retained rows keep their last
  known value; a watch installed during a permanent partial is not seen until
  a complete snapshot. Consistent with the existing fail-closed retention
  model; self-heals.
- **Visuals.** A new editor field can shift the channel-editor screenshot;
  update the visuals baseline if the diff is real.

## Validation plan

- Unit: detection (both sources, terminal markers, disabled tasks, malformed
  gates, failure → undefined); route wiring (known/unknown, live-merge rows);
  worker validation (non-boolean drops field only); adapter — legacy winner
  skip, role-aware group skip, gone-fallback skip, revalidation retire,
  dispatch retire (both modes), recovery retire, partial-snapshot deferral,
  gate-off byte-compatibility, unknown-`watching` eligibility.
- E2E (test plan in `.qwen/e2e-tests/`): daemon + github channel against a
  test repo; one-shot verify session vs `--watch` session; comment and
  `ci_failure`/`head_change` events; assert delivery/retire journal rows and
  the absence of public replies.

## Acceptance criteria

1. Gate off (default): every existing test passes unchanged; delivery
   behavior byte-identical.
2. Gate on: a role `review`/`verify` binding with `watching === false` is
   never a delivery target in either mode, on any path (fresh dispatch,
   gone-fallback, recovery, watch drain, revalidation).
3. Gate on: the same session with an active watch on that PR
   (`watching === true`) receives events as today.
4. Gate on: an event whose PR has followers but no eligible target retires
   privately with a journal row; no public reply is ever produced for it.
5. `fix`/untyped bindings and unknown `watching` are unaffected.
6. Detection failure degrades to today's behavior (fail-open) with a
   diagnostic line; it does not mark the snapshot partial.

## Open questions

None blocking. Follow-ups (not this change): skip ineligible bindings in the
active poll set; extend the gate to comment-watch when that feature lands on
this branch.
