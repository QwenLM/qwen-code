/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// The clock `build-test` runs against, and why it is shaped this way.
//
// One shell call cannot be given more than ten minutes: `run_shell_command`
// validates `timeout > 600000` and refuses the call (`shell.ts`, "Timeout
// cannot exceed 600000ms"). That is a hard ceiling on a SINGLE invocation, so
// the whole-call budget below is not a policy choice — it is that ceiling minus
// the headroom the outer clock needs (the shell's timer starts before node
// does, and the report still has to be written after the last command).
//
// The per-command deadline is a measurement, not a round number. On this repo,
// on an idle machine, `npm test --workspace="packages/cli"` takes **401
// seconds** of wall clock. The old 300-second default could therefore never
// pass that suite: three live reviews (PRs #9113, #9109, #9106) each started it
// and each killed it — at 286s, 300s and 300s — spending up to half the whole
// call to learn nothing. A deadline below the slowest suite is not a safety
// margin; it is a guaranteed timeout with a budget attached.
//
// The two numbers no longer derive from each other. The old default budget was
// `2 × timeout − 30`, which happened to equal the ceiling only while the
// timeout was 300; raising the timeout to fit a real suite would have pushed
// the derived budget past the ceiling and handed the outer kill a call it was
// guaranteed to discard. The budget belongs to the ceiling; the deadline
// belongs to the slowest command.
//
// Which leaves the arithmetic that no single call can win: install (24s) +
// the builds the suites need + `packages/core` (106s) + `packages/cli` (401s)
// is already past 570s before four more suites are reached. That is what
// `--resume` is for — the same run continued in a second call, with a second
// ceiling. See `runBuildTest`.

/**
 * The shell tool's own hard maximum, which the agent's brief welds onto every
 * long review command (`build-test`, `test-efficacy`). Exported so the briefs
 * and the budget below quote ONE number: they were separately-maintained
 * copies, and the budget's "30s of headroom under the 600-second tool timeout"
 * comment was the only thing tying them together.
 */
export const SHELL_TOOL_MAX_TIMEOUT_MS = 600_000;

/**
 * Headroom between the whole-call budget and the tool timeout: process start,
 * the report write, and the drift between the shell's clock and node's.
 */
export const BUILD_TEST_BUDGET_HEADROOM_S = 30;

/** The default whole-call budget: everything the ceiling leaves usable. */
export const DEFAULT_WHOLE_CALL_BUDGET_S =
  SHELL_TOOL_MAX_TIMEOUT_MS / 1000 - BUILD_TEST_BUDGET_HEADROOM_S;

/**
 * The default per-command deadline — large enough for the slowest single
 * command a review of this repo runs (401s, measured above), and still inside
 * the whole-call budget with headroom to spare.
 */
export const DEFAULT_COMMAND_TIMEOUT_S = 540;

/**
 * How many `--resume` continuations a review may spend before it reports what
 * it has. Four calls of ten minutes is the point where the build-and-test
 * dimension stops being cheaper than the reviewer's attention; past it, the
 * honest answer is the disclosure `notRun` already carries.
 */
export const MAX_RESUME_CALLS = 3;
