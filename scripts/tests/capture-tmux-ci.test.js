/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';

// A tooling step that quietly stops installing is the same outage as no
// step at all, and it is INVISIBLE: the suites it feeds skip rather than
// fail. The zip half serves the install-script packaging suite; the tmux
// half is pre-landed for #8388, whose real-tmux suite is
// describe.skipIf(!hasTmux)-gated and would silently skip every behaviour
// it covers inside a green required check. Pin the step's existence, its
// condition, and its load-bearing properties.
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

// The statement with quoted spans blanked out, for questions about SHELL
// syntax (redirections): a `>` inside a warning message is message text,
// and matching it reddened semantics-preserving rewordings — the opposite
// of what the annotation pins are for.
function outsideQuotes(stmt) {
  let out = '';
  let quote = null;
  for (const c of stmt) {
    if (quote) {
      if (c === quote) quote = null;
      out += ' ';
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      out += ' ';
      continue;
    }
    out += c;
  }
  return out;
}

// The shell separator alphabet, defined ONCE. It was encoded three times —
// a quote-aware char loop, a quote-blind regex, and the guard walk's `ops`
// — and the copies had already drifted; a pin whose model of bash depends
// on which function you ask is not a model.
const SEPARATORS = /(\|\||&&|;|\||(?<!>)&(?!>))/;

// Does this statement reach its command through sudo? The wrappers stack
// (`timeout 280 sudo -n apt-get …`), so walk the same prefix unwrapCommand
// walks and look for sudo anywhere along it — requiring it FIRST would red
// a legitimately bounded install.
function runsThroughSudo(stmt) {
  let out = stmt.trim().replace(/^(\w+=\S+\s+)+/, '');
  for (;;) {
    if (/^sudo\b/.test(out)) return true;
    const next = out
      .replace(WRAPPERS, '')
      .replace(/^(-{1,2}[\w-]+(=\S+)?\s+)+/, '')
      .replace(/^(\d+[smhd]?\s+)/, '');
    if (next === out) return false;
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
// statements too — `sleep 1 & exit 1` is two commands.
// QUOTE-AWARE, like the line scanner: a `;` inside a warning message is
// message text, and splitting on it tore an `echo '…; …' > /dev/null` into
// fragments where the redirect no longer belonged to any echo — so the
// annotation pins never saw it.
function rawStatementsOf(line) {
  const parts = [];
  let cur = '';
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      cur += c;
      if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      cur += c;
      continue;
    }
    const two = line.slice(i, i + 2);
    if (two === '&&' || two === '||') {
      parts.push(cur);
      cur = '';
      i++;
      continue;
    }
    // `&` separates statements, EXCEPT in a redirection: `2>&1` (preceded
    // by `>`) and bash's `&>file` (followed by `>`). Splitting on the
    // latter tore `echo '::warning::…' &> /dev/null` into a clean echo and
    // an unchecked `> /dev/null`, so the annotation pins never saw the
    // redirect that silenced it.
    if (
      c === ';' ||
      c === '|' ||
      (c === '&' && line[i - 1] !== '>' && line[i + 1] !== '>')
    ) {
      parts.push(cur);
      cur = '';
      continue;
    }
    cur += c;
  }
  parts.push(cur);
  return (
    parts
      // Keyword boundaries only where no quoting is in play — inside a
      // message, `then` is a word.
      .flatMap((p) =>
        /['"]/.test(p) ? [p] : p.split(/\bthen\b|\belse\b|\bdo\b|\bfi\b/),
      )
      .map((x) => x.replace(/^[\s({]+/, '').replace(/[\s)}]+$/, ''))
      .filter(Boolean)
  );
}

// The same statements with their wrappers stripped. Split and unwrap are
// separate because some questions are about the wrapper itself — "does this
// install run through sudo?" cannot be asked of a statement sudo has
// already been removed from.
function statementsOf(line) {
  return rawStatementsOf(line).map(unwrapCommand).filter(Boolean);
}

// Does this `set` enable errexit? Any position, any spelling — `set -e`,
// clustered `set -euo pipefail`, `set -u -e`, `set -o errexit`,
// `set -o pipefail -e`. `set +e` DISABLES it and must not match, and
// `--` ends option parsing: `set -- -e` assigns `-e` as a positional
// parameter, it does not enable errexit.
function enablesErrexit(stmt) {
  return /^set\b.*?(\s-\w*e\w*|\s-o\s+errexit)(\s|$)/.test(
    stmt.split(/\s--(?:\s|$)/)[0],
  );
}

// Whether this argv-ish line installs the EXACT package, as a whole token:
// `\btmux` matches across a hyphen, so `powerline-tmux` satisfied a \b
// anchor while installing no tmux binary at all.
function installsPackage(line, pkg) {
  // Against the install STATEMENT's own arguments: matching the whole
  // logical line let a package dropped from the install survive as long as
  // its bare token appeared anywhere else on that line — in the guard's
  // warning message, for instance.
  return statementsOf(line).some(
    (stmt) =>
      isAptGet(stmt) &&
      /^apt-get\s+install\b/.test(unwrapCommand(stmt)) &&
      unwrapCommand(stmt).split(/\s+/).includes(pkg),
  );
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

// The same no-op modes reachable through apt's generic option override:
// `-o APT::Get::Simulate=true` is exactly what `-s` sets, and the token
// blacklist above cannot see it.
const NO_OP_INSTALL_OPTION =
  /(-o|--option)[\s=]*(APT::Get::)?(Simulate|Just-Print|Download-Only|Print-URIs|No-Act|Recon)\s*=\s*(true|1|yes|on|with|enable)/i;

// The same no-op modes as long options with a value (`--simulate=yes`), and
// the two flags that make apt print and exit without installing anything.
const NO_OP_INSTALL_LONG =
  /--(simulate|just-print|dry-run|recon|no-act|download-only|print-uris)(=(true|1|yes|on)|\b)|--(version|help)\b/i;

// Statements that HARD-FAIL the step, so nothing may BE one. `exit` and
// `false` were the known pair; `return` and `exec` are the same family
// under the runner's `bash -e` — `return 0` errors outside a function and
// `-e` makes that fatal before the first branch runs, `exec true` replaces
// the shell — and either one leaves the required check green with nothing
// installed and not even the else-branch warning emitted.
const HARD_FAIL = /^(exit(\s+\d+)?|false|return(\s+\d+)?|exec(\s.*)?)$/;

// A branch condition that can be satisfied without the tools it claims to
// test: a literal constant, or bash's null command `:` (status 0 always).
function hasForcingTerm(line) {
  return /(^|[\s;&|(])(\|\|\s*(true|:)|&&\s*false)(\s|;|$)/.test(line);
}

// The helpers above are the ORACLE every pin below reasons through: if
// they mismodel bash, the pins describe a script nothing runs. Each rule
// here was learned from a mutation that escaped an earlier version.
describe('the bash model these pins run on', () => {
  it('builds logical lines the way bash does', () => {
    // Continuations: only an ODD run of trailing backslashes continues.
    // `\<newline>` is removed; the space BEFORE the backslash survives.
    expect(logicalLinesOf('echo a \\\nb')).toEqual(['echo a b']);
    expect(logicalLinesOf('echo a \\\\\nexit 1')).toEqual([
      'echo a \\\\',
      'exit 1',
    ]);
    // A comment never continues, whatever it ends with.
    expect(logicalLinesOf('# note \\\nexit 1')).toEqual(['exit 1']);
    // A `#` opens a comment after whitespace or a metacharacter, and is
    // literal inside quotes.
    expect(logicalLinesOf('echo hi;#note')).toEqual(['echo hi;']);
    expect(logicalLinesOf("echo '::warning::a # b' && exit 1")).toEqual([
      "echo '::warning::a # b' && exit 1",
    ]);
    // A quoted string spanning a newline folds into one logical line, as
    // bash does (the model joins the fold with a space).
    expect(logicalLinesOf("echo 'a\nb'")).toEqual(["echo 'a b'"]);
  });

  it('splits statements on real separators only', () => {
    expect(statementsOf('sleep 1 & exit 1')).toEqual(['sleep 1', 'exit 1']);
    // Redirections are not separators, in either spelling.
    expect(statementsOf('cmd > /dev/null 2>&1 && next')).toEqual([
      'cmd > /dev/null 2>&1',
      'next',
    ]);
    expect(statementsOf("echo '::warning::x' &> /dev/null")).toEqual([
      "echo '::warning::x' &> /dev/null",
    ]);
    // A `;` inside a message is message text.
    expect(statementsOf("echo 'a; b'")).toEqual(["echo 'a; b'"]);
    // Grouping punctuation comes off: a subshell's exit is an exit.
    expect(statementsOf('if [ x ]; then (exit 1); fi')).toEqual([
      'if [ x ]',
      'exit 1',
    ]);
  });

  it('sees through wrappers to the command underneath', () => {
    expect(unwrapCommand('sudo -n apt-get install -y tmux')).toBe(
      'apt-get install -y tmux',
    );
    expect(unwrapCommand('timeout --signal=KILL 5 apt-get update')).toBe(
      'apt-get update',
    );
    expect(unwrapCommand('time sudo apt-get update')).toBe('apt-get update');
    // Nested wrappers with wrapper options, all stripped in one pass.
    expect(unwrapCommand('timeout -k 1 5 sudo apt-get update')).toBe(
      'apt-get update',
    );
    expect(unwrapCommand('DEBIAN_FRONTEND=noninteractive apt-get update')).toBe(
      'apt-get update',
    );
    // A MENTION is not an invocation.
    expect(isAptGet('command -v apt-get')).toBe(false);
    expect(isAptGet('( sudo apt-get install -y tmux')).toBe(true);
  });

  it('detects errexit in every spelling, and only when enabled', () => {
    for (const on of [
      'set -e',
      'set -euo pipefail',
      'set -u -e',
      'set -o errexit',
      'set -o pipefail -e',
      'set -o nounset -o errexit',
    ]) {
      expect(enablesErrexit(on), on).toBe(true);
    }
    for (const off of ['set +e', 'set -u', 'set -o pipefail', 'set -- -e']) {
      expect(enablesErrexit(off), off).toBe(false);
    }
  });

  it('matches packages as whole install arguments', () => {
    expect(installsPackage('sudo apt-get install -y tmux zip', 'tmux')).toBe(
      true,
    );
    expect(installsPackage('sudo apt-get install -y tmuxinator', 'tmux')).toBe(
      false,
    );
    expect(
      installsPackage('sudo apt-get install -y powerline-tmux', 'tmux'),
    ).toBe(false);
    // Not from the guard's message, only from the install's arguments.
    expect(
      installsPackage(
        "apt-get install -y zip || echo '::warning::tmux'",
        'tmux',
      ),
    ).toBe(false);
  });

  it('knows a forced condition, `:` included', () => {
    expect(hasForcingTerm('if command -v tmux || true; then')).toBe(true);
    expect(hasForcingTerm('if command -v tmux || :; then')).toBe(true);
    expect(hasForcingTerm('if command -v tmux && false; then')).toBe(true);
    expect(hasForcingTerm('if command -v tmux > /dev/null 2>&1; then')).toBe(
      false,
    );
  });

  it('blanks quoted spans before asking about shell syntax', () => {
    // A `>` inside a message is text; the one outside is a redirection.
    expect(outsideQuotes("echo '::warning::a > b'")).not.toMatch(/>/);
    expect(outsideQuotes("echo '::warning::a' > /dev/null")).toMatch(/>/);
  });
});

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
    // ...and AFTER the step whose output its `if:` reads. Above it, the
    // output is empty, the condition is false, and the step never runs —
    // the same silent skip, reached by moving rather than editing.
    const profile = steps.findIndex((st) => st.id === 'ci_profile');
    expect(profile, 'no ci_profile step').toBeGreaterThan(-1);
    expect(install).toBeGreaterThan(profile);
    // Over LOGICAL lines (comments cannot satisfy these) and by WHOLE
    // package token: `\btmux` matches across a hyphen, so a refactor to
    // `powerline-tmux` kept the pin green while installing no tmux.
    const installLines = logicalLinesOf(steps[install].run);
    for (const pkg of ['tmux', 'zip', 'unzip']) {
      expect(
        // Execution-aware, like the guard walk: a mere MENTION of an
        // install (inside an `echo '::warning::apt-get install tmux …'`)
        // satisfied a containment pin while the guard walker correctly
        // waived it as a message — the two pins disagreeing let a step that
        // installs NOTHING pass both.
        installLines.some(
          (l) =>
            statementsOf(l).some((stmt) => isAptGet(stmt)) &&
            installsPackage(l, pkg),
        ),
        `no apt-get install of the exact package ${pkg}`,
      ).toBe(true);
    }
    // The flags that make it work UNATTENDED: without -y apt-get prompts
    // and fails on a runner with no tty, and without root it cannot write
    // /var/lib/dpkg — both keep every structural pin green while installing
    // nothing. Checked PER install statement, not just the first: splitting
    // the install in two exempted the second from both requirements.
    // The step carries one install chain PER lane: a root branch (root
    // containers have no sudo and need none) and a sudo branch. Each branch
    // must install on ITS OWN — a chain that only lives in one branch
    // leaves the other lane with no tooling and every whole-step pin green.
    const elifIdxs = installLines
      .map((l, i) => (l.startsWith('elif ') ? i : -1))
      .filter((i) => i > -1);
    const elseLineIdx = installLines.findIndex((l) => l === 'else');
    expect(elifIdxs.length, 'expected the root and sudo install branches').toBe(
      2,
    );
    const statementsBetween = (from, to) =>
      installLines.slice(from + 1, to).flatMap((l) => rawStatementsOf(l));
    const branches = [
      {
        name: 'root',
        statements: statementsBetween(elifIdxs[0], elifIdxs[1]),
        throughSudo: false,
      },
      {
        name: 'sudo',
        statements: statementsBetween(elifIdxs[1], elseLineIdx),
        throughSudo: true,
      },
    ];
    for (const branch of branches) {
      const installStatements = branch.statements.filter((stmt) =>
        /^apt-get\s+install\b/.test(unwrapCommand(stmt)),
      );
      // EXACTLY one per branch: an always-failing `apt-get install`
      // prefixed in the same && chain short-circuits the real install, and
      // every per-statement pin binds to a statement on the line — none of
      // them sees the skip.
      expect(
        installStatements.length,
        `${branch.name} branch: expected exactly one apt-get install`,
      ).toBe(1);
      for (const stmt of installStatements) {
        expect(unwrapCommand(stmt).split(/\s+/), stmt).toContain('-y');
        // The sudo branch runs through sudo, in any of its spellings and
        // behind any other wrapper: `sudo -n apt-get` is the sibling
        // workflow's convention and `timeout 280 sudo -n apt-get` is what a
        // bounded install looks like. Requiring sudo FIRST would red both.
        // The root branch must NOT: root lanes may ship no sudo binary, so
        // a sudo-wrapped chain there exits 127, the guard fires, and
        // nothing installs.
        expect(
          runsThroughSudo(stmt),
          `${branch.name} branch: ${stmt} sudo expectation`,
        ).toBe(branch.throughSudo);
        expect(NO_OP_INSTALL_OPTION.test(stmt), `${stmt} simulates`).toBe(
          false,
        );
        expect(NO_OP_INSTALL_LONG.test(stmt), `${stmt} installs nothing`).toBe(
          false,
        );
      }
      // The index refresh the install depends on: without it a stale list
      // fails the install on a runner whose image is a few days old — and
      // it must come FIRST in the branch, or the install still reads the
      // stale list. Same sudo shape as the branch's install: without root
      // (or sudo) it cannot write the package lists it exists to refresh.
      const updateStatements = branch.statements.filter((stmt) =>
        /^apt-get\s+update\b/.test(unwrapCommand(stmt)),
      );
      expect(
        updateStatements.length,
        `${branch.name} branch: expected one apt-get update`,
      ).toBe(1);
      expect(
        branch.statements.indexOf(updateStatements[0]),
        `${branch.name} branch: apt-get update must come before the install`,
      ).toBeLessThan(branch.statements.indexOf(installStatements[0]));
      expect(
        runsThroughSudo(updateStatements[0]),
        `${branch.name} branch: ${updateStatements[0]} sudo expectation`,
      ).toBe(branch.throughSudo);
    }
    // Nothing foreign may sit on the install's chain: only apt-get calls
    // and the guard's echo, so no prefixed command can short-circuit it.
    for (const line of installLines) {
      if (!/apt-get\s+install\b/.test(line)) continue;
      for (const stmt of rawStatementsOf(line)) {
        const bare = unwrapCommand(stmt);
        // Subcommand too, not just the leading word: `apt-get remove -y
        // tmux` appended to the chain passed a word-only allowlist while
        // undoing the install it sits next to.
        expect(
          /^(apt-get\s+(update|install)\b|echo\b)/.test(bare),
          `${bare} shares the install chain`,
        ).toBe(true);
      }
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
    // The interpreter that parses the whole run block: every pin in this
    // file reasons in bash, and `shell: powershell` would leave them
    // describing a script nothing runs.
    expect(install['shell'] ?? 'bash').toMatch(/^bash/);
  });

  it('keeps the install branch REACHABLE — the conditions, not just the lines', () => {
    // Mutations that leave every pinned line in place while making the
    // apt-get branch dead shipped green: `command -v tmux … || true` makes
    // the already-installed branch always taken, and `elif false && …`
    // kills the install branch outright. Either way tmux is never
    // installed and the real-tmux suite silently skips.
    const lines = logicalLinesOf(steps[nameIndex(INSTALL)].run);
    const ifLine = lines.find((l) => l.startsWith('if '));
    const elifLines = lines.filter((l) => l.startsWith('elif '));
    expect(ifLine, 'no `if` line in the install step').toBeDefined();
    expect(
      elifLines.length,
      'expected the root and sudo install branches',
    ).toBe(2);
    // The already-installed branch must test for ALL THREE tools with AND,
    // pinned whole: a prefix-only pin let a one-character `&&`→`||` typo
    // (`command -v tmux || command -v zip …`) take the branch on a lane
    // with zip but no tmux, killing the install with every pin green.
    expect(ifLine.replace(/\s+/g, ' ')).toBe(
      'if command -v tmux > /dev/null 2>&1 && command -v zip > /dev/null 2>&1 && command -v unzip > /dev/null 2>&1; then',
    );
    // Nothing may force any branch: a literal constant, or bash's null
    // command `:` — `command -v tmux || :` is permanently true.
    for (const line of [ifLine, ...elifLines]) {
      expect(hasForcingTerm(line), `forced condition :: ${line}`).toBe(false);
      expect(line, line).not.toMatch(/(^|\s)(true|false|:)\s*(&&|\|\||;)/);
    }
    // The install branches are pinned WHOLE: a near-miss falsifier
    // (`elif false2 && …`, a command that does not exist and therefore
    // always fails) kills the branch while satisfying a containment pin
    // and the forcing-term blacklist alike. The root branch sits FIRST:
    // root-container lanes have no sudo, so their chain must not reach
    // for it, and the per-branch pins below bind each chain to its
    // position.
    expect(elifLines[0].replace(/\s+/g, ' ')).toBe(
      'elif [ "$(id -u)" = \'0\' ] && command -v apt-get > /dev/null 2>&1; then',
    );
    expect(elifLines[1].replace(/\s+/g, ' ')).toBe(
      'elif sudo -n true > /dev/null 2>&1 && command -v apt-get > /dev/null 2>&1; then',
    );
    // The already-installed branch is not empty either: it must verify the
    // tool it claims is present, advisorily. An emptied body (`:`) leaves a
    // broken-but-installed tmux undetected on the lane that takes it.
    const thenIdx = lines.findIndex((l) => l.startsWith('if '));
    const elifIdx = lines.findIndex((l) => l.startsWith('elif '));
    // ALL THREE tools, not just tmux: the branch is taken when each is
    // present, and a broken-but-present zip fails the packaging suite with
    // no warning to explain it. Each check carries its own advisory guard,
    // because a broken tool must not red the required check either.
    const thenBody = lines.slice(thenIdx + 1, elifIdx);
    // Word-anchored, because `unzip -v` CONTAINS `zip -v`: a substring
    // search reported the zip probe present after it had been deleted —
    // this pin's own first version passed that mutant for exactly that
    // reason.
    for (const probe of ['tmux -V', 'zip -v', 'unzip -v']) {
      const at = new RegExp(`(^|\\s)${probe.replace(' ', '\\s+')}\\b`);
      const line = thenBody.find((l) => at.test(l));
      expect(
        line,
        `the already-installed branch never runs ${probe}`,
      ).toBeDefined();
      expect(line, `${probe} is unguarded`).toMatch(/\|\|\s*echo\b/);
    }
    // And the ELSE fallback exists: on a lane with no usable install path
    // — no apt-get at all, and no passwordless sudo when running non-root
    // — it is the only signal that the tooling is missing. Deleting it
    // passed every other pin.
    const elseIdx = lines.findIndex((l) => l === 'else');
    expect(elseIdx, 'no `else` fallback branch').toBeGreaterThan(-1);
    // And the conditional is CLOSED: without `fi`, bash rejects the block
    // and the step runs nothing at all — which passed every other pin.
    expect(lines, 'the if/elif/else block is never closed').toContain('fi');
    expect(
      lines
        .slice(elseIdx + 1)
        .flatMap((l) => statementsOf(l))
        .some((stmt) => /^echo\b/.test(stmt) && stmt.includes('::warning::')),
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
      // NOTHING may hard-fail the step: no statement may BE one (including
      // a subshell-wrapped one, whose status is the branch's), and no `set`
      // may enable errexit in any spelling or position.
      for (const stmt of statementsOf(line)) {
        expect(HARD_FAIL.test(stmt), `${stmt} :: ${line}`).toBe(false);
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
            .split(
              new RegExp(`${SEPARATORS.source}|\\bthen\\b|\\belse\\b|\\bdo\\b`),
            )
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
        // The ONE alphabet, shared with statementsOf — `2>&1` and `&>` are
        // redirections, not separators, and a copy of this rule that drifts
        // from the other is how a guarded chain got misread as unguarded.
        const ops = new RegExp(SEPARATORS.source, 'g');
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
        if (!/^echo\b/.test(stmt)) continue;
        expect(stmt, `echo without an annotation :: ${line}`).toContain(
          '::warning::',
        );
        // A workflow command is only a command if the runner SEES it: the
        // runner parses stdout, so bytes sent to a file or /dev/null, or to
        // stderr, are just log noise — and `::warning::` must open the
        // line, since the runner does not scan mid-line.
        // The TARGET may be quoted (`>'/dev/null'`) — blanking quoted spans
        // leaves the operator, so match on the operator alone rather than
        // requiring a visible target after it.
        expect(
          outsideQuotes(stmt),
          `annotation redirected away :: ${line}`,
        ).not.toMatch(/\d?>(>|&\d)?/);
        expect(stmt, `annotation not at line start :: ${line}`).toMatch(
          /^echo\s+(-[a-zA-Z]+\s+)*['"]?::warning::/,
        );
      }
    }
  });

  it('catches a hard-fail statement spliced into the step', () => {
    // The axis HARD_FAIL pins, end to end: splice one in as the first run
    // line and the oracle must surface it as a statement. Under the runner's
    // `bash -e` either one kills the step before its first branch — a green
    // check with nothing installed and no ::warning:: anywhere.
    const run = steps[nameIndex(INSTALL)].run;
    for (const splice of ['return 0', 'exec true']) {
      const stmts = logicalLinesOf(splice + '\n' + run).flatMap((l) =>
        statementsOf(l),
      );
      expect(
        stmts.some((s) => HARD_FAIL.test(s)),
        splice,
      ).toBe(true);
    }
  });
});
