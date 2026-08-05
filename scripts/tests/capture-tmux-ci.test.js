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
    expect(install.if).toContain("runner.os == 'Linux'");
    expect(install.if).toContain("skip_ci != 'true'");
    expect(install.if).toContain("ci_profile == 'full'");
  });

  it('keeps the step advisory — no branch may fail the required check', () => {
    const run = steps[nameIndex(INSTALL)].run;
    // A broken-but-installed tmux (dangling symlink, missing lib) must not
    // turn the Test check red before a single test has run.
    expect(run).toMatch(/tmux -V \|\| echo/);
    // Rejoin `\` continuations so each LOGICAL statement is checked whole:
    // the apt-install guard belongs to the update && install chain, and a
    // future tidy that splits the chain must not escape the pin.
    const logicalLines = run.split('\n').reduce((acc, line) => {
      if (acc.length > 0 && acc[acc.length - 1].endsWith('\\')) {
        acc[acc.length - 1] = acc[acc.length - 1].slice(0, -1) + line.trim();
      } else {
        acc.push(line.trim());
      }
      return acc;
    }, []);
    for (const line of logicalLines) {
      if (line.includes("echo '")) {
        // EVERY echo statement is a ::warning:: annotation naming the
        // outcome — a lane where the install PERMANENTLY fails loses the
        // real-tmux coverage forever (the zip suite throws on its own),
        // and a plain echo hides that as one line in a multi-thousand-line
        // log while the check UI stays clean.
        expect(line, line).toContain('::warning::');
        expect(line, line).toContain('will be skipped');
      }
      // Command position only — `command -v apt-get` is a probe, not an
      // invocation, and needs no guard.
      if (/(^|&&|\|\||;)\s*(sudo\s+)?apt-get/.test(line)) {
        // bash -eo pipefail reds the required check on an UNGUARDED apt
        // statement (a transient mirror hiccup) before any test runs.
        expect(line, line).toMatch(/\|\| echo/);
      }
    }
  });
});
