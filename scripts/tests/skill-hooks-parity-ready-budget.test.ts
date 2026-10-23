/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// The parity suite runs in the PR-gated no-AK lane, but neither property here
// is observable there: ci.yml never exports RUNNER_ENVIRONMENT, so the budget
// call resolves to the same 30s the deleted literal did, and a healthy boot
// never exercises the dead-child race. These byte-shape pins give each revert
// a ~0ms witness through test:scripts, which runs on every PR.
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
    // dead pty and discards the exit code; dropping the tail loses the
    // host-side boot log that made #15226 diagnosable from the job log. The
    // latch keeps the race's abandoned arm from rejecting on teardown.
    expect(source).toContain('Promise.race([');
    expect(source).toContain('if (!startupUndecided) return false;');
    expect(source).toContain(
      'CLI exited during startup (code ${exitCode}, signal ${signal})',
    );
    expect(source).toContain('Output:\\n${output}');
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
