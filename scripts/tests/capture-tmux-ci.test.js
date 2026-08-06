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
// Logical lines the way BASH builds them: join continuations FIRST (any
// following line — bash splices even a #-leading one, whose # then comments
// out the spliced tail), THEN strip comment tails and drop empties. This is
// the domain every pin runs in: raw-text pins were satisfied by comments,
// and a comment-line splice hid a swallowed guard.
function logicalLinesOf(run) {
  const joined = [];
  for (const line of run.split('\n')) {
    const prev = joined[joined.length - 1];
    if (joined.length > 0 && prev.endsWith('\\')) {
      joined[joined.length - 1] = prev.slice(0, -1) + line.trim();
    } else {
      joined.push(line.trim());
    }
  }
  return joined.map((l) => l.replace(/(^|\s)#.*$/, '').trim()).filter(Boolean);
}

// Strip wrappers the shell resolves before the real command: env
// assignments, sudo, env/nice/timeout(+arg) — an apt-get behind any of
// them is still an apt-get.
function unwrapCommand(stmt) {
  let out = stmt.trim();
  for (;;) {
    const next = out
      .replace(/^(\w+=\S+\s+)+/, '')
      .replace(/^(sudo|env|nice)\s+/, '')
      .replace(/^timeout\s+\S+\s+/, '');
    if (next === out) return out;
    out = next;
  }
}

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
    // Over LOGICAL lines (comments cannot satisfy these) and with the
    // package name word-anchored (tmuxinator must not count as tmux).
    const installLines = logicalLinesOf(steps[install].run);
    expect(
      installLines.some((l) => /apt-get install[^\n]*\btmux(\s|$)/.test(l)),
    ).toBe(true);
    expect(
      installLines.some((l) => /apt-get install[^\n]*\bzip unzip\b/.test(l)),
    ).toBe(true);
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
    const logicalLines = logicalLinesOf(run);
    for (const line of logicalLines) {
      // EVERY tmux -V invocation carries its own advisory guard — a bare
      // one in the already-installed branch reds the check on a broken-
      // but-installed tmux.
      if (/\btmux -V\b/.test(line)) {
        expect(line, line).toMatch(/tmux -V[^;&|]*\|\| echo/);
      }
      // NOTHING may hard-fail the step — including clustered set flags
      // (set -euo pipefail), set -o errexit, and keyword-inlined exits.
      expect(line, line).not.toMatch(
        /(^|[;&|]\s*|\bthen\s+|\belse\s+|\bdo\s+)(exit(\s+\d+)?|false|set\s+-\w*e\w*|set\s+-o\s+errexit)(\s|;|$)/,
      );
      // Each apt-get invocation — behind any wrapper — must have a guard
      // AFTER ITS OWN occurrence on the chain: one || echo before an
      // unguarded trailing apt-get must not launder it, so the guard
      // search starts at each occurrence in turn, never back at the first.
      const stmts = line
        .split(/;|&&|\|\||\bthen\b|\belse\b|\bdo\b/)
        .map((x) => unwrapCommand(x))
        .filter(Boolean);
      let cursor = 0;
      for (const stmt of stmts) {
        if (!/apt-get/.test(stmt)) continue;
        const at = line.indexOf('apt-get', cursor);
        if (at === -1) continue;
        cursor = at + 'apt-get'.length;
        if (/^apt-get\b/.test(stmt)) {
          expect(
            line.indexOf('|| echo', at),
            `${stmt} :: ${line}`,
          ).toBeGreaterThan(-1);
        }
      }
      // The ANNOTATION, not the emitter verb.
      if (/skipped|unavailable|install failed|not answering/.test(line)) {
        expect(line, line).toContain('::warning::');
      }
    }
  });
});
