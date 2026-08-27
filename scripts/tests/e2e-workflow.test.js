/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

describe('e2e workflow', () => {
  const workflow = readFileSync('.github/workflows/e2e.yml', 'utf8');
  const yml = parse(workflow);

  it('never cancels in-progress runs on main', () => {
    // A full run takes ~40min while merges land every ~18min, so cancelling on
    // every merge starved the suite — over 100 push runs, 67 were cancelled and
    // only 25 ever reported. Runs on main must finish; dev branches still cancel
    // superseded runs. A future simplification back to `event_name == 'push'`
    // would silently reintroduce the starvation, so the guard is asserted.
    const cancel = yml.concurrency['cancel-in-progress'];
    expect(cancel).toContain(
      "github.event_name == 'push' && github.ref_name != 'main'",
    );
  });

  it('scopes the concurrency group by event and ref', () => {
    // Scoping by event keeps main pushes coalescing with each other without
    // touching the nightly schedule or a manual dispatch on the same ref.
    const group = yml.concurrency.group;
    expect(group).toContain('github.workflow');
    expect(group).toContain('github.event_name');
    expect(group).toContain('github.head_ref || github.ref_name');
  });

  it('caps every lane so a hung model endpoint cannot stall the run', () => {
    // A lane that loses connectivity to the model endpoint burns every test's
    // full 300s timeout before reporting — the 2026-08-26 run took over
    // 4 hours to fail while healthy lanes finish in ~17 minutes. Dropping a
    // cap would silently reintroduce that, so every lane's timeout is pinned.
    const lanes = [
      'e2e-test-linux',
      'e2e-test-macos',
      'isolated-nightly',
      'web-shell-browser-regression',
    ];
    for (const lane of lanes) {
      expect(yml.jobs[lane]['timeout-minutes'], lane).toBeGreaterThan(0);
    }
  });
});
