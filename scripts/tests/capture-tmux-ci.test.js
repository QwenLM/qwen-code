/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';

// The real-tmux capture suite is describe.skipIf(!hasTmux)-gated and vitest
// does not fail on skips: if the CI install step disappears (a refactor, an
// image change), 50+ real-tmux behaviors — holder survival, logical
// matching, server reaping, signal reap, refusal contracts — silently skip
// inside the required Test check with zero red signal. Pin the step's
// existence and its two load-bearing properties.
describe('ci.yml capture tooling', () => {
  const ci = readFileSync('.github/workflows/ci.yml', 'utf8');
  const doc = parse(ci);
  const steps = doc.jobs['test'].steps;
  const nameIndex = (name) => steps.findIndex((st) => st.name === name);

  it('installs tmux INSIDE the test job, before the tests run', () => {
    // Whole-file substring pins survive the step moving to another job or
    // below the test step — where the real-tmux suite silently skips, the
    // exact failure mode this file exists to prevent.
    const install = nameIndex('Install tmux');
    const runTests = nameIndex('Run tests and generate reports');
    expect(install).toBeGreaterThan(-1);
    expect(runTests).toBeGreaterThan(-1);
    expect(install).toBeLessThan(runTests);
    expect(steps[install].run).toMatch(/sudo apt-get install -y -qq[^\n]* tmux/);
  });

  it('keeps the step advisory — no branch may fail the required check', () => {
    const run = steps[nameIndex('Install tmux')].run;
    // A broken-but-installed tmux (dangling symlink, missing lib) must not
    // turn the Test check red before a single test has run.
    expect(run).toMatch(/tmux -V \|\| echo/);
    // The apt-install fallback is guarded too: without its || echo, an apt
    // hiccup exits the run script non-zero and reds the required check.
    expect(run).toMatch(/apt-get install[^\n]*tmux[^\n]*\\?\n?[^\n]*\|\| echo/);
    // And the no-sudo/no-apt fallback stays a message, not a failure.
    expect(run).toContain('real-tmux capture tests will be skipped');
  });
});
