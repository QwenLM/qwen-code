# Autofix Failed-Check Evidence

[English](2026-11-09-autofix-failed-check-evidence.md) | [简体中文](2026-11-09-autofix-failed-check-evidence.zh-CN.md)

Status: implemented in this change; verified by the unit and workflow-pin suites
listed under Validation.

## Problem

The Qwen Autofix review loop selects a PR when its checks are red, but the agent
that fixes the PR receives check **names** only. `feedback.md` renders
`## Failed checks` and `## Still-red checks` as `name: conclusion` lines
(`.github/workflows/qwen-autofix.yml`), and the agent holds no GitHub
credentials (`.qwen/skills/autofix/SKILL.md`, "You have no GitHub credentials").
It cannot read a job log, an annotation, or even the name of the step that
failed.

For a locally reproducible lane this is survivable: the agent maps the check
name to the repository's own command and reruns it. Three classes are not:

- A sharded lane (`Linux unit tests (shard 2/2)`) does not say which test file
  failed, so the agent runs the whole package and bisects.
- A check named `Test` can fail on a non-test step (schema, format, lint,
  freshness). The skill already warns about this because it recurs.
- An environment-only lane cannot be reproduced locally at all; without the log
  the agent spends a round on a hypothesis.

The CI Failure Patrol already distils job logs for its classifier
(`.github/scripts/ci-flaky-rerun.mjs`: `redactLog` + `skillLog`, fetched from
`repos/<repo>/actions/jobs/<id>/logs`). The automation that decides whether a
failure is flaky can see the log; the automation that fixes the code cannot.

## Goals

- Give the address agent the failed **step names** and a bounded, redacted log
  excerpt for each failing job.
- Reuse the patrol's redaction so the two automations scrub secrets identically.
- Degrade to less evidence, never to a failed round.

## Non-goals

- No change to which PRs are selected, to round accounting, or to the
  verification gate.
- No new credentials for the agent; it still reads only `feedback.md`.
- No flaky reruns — those remain the CI Failure Patrol's job.
- No full log download into the agent context; excerpts stay bounded.

## Proposed solution

A new collector, `.github/scripts/autofix-check-evidence.mjs`, prints a
`## Failed check evidence (bounded excerpts)` section. `Prepare branch and
feedback` writes it to `${WORKDIR}/check-evidence.md` and the feedback block
cats it when non-empty, after the two name-only sections and before the
gate-rejection context.

Per failing job the collector emits:

- the check name and workflow, stripped to the same character class the
  existing check-name lists use;
- `Failed steps:` — the names of steps whose conclusion is `failure`, read from
  `repos/<repo>/actions/jobs/<id>`;
- a fenced log excerpt from `repos/<repo>/actions/jobs/<id>/logs`, passed through
  the patrol's `skillLog` (redaction + error-marker line selection) and kept
  whole at its own ~120-line bound; the fence is sized past any backtick run in
  the excerpt so a log line cannot close it early.

The job id comes from the check's `detailsUrl`
(`…/actions/runs/<run>/job/<job>`), so no extra lookup is needed to resolve it.

## Design decisions

1. **Run before the branch checkout.** The call sits in `Prepare branch and
feedback` while the working tree is still the trusted base, the same position
   `resolve-sandbox-image.mjs` already runs from. The collector imports
   `./ci-flaky-rerun.mjs`, so both files must come from trusted code; below the
   checkout they would be branch-supplied code executing with the PAT in env.
   Because no branch code has run at that point, no staged copy or digest is
   needed (contrast af-158, whose instrument runs in the gate after branch code
   has executed).
2. **Mirror the existing selection.** The collector applies the same failure
   conclusions and the same `Qwen Autofix` self-lane exclusion with the
   `review-address` exception, matching the `## Still-red checks` gate. The
   sibling `## Failed checks` list also admits `CANCELLED`; a cancelled job is
   not a failure to diagnose, so it is omitted here. External commit statuses
   have no job URL and stay name-only.
3. **Bound the fan-out.** The first three distinct jobs in rollup order,
   skillLog's own ~120-line selection kept whole (truncating it from the head
   drops the tail that carries the failure summary and the final `Process
completed with exit code 1` on a noisy multi-error log), and an 8 MiB
   `execFileSync` buffer past which the log is dropped rather than buffered.
4. **Best-effort everywhere.** The script is absent from the trusted base until
   this merges, so the `node` call is `|| true`; an unreadable rollup, a failed
   API read, or an oversized log yields an empty or partial section. Collector
   stderr goes to `${WORKDIR}/check-evidence.log`, which the whole-WORKDIR
   artifact upload already carries.
5. **Snapshot semantics.** The excerpt is taken before checkout and its preamble
   names the head it describes. The two name-only sections remain authoritative
   for the evaluated head; a push between the two reads can leave the excerpt
   describing the previous head, which the preamble makes visible.
6. **Untrusted text.** Log output is untrusted: `skillLog` redacts credentials,
   headings are sanitized, and the existing feedback echo defangs both
   workflow-command syntaxes (`::` and `##[`) before anything reaches step
   stdout. The skill tells the agent the section is a bounded snapshot and that
   it must still reproduce the failure locally.
7. **The log fetch needs three parts.** Current `gh` refuses to print a response
   containing terminal escape sequences — which Actions job logs essentially
   always do — unless `--allow-escape-sequences` is passed; a bare call exits 1
   with empty stdout, and a helper that swallows non-zero exits would silently
   render no excerpt. So the fetch passes the flag, falls back to the bare call
   only when stderr says `unknown flag` (older `gh` has neither the check nor the
   flag), and applies `stripVTControlCharacters` so raw ANSI never reaches
   `feedback.md` or step stdout. This fetch shape — flag, old-`gh` fallback, VT
   strip — is the same as `packages/cli/src/commands/autofix-pr/ci-log.ts`'s
   `jobLog`, and the behavioral suite's fake `gh` reproduces the refusal so a
   missing flag turns it red. The identical fix is applied to the patrol's own
   `GhClient.jobLog` (`.github/scripts/ci-flaky-rerun.mjs`), which was equally
   log-blind on current `gh`; it is handled here rather than deferred so the
   reused scrubber's fetch actually works.
8. **Terminal controls are stripped between two redaction passes, in the shared
   scrubber.** `stripVTControlCharacters` removes escape sequences but leaves
   the bare C0/C1 controls and the Unicode Bidi overrides: a `\r` lets a
   fork-controlled log line visually overwrite a line's start in a terminal,
   `\b`, `\x0b`, `\x0c`, DEL and the C1 range repaint it just as well, and the
   `Bidi_Control` set reorders it. `skillLog` therefore strips
   `[\x00-\x08\x0b-\x1f\x7f-\x9f\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]`
   (C0/DEL/C1 plus the full `Bidi_Control` set that `safeReason` already drops,
   keeping `\n` and `\t`) — between two redaction passes. The first pass is the
   unchanged `redactLog`, and it runs BEFORE the strip: a bare `\r` still
   supplies the word boundary the anchored secret patterns (`\bnpm_…`,
   `\bsk-…`, `\beyJ…`, `\b<scheme>://`) need, and it still bounds the
   line-scoped `Cookie:` / `Authorization:` rules, whose `[^\r\n]*` must stop
   at the header's own line. The second pass, `redactWeldedTokens`, runs AFTER
   the strip and differs from the first in two ways, both forced by the strip.
   It carries only the token rules: once every `\r` is gone, re-running the two
   header rules would consume everything up to the next newline — including
   the `##[error]` line the excerpt exists to show — and their values were
   already redacted by the first pass. And it drops the `\b` anchors: a control
   byte INSIDE a credential (`npm_\rABC…`) defeats every anchor on the first
   pass, and the same strip can weld a word character onto the token's front
   (`x\rnpm_…` becomes `xnpm_…`), leaving `\b` nothing to match. Over-redaction
   is the safe direction for a pass that only ever sees already-redacted text;
   the cost is that an unanchored `sk-` also redacts a `task-…` identifier
   carrying 20+ alphanumerics. A control inside a header value still leaves the
   fragment past the CR visible (`Cookie: [redacted]=abc`), exactly as the
   unstripped base does; scrubbing that remainder would mean re-running a
   header rule over CR-free text, which is the swallow above. Living in
   `skillLog`, the strip covers both the collector's excerpt and the patrol's
   rendered evidence (its only `jobLog` caller goes through `skillLog`). The
   sibling fetches themselves are unchanged: `ci-log.ts`'s `jobLog` still
   writes bare controls into `.qwen/tmp/autofix-pr-<n>-ci-<run>.log`, and the
   patrol's `GhClient.jobLog` still returns them to its caller. One transition
   cost: the patrol also keys its marker comment off `skillLog`'s output
   (`fingerprint(target, log)` in `scan`), and `alreadyHandled` matches that key
   exactly, so removing controls re-keys the fingerprint — a marker written
   before this lands stops matching once, the patrol re-triages that failure and
   posts a fresh marker, and it self-heals from the next marker on.
9. **The fence cannot be closed by the log.** The excerpt's Markdown fence is
   sized longer than the longest backtick run inside it, so a log line carrying
   backticks cannot close the fence early and spill the rest into `feedback.md`
   as markup.

## Constraints and risks

- The workflow file is size-gated (`.github/scripts/check-workflow-size.sh`);
  this change adds ~1.3 KB and stays within the recorded baseline allowance.
- Log text can contain attacker-influenced output. Redaction, sanitization and
  the existing defang are the mitigations; the agent already treats all
  feedback as untrusted.
- Evidence collection adds up to six API reads per round (metadata + log for
  three jobs). A failure of any read degrades silently.
- The excerpt may describe a head that moved between the two reads; the
  preamble names the head so the discrepancy is visible rather than silent.

## Validation plan

- `.github/scripts/autofix-check-evidence.test.mjs` (node:test): selection
  mirrors the workflow gates (including a realistic `StatusContext` that stays
  name-only), dedupe and fan-out bounds, redaction witness, the ~120-line bound
  with the failure-summary tail kept, fence sizing past a backtick run, the
  80-character name cap, markup stripping, the usage guard for each missing
  argument, and every degradation path through a fake `gh` on PATH. The fake
  `gh` reproduces a current gh's escape-sequence refusal (exit 1 unless the flag
  is passed) and an old gh's `unknown flag`, so the excerpt-rendering test
  witnesses the flag and the ANSI-strip together. Further cases pin the control
  strip end-to-end: a secret after a bare `\r` is still redacted (the first
  `redactLog` pass runs before the strip), a header line terminated by a bare CR
  does not swallow the `##[error]` line that follows it, backspace/C0/C1 and
  Bidi controls are stripped while tab and newline survive, and the text past
  the first control is retained (a truncating implementation stays red). The
  Bidi case feeds every `Bidi_Control` code point and asserts
  `/\p{Bidi_Control}/u` against stdout, so narrowing the class to a sample
  cannot stay green.
- `scripts/tests/ci-flaky-rerun.test.js` (vitest): the patrol's `GhClient.jobLog`
  passes the flag, falls back only on `unknown flag`, strips VT control
  characters, and propagates a non-refusal error; `skillLog` strips terminal
  controls and Bidi overrides between two redaction passes (a secret after a
  bare CR is still redacted, backspace/vertical tab/Bidi are gone, a credential
  split by a control byte is redacted once the strip rejoins it, and so is one
  whose leading word boundary the strip also removed), keeps the failure line
  that follows a CR-terminated header, and strips every C0/DEL/C1 and
  `Bidi_Control` code point — asserted against Unicode's own property, with
  `\n` and `\t` still surviving.
- `scripts/tests/qwen-autofix-workflow.test.js` (vitest): the call precedes the
  checkout and uses the working-tree path; the tolerant fallbacks and stderr
  sink; the section's position between the name-only lists and the gate
  rejection, before the defanged echo; CI membership in both helper-test lists;
  the af-161 pointer and the skill guidance.
- Mutation checks: moving the call below the checkout, staging it under
  `RUNNER_TEMP`, dropping `|| true`, dropping the feedback guard, dropping
  either CI membership entry, and dropping the skill sentence each turn the
  workflow pins red; dropping the flag, the ANSI strip, the control strip, the
  old-gh fallback, reverting the line cap to 60, fixing the fence at four
  backticks, narrowing the usage guard to `&&`, rendering the raw log, dropping
  the self-lane exclusion, the job cap, the dedupe, or adding `CANCELLED` each
  turn the collector tests red; re-running the whole `redactLog` after the
  strip, re-anchoring the post-strip `npm_` rule, making that pass a no-op,
  moving the control strip before the first redaction pass, deleting the strip,
  narrowing it to `\r` alone, narrowing the Bidi class to the sampled points,
  dropping a single unsampled `Bidi_Control` point, truncating at the first
  control, or widening the class to eat `\n`/`\t` each turn the collector or
  patrol witness red; dropping the patrol's flag turns its witness red.
- `scripts/tests/ci-platform-lanes.test.js` re-runs because `ci.yml` changed.

## Acceptance criteria

- A red PR's `feedback.md` carries failed step names and a redacted excerpt for
  up to three failing jobs, and the excerpt actually renders against a current
  `gh` (the flag is passed) with no raw ANSI, terminal control characters
  (bare CR, backspace, C0/C1) or Bidi overrides reaching `feedback.md` or step
  stdout.
- No secret from a job log reaches `feedback.md` or step stdout, including a
  credential the strip welds into a contiguous token — whether the control sat
  inside it or in front of its leading word boundary.
- A header line terminated by a bare CR still leaves the failure line that
  follows it in the excerpt.
- An absent script, an unreadable rollup, or a failed API read never fails a
  round.
- The collector and its imported helper execute from the trusted base, before
  the PR branch is checked out.
- Both helper-test lists run the behavioral suite; the workflow pins, the
  collector tests, and the patrol tests pass.

## Open questions

- Whether three jobs is the right fan-out for a PR red across many shards; the
  cap is a constant and can be raised without changing the shape.
- Whether to surface annotations as a cheaper first signal; they are sparse in
  this repository's lanes, so step names plus the excerpt were chosen instead.
