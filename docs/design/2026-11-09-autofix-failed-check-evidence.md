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

- A sharded lane (`Linux unit tests (shard 3/4)`) does not say which test file
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
   `feedback.md` or step stdout. This is the same shape as
   `packages/cli/src/commands/autofix-pr/ci-log.ts`'s `jobLog`, and the behavioral
   suite's fake `gh` reproduces the refusal so a missing flag turns it red. The
   identical fix is applied to the patrol's own `GhClient.jobLog`
   (`.github/scripts/ci-flaky-rerun.mjs`), which was equally log-blind on current
   `gh`; it is handled here rather than deferred so the reused scrubber's fetch
   actually works.
8. **The fence cannot be closed by the log.** The excerpt's Markdown fence is
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
  witnesses the flag and the ANSI-strip together.
- `scripts/tests/ci-flaky-rerun.test.js` (vitest): the patrol's `GhClient.jobLog`
  passes the flag, falls back only on `unknown flag`, strips VT control
  characters, and propagates a non-refusal error.
- `scripts/tests/qwen-autofix-workflow.test.js` (vitest): the call precedes the
  checkout and uses the working-tree path; the tolerant fallbacks and stderr
  sink; the section's position between the name-only lists and the gate
  rejection, before the defanged echo; CI membership in both helper-test lists;
  the af-161 pointer and the skill guidance.
- Mutation checks: moving the call below the checkout, staging it under
  `RUNNER_TEMP`, dropping `|| true`, dropping the feedback guard, dropping
  either CI membership entry, and dropping the skill sentence each turn the
  workflow pins red; dropping the flag, the ANSI strip, the old-gh fallback,
  reverting the line cap to 60, fixing the fence at four backticks, narrowing
  the usage guard to `&&`, rendering the raw log, dropping the self-lane
  exclusion, the job cap, the dedupe, or adding `CANCELLED` each turn the
  collector tests red; dropping the patrol's flag turns its witness red.
- `scripts/tests/ci-platform-lanes.test.js` re-runs because `ci.yml` changed.

## Acceptance criteria

- A red PR's `feedback.md` carries failed step names and a redacted excerpt for
  up to three failing jobs, and the excerpt actually renders against a current
  `gh` (the flag is passed) with no raw ANSI reaching `feedback.md` or step
  stdout.
- No secret from a job log reaches `feedback.md` or step stdout.
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
