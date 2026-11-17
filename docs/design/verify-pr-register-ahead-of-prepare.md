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
- `completeRound` already records the directory:
  `dir = artifactDir ?? ownFlight?.artifactDir ?? prior?.artifactDir ?? null`.
  No change needed there — `--complete --artifact-dir <dir>` records the dir
  prepare printed; an omitted dir still falls back to the marker/prior.
- HELP: the `--start` synopsis marks `--artifact-dir` optional and states that
  registration precedes prepare and the directory is recorded at `--complete`.

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
failure after `--start`** must `--release --head <H>` (or `--complete
inconclusive`) so the head is not stranded in flight. The contract states this
explicitly. The existing dead-round recovery (`--release` for a round that died
after `--start`) now also covers a round that died during prepare.

### Pins and witnesses

- `scripts/tests/qwen-triage-workflow.test.js`: the `--start` command pin drops
  `--artifact-dir`; the `--complete` command pin gains `--artifact-dir <dir>`;
  the ordering pin asserts registration precedes prepare.
- `scripts/tests/verify-pr-watch-state.test.js`: new witnesses — `--start`
  without `--artifact-dir` registers in flight with a `null` dir; `--complete
--artifact-dir <dir>` records it; `--start --artifact-dir <dir>` still works
  (backward compatibility); a start-before-prepare round released after a
  simulated prepare kill recovers the head (no silent drop).

## Key design decisions

- **Optional, not required, at `--complete`.** The directory feeds the verdict's
  artifact link, not certification. Keeping it optional preserves the
  inconclusive/replay fallback paths; the contract instructs passing it. Making
  it required would break a replayed completion that inherits the prior dir.
- **Backward compatible.** `--start --artifact-dir` still accepted; the change
  only removes a requirement and reorders the contract.
- **No dedup/defer/release semantic change.** The marker's purpose is
  dedup/recovery; a `null` dir does not affect it.

## Files affected

- `scripts/verify-pr-watch-state.mjs` — `parseArgs` requirement removed; HELP.
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
  or the next head move can recover, instead of vanishing. A watch only wakes on
  head moves, so a killed round on the _last_ head still awaits a new move or a
  manual `--release`; the fix ensures the head is never silently unrecorded.
