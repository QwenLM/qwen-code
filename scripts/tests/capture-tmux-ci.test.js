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
// image change) — or its `if:` condition mutates so it never RUNS — 50+
// real-tmux behaviors — holder survival, logical matching, server reaping,
// refusal contracts — silently skip inside the required Test check with
// zero red signal. Pin the step's existence, its condition, and its
// load-bearing properties.
describe('ci.yml capture tooling', () => {
  const ci = readFileSync('.github/workflows/ci.yml', 'utf8');
  const doc = parse(ci);
  const steps = doc.jobs['test'].steps;
  const nameIndex = (name) => steps.findIndex((st) => st.name === name);
  const INSTALL = 'Install tmux and zip tooling';

  it('installs tmux INSIDE the test job, before the tests run', () => {
    // Whole-file substring pins survive the step moving to another job or
    // below the test step — where the real-tmux suite silently skips, the
    // exact failure mode this file exists to prevent.
    const install = nameIndex(INSTALL);
    const runTests = nameIndex('Run tests and generate reports');
    expect(install).toBeGreaterThan(-1);
    expect(runTests).toBeGreaterThan(-1);
    expect(install).toBeLessThan(runTests);
    expect(steps[install].run).toMatch(
      /sudo apt-get install -y -qq[^\n]* tmux/,
    );
    // The install-script packaging suite needs zip/unzip the same way
    // (and throws on a CI host missing them): the tooling rides this same
    // advisory step so the Linux lane actually runs those tests.
    expect(steps[install].run).toMatch(/apt-get install[^\n]* zip unzip/);
  });

  it('pins the if-condition — it decides whether the step runs on the Linux lane at all', () => {
    // A mutated condition (runner.os flipped, a typo in the skip_ci /
    // ci_profile gates) means the ubuntu lane never installs the tooling:
    // hasTmux is false and the real-tmux suite silently skips inside the
    // required green Test check while every other pin in this file stays
    // green — the exact silent-skip regression this file exists to prevent.
    const install = steps[nameIndex(INSTALL)];
    // EXACT equality, not containment: `A && (B || true)` still contains
    // every pinned substring while the gate is destroyed.
    expect(install.if.replace(/\s+/g, ' ').trim()).toBe(
      "${{ needs.classify_pr.outputs.skip_ci != 'true' && steps.ci_profile.outputs.ci_profile == 'full' && runner.os == 'Linux' }}",
    );
  });

  it('keeps the step advisory — no branch may fail the required check', () => {
    const run = steps[nameIndex(INSTALL)].run;
    // Logical lines the way BASH builds them: continuations join FIRST (a
    // comment line terminates a chain — a backslash at the end of comment
    // TEXT is not a continuation), and comment lines are dropped AFTER, so
    // a statement following a comment-capped chain stands alone here
    // exactly as it executes.
    const raw = run.split('\n');
    const joined = [];
    for (const line of raw) {
      const prev = joined[joined.length - 1];
      if (
        joined.length > 0 &&
        prev.endsWith('\\') &&
        !prev.trim().startsWith('#')
      ) {
        joined[joined.length - 1] = prev.slice(0, -1) + line.trim();
      } else {
        joined.push(line.trim());
      }
    }
    const logicalLines = joined.filter((l) => l && !l.startsWith('#'));
    // Branch 1 pinned on LOGICAL lines, not raw text — a commented-out
    // advisory satisfied the raw-text regex while executing nothing.
    expect(
      logicalLines.some((l) => /tmux -V \|\| echo/.test(l)),
      'tmux -V advisory line missing',
    ).toBe(true);
    for (const line of logicalLines) {
      // NOTHING may hard-fail the step: an exit/false/set -e in any branch
      // turns the advisory step into a gate that reds the required check
      // before a single test has run.
      expect(line, line).not.toMatch(
        /(^|[;&|]\s*)(exit(\s+\d+)?|false|set\s+-e)(\s|;|$)/,
      );
      // Statement boundaries include the shell keywords: an echo or
      // apt-get inlined after then/else/do escaped the position-anchored
      // alternation entirely.
      const stmts = line
        .split(/;|&&|\|\||\bthen\b|\belse\b|\bdo\b/)
        .map((x) => x.trim())
        .filter(Boolean);
      for (const stmt of stmts) {
        // Env-assignment prefixes are transparent to the shell and to us.
        const norm = stmt.replace(/^(\w+=\S+\s+)+/, '');
        if (/^(sudo\s+)?apt-get\b/.test(norm) && !/^command\b/.test(norm)) {
          // Each apt-get invocation carries its own guard on its line.
          expect(line, stmt).toMatch(/\|\| echo/);
        }
      }
      // Pin the ANNOTATION, not the emitter verb: any line that announces
      // a degradation must announce it as a ::warning:: — an emitter swap
      // (printf) or a plain-log demotion must turn red.
      if (/skipped|unavailable|install failed|not answering/.test(line)) {
        expect(line, line).toContain('::warning::');
      }
    }
  });
});
