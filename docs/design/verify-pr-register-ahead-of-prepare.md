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
<r> --verdict <word> --artifact-dir <dir> [--comment-id <id>] --repo
<owner>/<repo>` — the directory is recorded here.

New responsibility: because the marker now exists before prepare, a **prepare
failure after `--start`** must
`--release --head <H> [--round <r>] --repo <owner>/<repo>` **and then start the
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
terminal case: if prepare refuses because the PR has moved past the delivered
head (prepare re-resolves `headRefOid` from a live `gh pr view` and refuses a
tree whose HEAD is not that head), the delivered head can never prepare —
`--release` it (with the marker's `--round`) and do **not** restart it. In the
watch prompt the newer head is delivered by the next fire (the gate cursor
tracks the live head, `next.headSha = pr.headRefOid`), or is already in the
deferred list the release prints, which you then start; in the ordinary
moved-head case no fire ran between registration and prepare, so the newer head
was never deferred and the next fire delivers it (R4-1 round 5 restores this
two-branch form). In the manual path there is no fire, so re-resolve the newer
head (`gh pr view … --json headRefOid`) and `--start` it. Do not `git checkout`
the newer head under the old marker, which would file the newer head's evidence
under the delivered head's verdict (R1-1 round 3, R4-1) — the prepare
paragraph's wrong-HEAD checkout remedy carries the same exception (R5-1). Both
moved-head release forms carry `[--round <r>]` like the sibling recovery form.
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
  full `--release … --repo` form (R2-1).
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
  CLI recovers the head (no silent drop).

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

- Only the registration ordering and the `--start` argument requirement. The
  watch-gate ownership/cursor, the dedup/defer/release semantics, and the
  trust-boundary checks (R17-1, closed by #17375) are unchanged.
- The below-Critical deferred items (D17-4…14, R5-2, round-7/8 deferred) stay
  tracked in #17371; not touched here.

## Open questions

- None blocking. The liveness gain is observability/recoverability: a head
  delivered then killed in prepare now leaves an in-flight marker an operator
  or the next head move can recover, instead of vanishing. The fix **narrows**
  the silent-drop window; it does not eliminate it. Two residuals remain, tracked
  in #17371: (1) the gate writes its cursor before it prints the event
  (`packages/cli/src/commands/autofix-pr/snapshot.ts`), so a session killed
  between the gate's delivery and the first `--start` still leaves the head
  unrecorded — the window is narrowed to that delivery→`--start` interval, not
  closed (closing it would put the marker in the gate, which already holds
  `headSha`); (2) the watch prompt is a persisted task snapshot, so a watch
  installed before this change keeps the prepare-then-register order until its
  task is re-created — and `--start --artifact-dir` remains accepted, so nothing
  forces re-creation. A watch only wakes on head moves, so a killed round on the
  _last_ head still awaits a new move, or a manual
  `--release --head <H> --repo <owner>/<repo>` **followed by a restart**
  (`--start … --round <r+1>`) — a release alone leaves the head unregistered.
