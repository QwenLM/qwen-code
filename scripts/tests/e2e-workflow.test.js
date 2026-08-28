/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { existsSync, readFileSync } from 'node:fs';
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

  it('quarantines the nightly-isolated suites from every push lane', () => {
    // cron-interactive is timing-flaky, and external-context-mem0-write,
    // external-context-auto-recall, context-compress-interactive and
    // qwen-serve-channel-workers are quarantined to the nightly isolated
    // matrix as a precaution after the #10272 startup stalls (since traced
    // to the goal-runtime wait bug fixed by #10290). Every nightly canary
    // must be excluded from every push lane, and every push-lane exclusion
    // must keep its nightly canary — dropping either side silently loses
    // coverage.
    const nightlyFiles = yml.jobs['isolated-nightly'].strategy.matrix.include
      .map((entry) => entry.test_file)
      .sort();
    // Anchor the oracle to the filesystem: a renamed suite would otherwise
    // match no exclude (vitest ignores a non-matching --exclude silently)
    // and no canary file while this test compared e2e.yml strings only.
    for (const file of nightlyFiles) {
      expect(existsSync(`integration-tests/${file}`), file).toBe(true);
    }
    const countExcludes = (run) => {
      const counts = new Map();
      for (const match of run.matchAll(/--exclude ['"]([^'"]+)['"]/g)) {
        const file = match[1].replace(/^\*\*\//, '');
        counts.set(file, (counts.get(file) ?? 0) + 1);
      }
      return counts;
    };
    // Discover push lanes instead of listing job names: every job with a
    // `Run E2E tests` step is one, so a future lane that forgets the
    // excludes fails here instead of stalling on the quarantined suites.
    let lanes = 0;
    for (const [jobName, job] of Object.entries(yml.jobs)) {
      const step = job.steps.find((s) => s.name === 'Run E2E tests');
      if (!step) continue;
      lanes += 1;
      // One vitest invocation per matrix leg; counting them separately
      // catches an exclude moved between legs, which a whole-step count
      // cancels out.
      const invocations = step.run
        .split('\n')
        .filter((line) => !line.trim().startsWith('#'))
        .filter((line) => /vitest run|test:integration/.test(line));
      expect(invocations.length, jobName).toBeGreaterThan(0);
      for (const invocation of invocations) {
        const counts = countExcludes(invocation);
        expect([...counts.keys()].sort(), `${jobName}: ${invocation}`).toEqual(
          nightlyFiles,
        );
        for (const file of nightlyFiles) {
          expect(counts.get(file), `${jobName}: ${file}`).toBe(1);
        }
      }
    }
    expect(lanes).toBeGreaterThan(0);
  });

  it('runs the nightly canary step on its matrix file', () => {
    // The quarantine test above pins the canary matrix against the push
    // lanes but never reads the canary run step: if that step stopped
    // consuming matrix.test_file, every canary would silently run nothing
    // while continue-on-error painted the jobs green.
    const canaryStep = yml.jobs['isolated-nightly'].steps.find(
      (step) => step.name === 'Run ${{ matrix.label }} tests',
    );
    expect(canaryStep.run).toContain('${{ matrix.test_file }}');
  });
});
