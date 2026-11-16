# ACP retry parity evidence retention

[English](2026-11-16-acp-retry-parity-evidence.md) | [简体中文](2026-11-16-acp-retry-parity-evidence.zh-CN.md)

## Problem and status

A Linux Node 22 CI attempt failed the repeated-retry scenario because shared-loop round counts differed between arms. Its JUnit report retained the assertion but not the arm debug bytes, requests or updates needed to distinguish execution divergence from incomplete diagnostic output.
A later local Node 24 directed run passed both its test and outer lifecycle: current/shared/kernel counts were 0/0, 3/0 and 3/3, with identical observed debug bytes before termination and after exit. A separate full-file run passed 25 inner tests but its outer cleanup was NQ, not a whole-pipeline pass. Neither observation reproduces, explains or erases the CI failure; earlier broad-meta timeout and platform date-tool failure remain failed records.
Integration with `main` at `b5698f6b07c32dec2d587dc16d8658ec0abac9cd` preserves its pre-shutdown settled-log read (upstream #17365). The observer still snapshots before kill and after parent exit, but the assertion counts come from that upstream settled read; the post-exit snapshot does not overwrite them. Earlier local results above belong to the earlier candidate. This integrated candidate requires its own build, tests and CI.
The test-side observer is locally exercised; CI admission and same-attempt remote evidence remain separate validation gates. This change is evidence retention, not a retry or runtime fix.

## Scope and ownership

Only the existing ACP parity integration test, its shared test-side debug enumeration and focused helper tests, no-AK CI wiring, the directly affected workflow meta-test and this linked design pair change. Core, round equality, public request/update assertions, product startup and shutdown policies remain unchanged.
`ACP_PARITY_DUMP` already exists. CI supplies a command-local nonsecret path under `RUNNER_TEMP`, unique to run ID, attempt and shard; it does not expand the credential-scrub step environment.
Fixture debug files belong to each arm's isolated runtime. Evidence belongs to the current CI job, outside both the fixture workspace and runtime. No runner-global HOME, global debug directory or environment dump is uploaded.

## Test-side records

With the existing dump option set, copy every regular fixture debug file except the `latest` alias into base64 byte snapshots immediately before the original kill and immediately after the original exit wait.
Save the complete existing per-arm result, including requests, updates, stop reasons and both round counts. Do not replace round identity with request count.
Use scenario/arm-PID directories and exclusive `wx` writes so another test attempt cannot silently overwrite earlier receipts. Preserve the existing top-level three-arm dump; it already precedes the round assertions.
The observer and text reader share one regular-file enumeration; the text reader retains its original order and empty-text semantics. A missing debug directory or an empty debug-file enumeration adds an observer error. An outer observer-only finally writes result/status even if the request, settled read, original cleanup or home-isolation assertion throws. Successful business results are still collected after original cleanup and the home assertion; exceptional results are tagged partial and cannot qualify as complete. Observer failures cannot replace the original exception. A missing receipt/status, partial result or nonempty observer-error list is evidence NQ, not a product pass or a diagnosed product failure.

## CI admission and cleanup

The no-AK test command creates its owned evidence directory and receives `ACP_PARITY_DUMP` only for that command. Sharding, budgets, retry policy, routing, checkout and zero-credential protections stay unchanged.
On a failed no-AK gate, the pinned artifact action uploads only `a-retry-that-fails-again/` and its three current/shared/kernel result JSON paths. The artifact name includes run ID, attempt and shard; retention is seven days.
Upload is advisory and an empty match warns: an earlier setup failure or another scenario failure must not look like complete target evidence. The original test failure remains a failure if upload fails. The meta-test binds the exact four upload entries to a real source scenario and its slug transformation; no glob or broader HOME upload is added.
Always clean only the explicitly constructed evidence directory after upload, then retain the existing isolated-HOME cleanup. Cancellation does not gain a new artifact-coverage guarantee.

## Interpretation limits

Debug writes are best effort and have no public drain promise. ACP signal shutdown and stdin EOF both eventually force process exit; changing transport closure is not a demonstrated lossless-log solution.
Snapshots are not atomic across files, stderr covers bytes received at each boundary, and added synchronous parent I/O may perturb scheduling. A pre/post change alone cannot distinguish a late append from late execution; unchanged snapshots do not establish a general flush guarantee.
Match kernel bus markers only to the same snapshot's session round IDs, preserving duplicates. Keep every attempt and its outer cleanup status; a local instrumented pass cannot replace Linux CI evidence.

## Acceptance and follow-up

Run the affected integration typecheck, focused helper tests and original directed scenario without changing its assertions or retry count. Require complete PID-scoped receipts, complete status and empty observer errors for evidence qualification. In owned temporary source mutations, rename the target scenario and require the meta contract to fail; force the existing home-isolation assertion to fail and require result/status with partial status; remove fixture debug files before a snapshot and require observer errors. Restore exact source afterwards. All three owned source mutations were observed and restored exactly: the renamed scenario failed the upload contract; the forced home-isolation failure retained partial result/status; missing debug files left the business case passing but recorded observer errors in all three arms, so its evidence remained unqualified.
Run the direct no-AK meta-test as a whole and regress every changed-job consumer contract identified from actual source readsites, including the hosted-process gate consumer and appropriate adjacent compatibility checks. Select by consumed fields rather than path-string grep; unrelated full-workflow suites remain covered by normal Linux CI. Keep existing assertions, retries and timeouts unchanged. Then check workflow formatting, actionlint and references; pin exact upload paths, failure gating, action revision, unique names, retention and cleanup order.
In a new CI attempt, inspect actual target-failure receipts if that failure occurs; passing or missing evidence does not retrospectively diagnose the original failure. Review fixture evidence before sharing it outside its intended audience.
The original CI cause remains open until evidence distinguishes real execution divergence from diagnostic incompleteness. No Core fix, credential access, automatic retry, review approval or overall migration qualification is implied.
