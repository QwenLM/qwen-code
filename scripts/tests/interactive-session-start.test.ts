/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// No PR-triggered job collects the behavioural cases in
// integration-tests/interactive/interactive-session.test.ts: ci.yml's
// PR-gated integration_no_ak leg runs an explicit allow-list under
// --root ./integration-tests that does not name it, and the whole-root legs
// run post-merge and at release. These byte-shape pins give the #13552
// start() contract a PR-gated witness at ~0ms through test:scripts — each
// assertion names the revert it exists to redden, and each was probe-checked
// against that revert. The behaviour behind them is covered by the
// real-spawn cases beside the module.
const source = readFileSync(
  join(
    resolve(import.meta.dirname, '../..'),
    'integration-tests/interactive/interactive-session.ts',
  ),
  'utf8',
);

describe('InteractiveSession.start source pins (#13552)', () => {
  it('threads the resolved ready-prompt budget into the waitFor', () => {
    // A full revert to the literal 30_000 drops the readyPromptBudgetMs call
    // and its import together, and otherwise passes every lane.
    expect(source).toMatch(
      /session\.waitFor\(\s*'Type your message',\s*readyPromptBudgetMs\(process\.env\)\s*\)/,
    );
  });

  it('races the ready-prompt wait against child exit, keeping the tail', () => {
    // Reverting the race returns a dead-child boot to a full-budget wait;
    // dropping the tail discards the boot log that made #13552 diagnosable
    // from the job log alone.
    expect(source).toContain('Promise.race([');
    expect(source).toContain('ptyProcess.onExit(');
    expect(source).toContain('CLI exited before the ready prompt');
    expect(source).toContain(
      'Last 500 chars: ${stripAnsi(session.rawOutput).slice(-500)}',
    );
  });

  it('closes the session a failed start refuses to hand out', () => {
    // Dropping the catch-close orphans the child, pty, and terminal.
    expect(source).toMatch(/catch \(err\) \{[\s\S]*?await session\.close\(\)/);
  });

  it('stops the waitFor poll when the session closes', () => {
    // Without the flag, the race's abandoned loser keeps re-scanning a dead
    // pty's output every 200ms until its own budget expires.
    expect(source).toContain('while (!this.closed &&');
  });
});
