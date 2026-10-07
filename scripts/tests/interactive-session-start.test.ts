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
// real-spawn cases beside the module. Patterns that pin a call site must
// tolerate the trailing-comma multi-line form prettier emits past 80
// columns, or a pure reflow reddens a PR-gated lane with no behavioural
// cause.
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
    // and its import together, and otherwise passes every lane. The call
    // sits one token short of printWidth, so the pattern must also match the
    // trailing-comma multi-line form a reflow emits.
    expect(source).toMatch(
      /session\.waitFor\(\s*'Type your message',\s*readyPromptBudgetMs\(process\.env\),?\s*\)/,
    );
  });

  it('races the ready-prompt wait against child exit, keeping the tail', () => {
    // Reverting the race returns a dead-child boot to a full-budget wait;
    // dropping the tail discards the boot log that made #13552 diagnosable
    // from the job log alone. The exit line stays neutral: whether the
    // prompt reached rawOutput is undecidable once a child out-writes the
    // parent's final read, so a before/after claim can contradict the very
    // tail attached to it.
    expect(source).toContain('Promise.race([');
    expect(source).toContain('ptyProcess.onExit(');
    // Without the latch, close()'s kill() re-runs the handler's strip passes
    // and builds a rejection no settled race observes on every healthy
    // session's teardown.
    expect(source).toContain('if (!startupUndecided) return;');
    expect(source).toContain(
      'CLI exited during startup (code ${exitCode}, signal ${signal})',
    );
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
    // pty's output every 200ms until its own budget expires. The guard is
    // pinned leading waitFor's loop condition — displaced into the body it
    // no longer stops the poll — while prettier's operator-leading reflow of
    // the condition still matches.
    expect(source).toMatch(/while\s*\(\s*!this\.closed\s*&&/);
  });

  it('fails an abandoned poll with the closed-session error', () => {
    // Deleting either statement leaves the loop text intact, so the guard
    // pin alone cannot see it: close() must set the flag, and waitFor must
    // throw on it.
    expect(source).toContain('this.closed = true;');
    expect(source).toContain('Session closed while waiting for text:');
  });
});
