/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

// The real-tmux capture suite is describe.skipIf(!hasTmux)-gated and vitest
// does not fail on skips: if the CI install step disappears (a refactor, an
// image change), 50+ real-tmux behaviors — holder survival, logical
// matching, server reaping, signal reap, refusal contracts — silently skip
// inside the required Test check with zero red signal. Pin the step's
// existence and its two load-bearing properties.
describe('ci.yml capture tooling', () => {
  const ci = readFileSync('.github/workflows/ci.yml', 'utf8');

  it('installs tmux on the Linux test lane', () => {
    expect(ci).toContain("- name: 'Install tmux'");
    expect(ci).toMatch(/sudo apt-get install -y -qq[^\n]* tmux/);
  });

  it('keeps the step advisory — neither branch may fail the required check', () => {
    // A broken-but-installed tmux (dangling symlink, missing lib) must not
    // turn the Test check red before a single test has run.
    expect(ci).toMatch(/tmux -V \|\| echo/);
    // And the no-sudo/no-apt fallback stays a message, not a failure.
    expect(ci).toContain('real-tmux capture tests will be skipped');
  });
});
