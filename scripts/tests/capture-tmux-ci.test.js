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
// Logical lines the way BASH builds them, scanned character by character so
// the pins run on the text bash actually executes. Three rules the previous
// line-at-a-time version got wrong, each probe-verified against bash:
//   - a `#` inside quotes is LITERAL, not a comment (a stripped quoted `#`
//     hid a trailing `&& exit 1` from every advisory pin);
//   - only an ODD run of trailing backslashes continues a line (`\\` is an
//     escaped backslash, and the following line is its own command);
//   - a COMMENT never continues, whatever it ends with (`# note \` followed
//     by `exit 1` leaves the exit as its own logical line).
// Quoted strings spanning a newline fold into one logical line, as bash does.
function logicalLinesOf(run) {
  const lines = [];
  let cur = '';
  let quote = null;
  let pending = false;
  for (const raw of run.split('\n')) {
    // A spliced or quote-continued line keeps its text verbatim; a fresh one
    // is trimmed so indentation never reaches a pin.
    const line = pending || quote ? raw : raw.trim();
    pending = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      const last = i + 1 === line.length;
      if (quote === "'") {
        cur += c;
        if (c === "'") quote = null;
        continue;
      }
      if (quote === '"') {
        if (c === '\\') {
          if (last) {
            pending = true;
            break;
          }
          cur += c + line[++i];
          continue;
        }
        cur += c;
        if (c === '"') quote = null;
        continue;
      }
      if (c === '\\') {
        if (last) {
          pending = true;
          break;
        }
        cur += c + line[++i];
        continue;
      }
      // A `#` opens a comment at line start, after whitespace, OR after a
      // shell metacharacter — bash treats `echo hi;#note` as a comment, and
      // a `;#...\` tail spliced the next line into the "comment", hiding
      // its statements from every pin on that logical line.
      if (c === '#' && (i === 0 || /[\s;&|()]/.test(line[i - 1]))) break;
      if (c === "'" || c === '"') {
        quote = c;
        cur += c;
        continue;
      }
      cur += c;
    }
    if (pending) continue;
    if (quote) {
      cur += ' ';
      continue;
    }
    if (cur.trim()) lines.push(cur.trim());
    cur = '';
  }
  if (cur.trim()) lines.push(cur.trim());
  return lines;
}

// Strip what the shell resolves before the real command: env assignments
// and wrapper verbs WITH their options (`sudo -n`, `timeout -k 1 5`,
// `timeout --signal=KILL 5`, `nice -n 10`, `time`, `nohup`, `stdbuf -oL`).
// An apt-get behind any of them is still an apt-get; option residue used to
// break the recognition check and silently skip the guard requirement.
const WRAPPERS = /^(sudo|env|nice|timeout|time|nohup|stdbuf|ionice|setsid)\s+/;
function unwrapCommand(stmt) {
  let out = stmt.trim();
  for (;;) {
    const next = out
      .replace(/^(\w+=\S+\s+)+/, '')
      .replace(WRAPPERS, '')
      // Options belonging to the wrapper just stripped, plus the bare
      // duration `timeout`/`nice` take before the command word.
      .replace(/^(-{1,2}[\w-]+(=\S+)?\s+)+/, '')
      .replace(/^(\d+[smhd]?\s+)/, '');
    if (next === out) return out;
    out = next;
  }
}

// Is this statement a real apt-get invocation, or a mention of one? A
// `command -v apt-get` probe names it without running it; anything else
// that reaches apt-get — behind any wrapper, in any group — runs it.
function isAptGet(stmt) {
  const bare = unwrapCommand(stmt.replace(/^[\s({]+/, ''));
  return /^apt-get\b/.test(bare);
}

// The commands on one logical line, with grouping punctuation removed: a
// subshell-wrapped `(exit 1)` is an exit like any other, and it gives its
// enclosing if/elif/else branch the same status. A single `&` separates
// statements too — `sleep 1 & exit 1` is two commands, and the exit was
// invisible while the alphabet knew only `&&`.
function statementsOf(line) {
  return line
    .split(/;|&&|\|\||\||&|\bthen\b|\belse\b|\bdo\b|\bfi\b/)
    .map((x) =>
      unwrapCommand(x.replace(/^[\s({]+/, '').replace(/[\s)}]+$/, '')),
    )
    .filter(Boolean);
}

// Does this `set` enable errexit? Any position, any spelling — `set -e`,
// clustered `set -euo pipefail`, `set -u -e`, `set -o errexit`,
// `set -o pipefail -e`. `set +e` DISABLES it and must not match.
function enablesErrexit(stmt) {
  return /^set\b.*?(\s-\w*e\w*|\s-o\s+errexit)(\s|$)/.test(stmt);
}

// Whether this argv-ish line installs the EXACT package, as a whole token:
// `\btmux` matches across a hyphen, so `powerline-tmux` satisfied a \b
// anchor while installing no tmux binary at all.
function installsPackage(line, pkg) {
  return /apt-get\s+install\b/.test(line) && line.split(/\s+/).includes(pkg);
}

// Flags that make `apt-get install` exit 0 having installed NOTHING — the
// quietest failure of all: the step stays green, no warning fires, and the
// real-tmux suite skips inside the required check.
const NO_OP_INSTALL_FLAGS = new Set([
  '-s',
  '--simulate',
  '--just-print',
  '--dry-run',
  '--recon',
  '--no-act',
  '--download-only',
  '-d',
  '--print-uris',
]);

// A branch condition that can be satisfied without the tools it claims to
// test: a literal constant, or bash's null command `:` (status 0 always).
function hasForcingTerm(line) {
  return /(^|[\s;&|(])(\|\|\s*(true|:)|&&\s*false)(\s|;|$)/.test(line);
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
    // Over LOGICAL lines (comments cannot satisfy these) and by WHOLE
    // package token: `\btmux` matches across a hyphen, so a refactor to
    // `powerline-tmux` kept the pin green while installing no tmux.
    const installLines = logicalLinesOf(steps[install].run);
    for (const pkg of ['tmux', 'zip', 'unzip']) {
      expect(
        installLines.some((l) => installsPackage(l, pkg)),
        `no apt-get install of the exact package ${pkg}`,
      ).toBe(true);
    }
    // And it must really install: `-s`/`--download-only` and friends exit 0
    // having installed nothing, with no warning — the step stays green while
    // the real-tmux suite skips inside the required check.
    for (const line of installLines) {
      if (!/apt-get\s+install\b/.test(line)) continue;
      for (const token of line.split(/\s+/)) {
        expect(
          NO_OP_INSTALL_FLAGS.has(token),
          `${token} makes the install a no-op :: ${line}`,
        ).toBe(false);
      }
    }
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

  it('keeps the step BOUNDED and ADVISORY — the two step-level keys', () => {
    // The run script's own guards cannot save the check from a step-level
    // failure or a hang. Dropping continue-on-error reds the required Test
    // check when the 5-minute bound fires on a stalled mirror; dropping
    // timeout-minutes lets a dpkg lock block toward the job's 60-minute cap
    // with no test run. Both shipped 3/3 green before this pin.
    const install = steps[nameIndex(INSTALL)];
    expect(install['continue-on-error']).toBe(true);
    expect(install['timeout-minutes']).toBe(5);
  });

  it('keeps the install branch REACHABLE — the conditions, not just the lines', () => {
    // Mutations that leave every pinned line in place while making the
    // apt-get branch dead shipped green: `command -v tmux … || true` makes
    // the already-installed branch always taken, and `elif false && …`
    // kills the install branch outright. Either way tmux is never
    // installed and the real-tmux suite silently skips.
    const lines = logicalLinesOf(steps[nameIndex(INSTALL)].run);
    const ifLine = lines.find((l) => l.startsWith('if '));
    const elifLine = lines.find((l) => l.startsWith('elif '));
    expect(ifLine, 'no `if` line in the install step').toBeDefined();
    expect(elifLine, 'no `elif` line in the install step').toBeDefined();
    // The already-installed branch must test for ALL THREE tools with AND,
    // pinned whole: a prefix-only pin let a one-character `&&`→`||` typo
    // (`command -v tmux || command -v zip …`) take the branch on a lane
    // with zip but no tmux, killing the install with every pin green.
    expect(ifLine.replace(/\s+/g, ' ')).toBe(
      'if command -v tmux > /dev/null 2>&1 && command -v zip > /dev/null 2>&1 && command -v unzip > /dev/null 2>&1; then',
    );
    // Nothing may force either branch: a literal constant, or bash's null
    // command `:` — `command -v tmux || :` is permanently true.
    for (const line of [ifLine, elifLine]) {
      expect(hasForcingTerm(line), `forced condition :: ${line}`).toBe(false);
      expect(line, line).not.toMatch(/(^|\s)(true|false|:)\s*(&&|\|\||;)/);
    }
    // The install branch is guarded by the tools it needs, not by a
    // constant.
    expect(elifLine).toMatch(/command -v apt-get\b/);
    // And the ELSE fallback exists: on a lane with neither tmux nor
    // sudo+apt-get — a root-container self-hosted runner, the family this
    // PR's own evidence is produced on — it is the only signal that the
    // tooling is missing. Deleting it passed every other pin.
    const elseIdx = lines.findIndex((l) => l === 'else');
    expect(elseIdx, 'no `else` fallback branch').toBeGreaterThan(-1);
    expect(
      lines.slice(elseIdx + 1).some((l) => l.includes('::warning::')),
      'the else branch emits no ::warning:: annotation',
    ).toBe(true);
  });

  it('keeps the step advisory — no branch may fail the required check', () => {
    const run = steps[nameIndex(INSTALL)].run;
    const logicalLines = logicalLinesOf(run);
    for (const line of logicalLines) {
      // EVERY tmux -V invocation carries its own advisory guard — a bare
      // one in the already-installed branch reds the check on a broken-
      // but-installed tmux.
      if (/\btmux -V\b/.test(line)) {
        expect(line, line).toMatch(/tmux -V[^;&|]*\|\|\s*echo\b/);
      }
      // NOTHING may hard-fail the step: no statement may BE an exit/false
      // (including a subshell-wrapped one, whose status is the branch's),
      // and no `set` may enable errexit in any spelling or position.
      for (const stmt of statementsOf(line)) {
        expect(stmt, `${stmt} :: ${line}`).not.toMatch(
          /^(exit(\s+\d+)?|false)$/,
        );
        expect(enablesErrexit(stmt), `${stmt} :: ${line}`).toBe(false);
      }
      // Each apt-get invocation — behind any wrapper — must be guarded by
      // the very next control operator after it. Three probe-verified
      // escapes this closes: `|| echoX` (substring match, chain exits 127
      // with no annotation), `apt-get … | tee … || echo` (the `||` binds
      // to tee's zero status), and `apt-get …; : || echo` (it binds to a
      // different statement).
      let from = 0;
      for (;;) {
        const at = line.indexOf('apt-get', from);
        if (at === -1) break;
        from = at + 1;
        const stmt =
          line
            .slice(0, at)
            .split(/;|&&|\|\||\||&|\bthen\b|\belse\b|\bdo\b/)
            .pop() + 'apt-get';
        // isAptGet strips grouping punctuation and every wrapper (with its
        // options) before deciding — a `( sudo apt-get …` or a
        // `time sudo apt-get …` used to be misread as a mere mention and
        // skipped the guard requirement entirely.
        if (!isAptGet(stmt)) continue; // `command -v apt-get`, a message
        const rest = line.slice(at);
        // Walk the operators after this apt-get. `&&` is transparent — the
        // status of `A && B` is A's when A fails, so a later `|| echo`
        // still guards A. `;` starts a new statement and `|` makes the
        // status the pipeline's last command: either one ends the guard's
        // reach, and the apt-get is unguarded.
        let guarded = false;
        const ops = /(\|\||&&|;|\|)/g;
        for (let m = ops.exec(rest); m !== null; m = ops.exec(rest)) {
          if (m[1] === '&&') continue;
          guarded = m[1] === '||' && /^\|\|\s*echo\b/.test(rest.slice(m.index));
          break;
        }
        expect(guarded, `apt-get reaches no \`|| echo\` guard :: ${line}`).toBe(
          true,
        );
      }
      // EVERY message this step emits is an annotation. Keying on message
      // words pinned the wording, not the annotation: rewording an echo
      // while dropping `::warning::` escaped, and a lane where the install
      // permanently fails then hides the loss in a multi-thousand-line log
      // instead of showing it in the check UI.
      for (const stmt of statementsOf(line)) {
        if (/^echo\b/.test(stmt)) {
          expect(stmt, `echo without an annotation :: ${line}`).toContain(
            '::warning::',
          );
        }
      }
    }
  });
});
