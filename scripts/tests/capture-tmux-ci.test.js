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
    // A broken-but-installed tmux (dangling symlink, missing lib) must not
    // turn the Test check red before a single test has run.
    expect(run).toMatch(/tmux -V \|\| echo/);
    // Rejoin `\` continuations so each LOGICAL statement is checked whole:
    // the apt-install guard belongs to the update && install chain, and a
    // future tidy that splits the chain must not escape the pin.
    const logicalLines = run
      .split('\n')
      // Comments first: a commented-out statement must not satisfy (or
      // fail) any pin, and a `\` at the end of a COMMENT line is comment
      // text, not a shell continuation.
      .filter((line) => !line.trim().startsWith('#'))
      .reduce((acc, line) => {
        if (acc.length > 0 && acc[acc.length - 1].endsWith('\\')) {
          acc[acc.length - 1] = acc[acc.length - 1].slice(0, -1) + line.trim();
        } else {
          acc.push(line.trim());
        }
        return acc;
      }, []);
    for (const line of logicalLines) {
      // Any echo STATEMENT, whatever its quoting: the single-quote-only
      // match let a re-quoted `|| echo "..."` skip both assertions and
      // regress a permanent install failure to one plain log line.
      // EVERY echo statement is a ::warning:: annotation naming the
      // outcome — by COUNT, so a second plain echo cannot hide behind one
      // compliant sibling on the same logical line.
      const echoCount = (line.match(/(^|&&|\|\||;)\s*echo\b/g) ?? []).length;
      const warningCount = (line.match(/echo ['"]::warning::/g) ?? []).length;
      expect(warningCount, line).toBe(echoCount);
      if (echoCount > 0) {
        expect(line, line).toContain('will be skipped');
      }
      // PER STATEMENT, not per line: each apt-get invocation carries its
      // own guard — one `|| echo` at the tail must not launder an earlier
      // unguarded statement separated by `;`.
      for (const stmt of line.split(';')) {
        if (/(^|&&|\|\|)\s*(sudo\s+)?apt-get/.test(stmt.trim() ? `&&${stmt}` : stmt) || /^\s*(sudo\s+)?apt-get/.test(stmt.trim())) {
          expect(stmt, stmt).toMatch(/\|\| echo/);
        }
      }
    }
  });
});
