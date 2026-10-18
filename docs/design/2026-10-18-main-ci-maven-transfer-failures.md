# Retry transient Maven transfers in main CI

[English](2026-10-18-main-ci-maven-transfer-failures.md) |
[简体中文](2026-10-18-main-ci-maven-transfer-failures.zh-CN.md)

## Problem and scope

Issue #14426 describes a transient Maven artifact download failure being sent
to the code-repair queue. The main CI watcher checks runner annotations, but a
failed shell step normally has only `Process completed with exit code 1.` as
its annotation. The Maven explanation is in the log.

This change adds Maven transfer evidence to the main watcher only. It preserves
the shared runner-annotation signatures and the PR autofix workflow. It does
not add Maven retries to build commands or change test failure deduplication.

## Decision

Keep the existing annotation check first. When it does not identify a runner
failure, fetch that job's failed-step logs with
`gh run view --repo "$REPO" --job "$job_id" --log-failed` and inspect them with
a small Node helper.

The gh output identifies the job and step with tab-separated prefixes when
per-step logs are available. Otherwise it emits whole-job logs as `UNKNOWN STEP`,
including successful steps and cleanup. A successful step can contain a recovered
network error before a different step fails, so the helper must verify ownership.
It accepts a BOM before any log timestamp and strips raw or gh-sanitized ANSI.

The helper requires all of the following:

- Every failed step in the Jobs API response has a matching log. Missing,
  duplicate or unrepresentable failed-step names are not evidence. In particular,
  gh can omit a missing step log while returning success.
- For `UNKNOWN STEP`, all non-skipped steps must have valid API execution times.
  These times have second precision, so each interval includes the entire
  completion second. Any log line that could belong to a failed step must have
  exactly one possible owner. Ambiguous boundary lines are rejected, never
  discarded. Output definitely outside failed steps is ignored. Mixed named and
  unknown attribution is rejected.
- Each step ends with the runner's nonzero process-exit marker.
- Its final Maven `BUILD FAILURE` is followed only by transfer errors, timing
  lines and known Maven help text. A transfer error must say
  `Could not transfer artifact` and identify HTTP 502/503/504, a connection/read
  timeout, or a connection reset in the same diagnostic.
- Other Maven error diagnostics or non-exit runner/action error annotations
  anywhere in the failed step disqualify it, even if a later Maven invocation
  ends in a transfer failure.

Warnings, arbitrary timeouts, authentication/not-found errors and later
compiler/test failures do not qualify. Unrecognized Maven output remains on
the ordinary issue path rather than guessing that it is transient.

The time fallback is deliberately limited: real GitHub logs often place a
failed step's final output and the next cleanup step in the same second. Those
cases still report an issue without explicit step attribution. Counting exit
markers, splitting on log groups, or treating BOMs as step boundaries cannot
resolve ownership; a continued shell failure and a failed JavaScript action need
not have matching exit-marker and failed-step counts.

## Routing and constraints

All existing run-level rules remain in force: retry only attempt 1, require a
nonempty failed-job set, and classify every counted job as infrastructure.
The gate reporter's derivative failure remains excluded, while a reporter
whose own runner died still counts. If rerun dispatch fails, the issue is
filed. A failed rerun returns at attempt 2 and is reported normally.

Metadata, annotations and logs remain data. The new helper performs no network
calls or writes, and the new gh call uses the analyzer's existing read-only
token. Issue creation stays in the separate privileged job. The extra log read
is limited to failed jobs without a matching infrastructure annotation on the
first attempt.

## Validation and acceptance

- Execute the actual workflow step with fixture GitHub responses, checking
  rerun and issue-routing behavior, including failed rerun dispatch.
- Generate a real Maven 503 using a loopback HTTP mirror and an empty artifact
  cache, and a real javac error as a non-infrastructure control.
- Cover transient transfer variants, mixed jobs and steps, recovered errors,
  missing/unknown logs, failed reads, reporter handling and later attempts.
- Replay captured GitHub log formats and test BOMs, whole-job fallback with
  unambiguous times, same-second boundaries, continued failures, action errors,
  missing metadata and cleanup. Historical logs are negative controls; positive
  whole-job fixtures use real Maven output with explicitly synthetic step times.
- Run the relevant workflow meta-tests and helper tests on macOS and Docker
  Linux. The Linux harness executes the original Bash workflow bodies.
- Run repository build, bundle, typecheck, changed-file lint and formatting.

Acceptance requires the real Maven 503 with confirmed step ownership to select
one infrastructure rerun while compiler failures, ambiguous evidence and
repeated failures retain reporting.
The harness mocks GitHub metadata and writes; it does not dispatch live Actions
or create remote issues. Cross-platform Maven output outside the recognized
terminal format is intentionally not classified as infrastructure.
