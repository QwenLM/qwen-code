# Nightly installed npm acceptance

[English](2026-10-27-installed-acceptance-nightly.md) | [简体中文](2026-10-27-installed-acceptance-nightly.zh-CN.md)

## Problem and scope

The installed npm producer and its four native distribution jobs currently run on every matching PR update. They bypass the source TUI impact classifier. Even Java-only changes launch the installed suite. Five successful runs sampled on 2026-10-27 showed a median producer queue of 67.3 minutes versus 8.8 minutes executing, with 90.7–108.5 total runner minutes for the five installed jobs per run. These samples explain the scheduling change, not a guaranteed future speedup.

Change scheduling in the existing `tui-parity` workflow and connect its nightly failures to the existing main-CI issue reporter. Keep all installed assertions, canonical artifact dependencies, native host coverage, toolchain versions, runner routing and failure behavior intact. Do not change product code or release automation.

## Scheduling decision

- Add one daily schedule at `17 19 * * *` UTC, corresponding to 03:17 Asia/Shanghai the following calendar day. GitHub schedules use the default branch and can be delayed by platform queueing; this is not an exact-time guarantee.
- Run `installed-npm` only on `schedule` or `workflow_dispatch`. PR updates skip it regardless of changed paths.
- Keep `installed-distribution` dependent on a successful `installed-npm` producer. A skipped or failed producer must not launch consumers without the canonical artifact.
- Skip the impact classifier and both source TUI jobs on scheduled runs. Preserve their existing PR impact rules, fail-closed classifier behavior and manual execution.
- Preserve PR supersession cancellation and independent manual dispatches. Nightly runs use the existing run-ID-based concurrency group; PR updates cannot cancel nightly evidence.
- Keep the existing workflow and manual dispatch entrypoint rather than duplicating the artifact pipeline in another workflow. A manual dispatch runs both source TUI and installed acceptance against the selected ref.

## Tradeoff and operational use

Ordinary regressions in installation may now be detected on the next nightly run rather than before merge. A nightly pass covers only its tested commit and artifact, not later changes. Packaging, dependencies, launcher/private Bun, native assets and startup compatibility can affect these tests even when the tests themselves do not change.

Maintainers should manually run this workflow against the candidate ref for high-risk installation/runtime changes before merge and for the exact release candidate before publishing. This change does not automate or enforce a release gate, alter required checks, cancel existing queued runs, or claim public released-upgrade coverage. The schedule becomes active only after the workflow change reaches the default branch.

## Nightly failure reporting

Watch `tui-parity` completions in `Main CI Failure Issue` and admit its `schedule` failures on `main`. Reuse the existing log analysis, failing-test signatures, issue creation/reuse and recurrence comments; do not introduce another issue writer. Matching failures reuse their tracker rather than opening a new issue every night. Runs without a test signature use the existing workflow aggregate.

Successful, cancelled and skipped runs do not report. Neither PR runs nor manual dispatches of `tui-parity` enter this new reporting route, including manual runs on `main`; maintainers inspect those runs directly. Stale attempts retain existing suppression. Infrastructure-only failures retain the existing first-attempt rerun policy: a successful rerun request defers filing, a subsequent failure or failed rerun request reports through the existing issue path. Reporting still depends on the reporter being scheduled and its GitHub API/token access working; changing cadence does not guarantee immediate delivery.

## Validation and acceptance

- Workflow meta-tests pin the daily schedule and installed event allowlist, preserve PR and dispatch source-gate behavior, exclude source gates from nightly runs and retain success-only distribution dependencies.
- Confirm the updated regression tests fail against the old workflow and pass with the scheduling change.
- Run the existing workflow contract and runner-routing tests, YAML validation, formatting, CI budget and size checks. Product builds/typechecks are recorded separately; unchanged four-platform product tests are not dispatched merely to validate scheduling.
- Inspect the final diff to ensure no test commands, native matrix entries, canonical artifacts or toolchain versions changed. No UI verification is needed because product behavior is unchanged.
