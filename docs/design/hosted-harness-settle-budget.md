# Hosted harness settle and CI failure budgets

[English](./hosted-harness-settle-budget.md) | [简体中文](./hosted-harness-settle-budget.zh-CN.md)

## Problem

The hosted harness tests give every settle wait a fresh timeout. On a loaded non-ECS host that timeout equals Vitest's default 15-second test ceiling, so the runner can time out before the wait reports its assertion. Sequential waits in helpers such as `parkToolTurn` can also exceed an explicit 30-second ceiling even though each individual wait appears bounded.

Real Vitest reproductions confirm the lost assertion and a separate aggregate failure problem: the CLI CI command continues through every failing test, with two retries per test. The per-test deadline alone cannot stop those repeated failures from exhausting the CI step's 110-minute cap.

The current suite collects 604 concrete tests. A source analysis identifies 265 tests with unconditional call chains to the affected settle assertion. A budget scenario that assigns only one failed wait per test costs 245 × 45 + 20 × 29 = 11,605 seconds before retries, or 34,815 seconds with two retries. These are configured-budget scenarios, not measured multi-hour runtimes or universal lower bounds; the issue's historical estimates are not reused. A short real-timer reproduction confirms that three permanent failures consume nine attempts and still allow the following file to run.

## Decision

Keep the existing per-wait slow-host allowance of 45 seconds and the ordinary allowance of 10 seconds. At the beginning of each test attempt, derive one monotonic deadline from Vitest's resolved `task.timeout`, reserving one second for reporting the assertion and finishing the test body. Every settle wait receives the smaller of its per-wait allowance and the remaining time before that deadline.

The deadline starts in the existing outer `beforeEach`, so fixture setup conservatively consumes the same budget. Nested helpers and the describe-local `waitFor` and recovery `idle` wrappers use that same deadline. Every new test and retry resets it. The deadline is local to this sequential test file.

Use `node:perf_hooks` rather than `Date.now`, because some tests change the wall clock. Once the deadline is exhausted, use a one-millisecond timeout so Vitest still evaluates the current assertion and reports its failure. When Vitest explicitly disables the test ceiling with zero, retain only the per-wait allowance.

## CI failure policy

Use Vitest's built-in `--bail=1` in the CLI's `test:ci` entry. Vitest first exhausts a test's configured retries. Only a final failure cancels pending tests, preserves the original failure in the reports, and exits nonzero. A failure recovered by retry does not stop the run.

This removes the number of queued failing tests from the aggregate settle-failure cost. In the reproduced single-worker scenario, three attempts of the first permanently failing test replace three attempts of every failing test. Concurrent work already in progress can finish; this is not a process-kill timer or a guarantee against unrelated stalls elsewhere in the workflow. The CI step cap remains a final backstop.

The tradeoff is fewer diagnostics after a permanent CI failure. The ordinary `test` entry remains exhaustive for local investigation. Both workspace CI and release commands call `test:ci`, so both use this policy for the CLI package. No other package's failure policy changes.

## Scope and implementation

A small `settle-timeout` test utility returns the remaining timeout from a captured deadline. The hosted harness suite initializes it from the actual test context and replaces fixed settle-budget reads with calls to it. Collocated tests cover sequential consumption, explicit ceilings, slow-host slack, exhaustion, wall-clock independence, and reset between attempts.

No product behavior, host-load detection, package-wide timeout, retry count, or CI step limit changes. Waits with separate existing fixed budgets remain outside this change. A subprocess regression test exercises the actual CLI script arguments and installed Vitest, checking permanent failures, recovery on the final retry, exhaustive local diagnostics, nonzero exit status, and failure reporting. Attempt markers verify that queued tests did not execute; Vitest 3's aggregate skipped counters do not include tests cancelled by bail.

## Verification

- A permanently failing settle assertion on a slow non-ECS host must be reported before the 15-second runner ceiling.
- Sequential helper waits must share the remaining budget of an explicitly 30-second test rather than each receiving 45 seconds.
- A 60-second ECS test must retain the full 45-second first-wait allowance when enough time remains; an ordinary host retains its 10-second allowance.
- All existing hosted harness tests must pass on the host and Docker Linux with unchanged assertions and outer timeouts.
- A permanent failure with two retries must run three attempts, stop queued tests, exit nonzero, and preserve its assertion in JUnit. A test recovered by its final retry must allow following tests to run.
- The ordinary local test command must continue through all failures for diagnosis.
- Build, typecheck, focused regression tests, lint, and formatting must pass.

## Open questions

None for the reported settle-budget and cumulative-failure mechanisms. Replacing host-load heuristics, diagnosing unrelated CI stalls, and changing other packages' failure policies remain outside this change.
