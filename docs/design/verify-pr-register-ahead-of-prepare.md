# verify-pr: register the watch round ahead of prepare (R17-2 liveness)

Language: English | [中文](verify-pr-register-ahead-of-prepare.zh-CN.md)

Tracking issue: #17371 (residual risks accepted by #17185's land-with-residual-risk
decision). This closes **R17-2**, the last open item in the issue's
"report integrity / local correctness / docs / liveness" tier. The core trust
boundary residual R17-1 was already closed by #17375 (root-aware containment +
hard-link alias check + sha256 content binding, witnessed by the
`R17-1 / R2-1 trust-boundary witnesses` suite); R16-1/R16-2/R16-4 and D17-1…3
were closed by #17440. R17-2 is a liveness/availability gap, not attacker-controlled.

## Problem statement and current state

The watch contract registers a round **after** prepare. The prompt
(`.qwen/skills/verify-pr/SKILL.md`) says "Run prepare first (trusted host
metadata), then register the round with `verify-pr-watch-state.mjs <n> --start
--head <headSha> --round <r> --artifact-dir <dir> --repo <owner>/<repo>`", where
`<dir>` is the artifact directory **prepare printed**. `parseArgs` enforces this
ordering: `--start` without `--artifact-dir` is a usage error
(`scripts/verify-pr-watch-state.mjs`, `if (out.start && !out.artifactDir)`).

The probe's cursor (`autofix-pr snapshot --gate`) advances when the head-move
event is **delivered** to the model — before prepare runs. So the sequence is:

1. cursor advances (head delivered);
2. prepare runs (host metadata, creates the artifact dir);
3. `--start` registers the head in flight;
4. battery;
5. `--complete` files the verdict.

A session **killed inside the prepare window** (after step 1, before step 3)
leaves the delivered head in **no state**: the cursor already advanced past it,
so no second event arrives, and no in-flight marker records that the head was
delivered. The head is silently dropped — even the next head move cannot recover
it, because `--start` for the new head sees no blocker and the dropped head
leaves no trace. This fails toward not-certifying (a head never gets a round),
which is the liveness gap R17-2 names.

## Proposed changes

Register the round **ahead of prepare**, so a kill in the prepare window leaves
a recoverable in-flight marker rather than a silent drop.

### watch-state helper (`scripts/verify-pr-watch-state.mjs`)

- `parseArgs`: drop the `--start requires --artifact-dir` usage error.
  `--artifact-dir` becomes **optional on `--start`** (stored when given, `null`
  otherwise). The empty/valueless rejection stays. `--start --artifact-dir <dir>`
  remains accepted, so existing callers are unaffected.
- `completeRound`'s directory resolution is unchanged
  (`dir = artifactDir ?? ownFlight?.artifactDir ?? prior?.artifactDir ?? null` —
  the marker first, then an earlier verdict, then none), but the PR **adds
  `artifactDir: dir` to its return value** so the CLI can disclose a null one,
  and **adds a warning branch in `main()`** that fires when a non-inconclusive
  completion resolves to no directory (R1-3). `--complete --artifact-dir <dir>`
  records the dir prepare printed; an omitted dir falls back to the marker's
  (when the start carried one) or an earlier verdict's.
- HELP: the `--start` synopsis marks `--artifact-dir` optional and states that
  registration precedes prepare and the directory is recorded at `--complete`;
  the fallback paragraph names the full chain (marker → earlier verdict → none).

An in-flight entry with a `null` artifact directory is already a valid shape
(the legacy `inFlightHead` migration produces one), so dedup, deferral, release
and the resting-view guard are unchanged.

### Skill contract (`.qwen/skills/verify-pr/SKILL.md`)

The watch prompt and the manual re-verification step both change to:

1. **Register first**: `verify-pr-watch-state.mjs <n> --start --head <H> --round
<r> --repo <owner>/<repo>` (no `--artifact-dir` — prepare has not run yet).
2. **Prepare**: run the trusted prepare block; it creates and prints the
   artifact dir `<dir>`.
3. **Battery** in `<dir>`.
4. **Complete**: `verify-pr-watch-state.mjs <n> --complete --head <H> --round
<r> --verdict <word> [--artifact-dir <dir>] [--comment-id <id>] --repo
<owner>/<repo>` — the directory is recorded here (optional: a replayed
   completion omits it to inherit the recorded directory).

New responsibility: because the marker now exists before prepare, a **prepare
failure after `--start`** is recovered according to the round's state. A
_transient_ failure (the round still runs) leaves the marker intact — prepare
never reads the watch state — so retry prepare against it and complete at the
original round, with no release (round 7); releasing first would leave the head
unregistered between the release and a restart, re-opening the silent drop if
the round is killed in that window. A round that _died_ is recovered by
`--release --head <H> --round <r> --repo <owner>/<repo>` **and then start the
head again** (`--start --head <H> --round <r+1> --repo <owner>/<repo>`) and retry
prepare. A release alone is not a recovery: `releaseRound` files only a
`releasedHeads` push-order hint — explicitly not a deferral, and printed by no
verb — so the head is left unregistered, and the probe cursor already advanced
past it, so no fire delivers it again (R1-1 round 2). The release must be paired
with the restart, exactly as the file's dead-round paragraph pairs them.
`--repo` is required on both once `--start` recorded it; every verb refuses an
omitted `--repo` against a recorded repo. Use `--release` + restart, **not**
`--complete inconclusive`: inconclusive is the only verdict that increments the
head's retry counter, and the counter's cap is the terminal not-covered state,
so two transient prepare failures would retire a head no round ever examined
(R1-5). The restarted round's number (`<r+1>`) becomes this round's number, and
`--complete` must repeat that value (R3-2). The recovery has a non-transient
terminal case: if prepare refuses because the head it names is not the head
this round registered — moved forward or force-pushed; prepare re-resolves
`headRefOid` from a live `gh pr view`, tests exact equality and states no
ordering — the registered head can never prepare: `--release` it (with the
marker's `--round`) and do **not** restart it (R9-1 round 10 extends this from
"moved past / newer" to any differing head, so a force-push back to an ancestor
reaches the branch too). In the watch prompt the live head is delivered by the
next fire (the gate cursor tracks the live head, `next.headSha = pr.headRefOid`),
or is already in the deferred list the release prints, which you then start —
the started head is its own round, and `--complete` repeats its head and round,
not the released head's (round 7); in the ordinary moved-head case no fire ran
between registration and prepare, so the live head was never deferred and the
next fire delivers it (R4-1 round 5 restores this two-branch form). In the manual
path there is no fire, so re-resolve the live head (`gh pr view … --json
headRefOid`) and `--start` it; the restarted round is now `<live>` at `<next>`,
and `--complete` repeats those values, not the original `<H>` and `<r>` (round
6). Do not `git checkout` the named head under the old marker, which would file
the named head's evidence under the delivered head's verdict (R1-1 round 3,
R4-1). The comparison also runs when prepare **succeeds** (maintainer P1,
round 14): prepare checks the tree against the live PR head, not the registered
one, so a force-push back to a head the tree already sits at prepares
successfully while the round registered a different head — the refusal-handler
comparison never fires, and completing would file the other head's evidence
under the registered head. Both flows therefore compare the `head` prepare
printed (the trusted snapshot's `headRefOid`) with the registered head before
the battery; a differing head is the moved-head case (release this round's
marker; run neither the battery nor `--complete`). The prepare paragraph's
wrong-HEAD checkout remedy keys off identity, not recency (R5-1 round 8): if this round registered a
head, the plain checkout is the remedy only when the named head **is** that
head; a head that differs (moved or force-pushed — prepare tests exact equality
and states no ordering) is the moved-head case (release this round's marker;
never check out the named head under it). A round that registered nothing (a
fresh `/verify-pr <n>`, which never calls `--start`) has no marker of its own:
it reads the state file's in-flight entry first and, while another round's
marker is live, lets that round answer rather than checking out under it. The
round-7 "newer than this round's registered head" framing was ill-defined for a
fresh round and missed force-push, and its else arm endorsed checking out the
named head under another round's live marker — `completeRound` matches the
marker by head and round alone, so the named head's evidence would be filed
under the registered head's verdict and `duplicateHead` would refuse to
re-examine it. Both moved-head release forms pass `--round <r>` (this round's
own marker), like the sibling recovery form.
The completion form's `--artifact-dir` is optional: a replayed completion omits
it to inherit the directory already recorded for the head rather than
overwriting it. The dead-marker bullet's `--round` is the
blocking marker's round, read from the state file's in-flight entry and passed
(reading the state is allowed; only hand-writing the JSON is forbidden): an
omitted `--round` skips the match, so a retried release would delete a newer
round's live marker for the same head; omit it only for a legacy marker that
records no round (R2-1 round 4). The contract states this explicitly. The
existing dead-round recovery (`--release` for a round that died after
`--start`) now also covers a round that died during prepare.

### Pins and witnesses

- `scripts/tests/qwen-triage-workflow.test.js`: the `--start` command pin drops
  `--artifact-dir`; the `--complete` command pin gains `--artifact-dir <dir>`;
  a **positional** pin asserts the registration sentence precedes the
  `Then run prepare` sentence in each section (watch `<headSha>`, manual `<H>`);
  the prepare-failure recovery pin asserts the full `--release` form carries
  `--repo` **and the restart clause** (`--start … --round <r+1>`; removing
  either reds it); the watch prompt's exit-3 dead-marker bullet is pinned to the
  full `--release … --repo` form (R2-1). Round 6 adds slice-scoped pins so a
  shared sentence's copy in one section is not an alibi for the other: the
  no-`--artifact-dir` invariant and the replay-omission clause are pinned on
  each section's own slice, the wrong-HEAD exception (R5-1) and the
  moved-head completion re-binding are pinned, and the general entry-path
  bullet is pinned to the prepare block (registration is a watch/re-verification
  procedure) with the boundary section qualifying that registration precedes
  prepare. Round 7 makes the wrong-HEAD remedy registration-aware (replacing the
  round-6 three-state form whose in-flight arm wedged on this round's own
  marker), pins the transient retry-without-release recovery in each section and
  the watch moved-head completion re-binding, and documents the mistyped-`--repo`
  reset. Round 8 refines the remedy to identity (the plain checkout only when the
  named head IS this round's registered head; a differing head is the moved-head
  case; a fresh round reads the state's in-flight entry and defers to a live
  marker), pins that wording so reverting to "newer than" reds it, and adds the
  reset's re-register step. Round 10 carries the identity criterion into the watch and manual
  moved-head branches themselves (the watch prompt reads only the gate JSON, so
  the prepare-paragraph rule alone never reached them): the branch now fires on
  any head differing from the registered one — forward or force-pushed — the
  delivered head is the "live head" (`<live>`), the per-section moved-head pins
  move with the rewording, the this-round recovery release forms pass `--round`
  (no longer optional), the reset notes it also drops deferred heads, and the
  registration-order pins guard the `--start` command's position, not just the
  heading. Round 11 adds the fresh-round dead-marker branch (recover a dead
  round's marker, then check out) and presence guards on the order pins so a
  placeholder-spelling change cannot make them vacuous; round 12 makes the
  prepare-named-head vs registered-head comparison explicit and gates the reset
  on no live round (no in-flight marker, not merely not mid-battery); round 13
  corrects the re-create guidance — re-creating a pre-register-ahead watch
  through the standard install does not work, because step 3 is blocked by the
  probe cursor as well as the claim and `--release` clears only the claim, so
  such a watch keeps the old order until manually migrated (a residual), and
  another session's live watch must not be deleted to make room. Round 14
  (maintainer P1) adds the post-prepare-success head comparison to both flows
  and pins it on each section's slice (the shared release-without-complete
  sentence is pinned per slice so one section's copy is not the other's alibi).
  These prose clauses are pinned in the text-pin suite.
- `scripts/tests/verify-pr-watch-state.test.js`: new witnesses driven through
  the **CLI** (`run(root, …)`, exercising the helper code this PR changes — the
  `parseArgs` requirement, `completeRound`'s return field, and `main`'s
  warning) — `--start` without `--artifact-dir` registers in flight with a
  `null` dir (restoring the requirement reds it); `--complete --artifact-dir
  <dir>` records it **and prints no warning**; `--start --artifact-dir <dir>`
  still works and a dir-less `--complete` inherits the marker's dir **with no
  warning** (backward compatibility); a replayed completion inherits the prior
  verdict's dir; a non-inconclusive `--complete` with no resolved dir prints the
  no-evidence-directory warning (dropping the warning's directory conjunct reds
  the no-warning assertions, R2-3); a start-before-prepare round with no
  `--complete` (a prepare kill) then `--release` **and a restart** through the
  CLI recovers the head (no silent drop). The directory-chain CLI witnesses also
  live here (not in the text-pin file): an explicit completion directory overrides
  a different start directory (reordering the resolution chain reds it); a
  replayed completion with an explicit dir overrides the prior verdict's dir
  (prior-arm precedence); and a completion files the live head with whatever
  directory it is given, then refuses a re-start — the certifies-falsely harm the
  checkout remedy is the only guard against (the helper carries no tree/evidence
  check by design). A round-14 witness covers the prepare-success head mismatch:
  registering a head then releasing it (the moved-head recovery, never
  completing) leaves it with no verdict, and completing it with another head's
  evidence directory is refused — the registered head receives no verdict.

## Key design decisions

- **Optional, not required, at `--complete`.** The directory feeds the verdict's
  artifact link, not certification. Keeping it optional preserves the
  inconclusive/replay fallback paths; the contract instructs passing it. Making
  it required would break a replayed completion that inherits the prior dir.
  Because the register-ahead marker carries no directory, a non-inconclusive
  completion that resolves to no directory **warns** on stderr that the verdict
  has no evidence directory (R1-3) — disclosing the lost link without breaking
  the fallback. The HELP states the real fallback chain the code implements:
  the in-flight marker's directory when the start carried one, else an earlier
  verdict's directory for the same head, else none.
- **Backward compatible.** `--start --artifact-dir` still accepted; the change
  only removes a requirement and reorders the contract.
- **No dedup/defer/release semantic change.** The marker's purpose is
  dedup/recovery; a `null` dir does not affect it.

## Files affected

- `scripts/verify-pr-watch-state.mjs` — `parseArgs` requirement removed; HELP
  real fallback; `completeRound` returns the resolved dir; a non-inconclusive
  null-dir completion warns.
- `.qwen/skills/verify-pr/SKILL.md` — watch prompt + manual re-verification
  ordering; prepare-failure-after-start recovery.
- `scripts/tests/qwen-triage-workflow.test.js` — command/ordering pins.
- `scripts/tests/verify-pr-watch-state.test.js` — registration-ahead witnesses.
- `docs/design/verify-pr-register-ahead-of-prepare.md` + `.zh-CN.md` — this doc.

## Scope boundaries

- Only the registration ordering, the `--start` argument requirement, and the
  post-prepare-success head comparison (maintainer P1, round 14). The
  watch-gate ownership/cursor, the dedup/defer/release semantics, and the
  trust-boundary checks (R17-1, closed by #17375) are unchanged.
- The below-Critical deferred items (D17-4…14, R5-2, round-7/8 deferred) stay
  tracked in #17371; not touched here.

## Open questions

- None blocking. The liveness gain is observability/recoverability: a head
  delivered then killed in prepare now leaves an in-flight marker an operator
  or the next head move can recover, instead of vanishing. The fix **narrows**
  the silent-drop window; it does not eliminate it. Three residuals remain, tracked
  in #17371: (1) the gate writes its cursor before it prints the event
  (`packages/cli/src/commands/autofix-pr/snapshot.ts`), so a session killed
  between the gate's delivery and the first `--start` still leaves the head
  unrecorded — the window is narrowed to that delivery→`--start` interval, not
  closed (closing it would put the marker in the gate, which already holds
  `headSha`); (2) the watch prompt is a persisted task snapshot, so a watch
  installed before this change keeps the prepare-then-register order until its
  task is manually migrated — the standard install cannot re-create it (step 3
  is blocked by the probe cursor as well as the claim, and `--release` clears
  only the claim), and `--start --artifact-dir` remains accepted, so nothing
  forces the upgrade; (3) the dead-round recovery pairs `--release` with a
  restart, and a kill between those two commands leaves the head unregistered —
  the transient path avoids this by retrying prepare against the intact marker
  without releasing, but a dead round's recovery still carries that window. A
  watch only wakes on head moves, so a killed round on the
  _last_ head still awaits a new move, or a manual
  `--release --head <H> --round <r> --repo <owner>/<repo>` **followed by a
  restart** (`--start … --round <r+1>`) — a release alone leaves the head
  unregistered. `<r>` is the dead round's number, read from the state file's
  in-flight entry and passed (omit it only for a legacy marker that records no
  round), so a retried release cannot delete a newer round's live marker.
