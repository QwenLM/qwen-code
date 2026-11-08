/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// The parity suite runs in the PR-gated no-AK lane, but neither property here
// is observable there on a green run: the ubuntu-latest fallback resolves the
// budget to the same 30s the deleted literal was, while on the ecs-qwen
// routing the runner injects RUNNER_ENVIRONMENT=self-hosted and
// QWEN_SANDBOX=false selects the 90s tier. Neither value is asserted on the
// lane, a healthy boot renders the prompt in seconds and never exercises the
// dead-child race, and only a non-deterministic boot stall would surface a
// revert to 30_000. These byte-shape pins give each revert a ~0ms witness
// through test:scripts, which runs on every PR.
const source = readFileSync(
  join(
    resolve(import.meta.dirname, '../..'),
    'integration-tests/skill-hooks-invocation-parity.test.ts',
  ),
  'utf8',
);

describe('skill-hooks invocation-parity startup source pins (#15226)', () => {
  it('threads the resolved ready-prompt budget into the waitFor', () => {
    // A full revert to the literal 30_000 drops the readyPromptBudgetMs call
    // and its import together, and otherwise passes every PR-gated lane. The
    // call fits on one line today, but a reflow past 80 columns emits a
    // trailing comma, so the pattern tolerates both forms.
    expect(source).toMatch(
      /rig\.waitForText\(\s*'Type your message',\s*readyPromptBudgetMs\(process\.env\),?\s*\)/,
    );
  });

  it('races the ready-prompt wait against child exit, keeping the tail', () => {
    // Reverting the race returns a dead-child boot to a full-budget poll of a
    // dead pty and discards the exit code; dropping the throw's tail loses the
    // host-side boot log that made #15226 diagnosable from the job log. The
    // latch keeps the race's abandoned arm from rejecting on teardown. The
    // same `Output:\n${output}` substring also appears in the untouched
    // expect below, so the tail must be pinned as part of the throw.
    expect(source).toContain('Promise.race([');
    expect(source).toContain('if (!startupUndecided) return false;');
    expect(source).toContain(
      'CLI exited during startup (code ${exitCode}, signal ${signal})',
    );
    expect(source).toContain('Output:\\n${output}');
    expect(source).toMatch(
      /CLI exited during startup[\s\S]{0,120}?Output:\\n\$\{output\}/,
    );
  });

  it('derives the CI wait from the harness default', () => {
    // The ceilings multiply this value, and the harness derives every
    // makeWaitFor budget from the same default. Re-spelling 60_000 here lets
    // a harness change move the real waits without moving the ceilings.
    expect(source).toMatch(/CI_WAIT_MS\s*=\s*CI_DEFAULT_WAIT_MS/);
  });

  it('derives both case ceilings from the budget and bounds retries', () => {
    // Hand-derived ceilings go stale on the next budget raise; deriving them
    // makes the raise move both. The explicit retry: 0 stops the root
    // config's retry: 2 from tripling a stall that cannot recover.
    expect(source).toContain(
      'MAX_READY_PROMPT_BUDGET_MS + 3 * CI_WAIT_MS + SLACK_MS',
    );
    expect(source).toContain(
      'MAX_READY_PROMPT_BUDGET_MS + 5 * CI_WAIT_MS + SLACK_MS',
    );
    expect(source).toMatch(
      /\{\s*timeout: MODEL_CASE_TIMEOUT,\s*retry: 0,?\s*\}/,
    );
    expect(source).toMatch(
      /\{\s*timeout: USER_CASE_TIMEOUT,\s*retry: 0,?\s*\}/,
    );
  });
});
