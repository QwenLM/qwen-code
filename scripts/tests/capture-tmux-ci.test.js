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
// the pins run on the text bash actually executes. Four rules the previous
// line-at-a-time version got wrong, each probe-verified against bash:
//   - a `#` inside quotes is LITERAL, not a comment (a stripped quoted `#`
//     hid a trailing `&& exit 1` from every advisory pin);
//   - only an ODD run of trailing backslashes continues a line (`\\` is an
//     escaped backslash, and the following line is its own command);
//   - a COMMENT never continues, whatever it ends with (`# note \` followed
//     by `exit 1` leaves the exit as its own logical line);
//   - an incomplete LIST continues: a line ending in `&&`, `||` or a bare
//     pipeline `|` joins the next physical line at runtime (a trailing `&`
//     backgrounds, no join).
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
    // The fourth continuation: outside quotes and comments, a line whose
    // last token is `&&`, `||`, or a bare pipeline `|` is an incomplete
    // list — bash splices the next physical line into it. A lone trailing
    // `&` is the background separator and does not continue.
    if (!quote && !pending) {
      const tail = cur.replace(/\s+$/, '');
      if (tail.endsWith('|') || tail.endsWith('&&')) {
        cur = `${tail} `;
        pending = true;
      }
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

// ONE prefix per call, in shell order: a run of env assignments, one
// wrapper verb, the options that verb takes, then the bare duration.
// unwrapCommand loops it to the fixpoint; runsThroughSudo tests for sudo
// between removals — sudo must be observable the moment it is exposed, or
// the next env assignment lets it slip past unseen. Two copies of this
// pipeline had already drifted (the env strip inside one fixpoint, once up
// front in the other), and the sudo expectation disagreed with the install
// pins on where the command starts.
function stripPrefixLayer(stmt) {
  if (/^\w+=\S+\s+/.test(stmt)) return stmt.replace(/^(\w+=\S+\s+)+/, '');
  if (WRAPPERS.test(stmt)) return stmt.replace(WRAPPERS, '');
  // Options belonging to the wrapper just stripped, plus the bare
  // duration `timeout`/`nice` take before the command word.
  if (/^-{1,2}[\w-]+(=\S+)?\s+/.test(stmt))
    return stmt.replace(/^(-{1,2}[\w-]+(=\S+)?\s+)+/, '');
  if (/^\d+[smhd]?\s+/.test(stmt)) return stmt.replace(/^(\d+[smhd]?\s+)/, '');
  return stmt;
}

function unwrapCommand(stmt) {
  let out = stmt.trim();
  for (;;) {
    const next = stripPrefixLayer(out);
    if (next === out) return out;
    out = next;
  }
}

// The env assignments the prefix layers expose, at EVERY layer — `FOO=1
// cmd` and `timeout 5 env BAR=2 cmd` alike. They ride the prefix the NO_OP
// checks cannot see, and APT_CONFIG among them turns the install into a
// no-op with every other pin green.
function envAssignmentsOf(stmt) {
  const envs = [];
  let out = stmt.trim();
  for (;;) {
    for (;;) {
      const m = out.match(/^(\w+=\S+)\s+/);
      if (!m) break;
      envs.push(m[1]);
      out = out.slice(m[0].length);
    }
    const next = stripPrefixLayer(out);
    if (next === out) return envs;
    out = next;
  }
}

// The worst-case wall-clock seconds `timeout` bounds this statement with —
// null when it carries no `timeout` wrapper. The main duration PLUS any
// `-k/--kill-after` value: a TERM-ignoring process only dies on the
// follow-up signal, running duration + kill-after (measured on GNU
// coreutils 9.4: `timeout -k 2 1` → 3.00 s wall) — a budget that summed
// durations alone undercounted every kill-after by its own value. Speaks
// the same grammar unwrapCommand strips: options before the bare duration,
// attached (`--signal=KILL`) or as the next token (`-k 9`), and the
// duration's optional s/m/h/d suffix.
const TIMEOUT_UNITS = { s: 1, m: 60, h: 3600, d: 86400 };
function timeoutSeconds(stmt) {
  const tokens = stmt.trim().split(/\s+/);
  if (tokens[0] !== 'timeout') return null;
  let i = 1;
  let killAfter = 0;
  while (i < tokens.length && tokens[i].startsWith('-')) {
    // -k/--kill-after consumes the next token as its value (or carries it
    // attached, `--kill-after=9`); -s/--signal likewise; every other
    // option stands alone. The kill-after seconds are WORST CASE too: a
    // TERM-ignoring process runs duration + kill-after before KILL lands.
    let value;
    if (/^--?(kill-after|k)$/.test(tokens[i])) {
      value = tokens[i + 1];
      i += 2;
    } else if (/^--kill-after=\S+$/.test(tokens[i])) {
      value = tokens[i].split('=')[1];
      i += 1;
    } else {
      i += /^--?(signal|s)$/.test(tokens[i]) ? 2 : 1;
      continue;
    }
    const k = value?.match(/^(\d+(?:\.\d+)?)([smhd])?$/);
    if (k) killAfter = Number(k[1]) * (TIMEOUT_UNITS[k[2]] ?? 1);
  }
  const m = tokens[i]?.match(/^(\d+(?:\.\d+)?)([smhd])?$/);
  return m ? Number(m[1]) * (TIMEOUT_UNITS[m[2]] ?? 1) + killAfter : null;
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

// The statement with its single-quoted spans blanked — for asking what
// bash still EXPANDS there: single quotes are inert, but double-quoted
// spans stay live, because bash executes `"$(…)"` while building argv.
function outsideSingleQuotes(stmt) {
  let out = '';
  let quote = null;
  for (const c of stmt) {
    if (quote === "'") {
      if (c === "'") quote = null;
      out += ' ';
      continue;
    }
    if (quote === '"') {
      if (c === '"') quote = null;
      else out += c;
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

// Expansion syntax bash EXECUTES while building argv — command
// substitution, backticks, and process substitution in either direction.
// `<(` carries no `>`, so the redirect pin cannot see a payload hidden in
// it, and a `$(…)` in the guard's own message runs while the annotation
// is still visibly emitted.
const RUNTIME_EXPANSION = /\$\(|`|<\(|>\(/;

// The shell separator alphabet for QUOTE-BLIND questions (the guard walk
// below). rawStatementsOf's char loop mirrors the same alphabet quote-
// aware — the two encodings are NOT shared and must stay in sync; they
// drifted once before, and a pin whose model of bash depends on which
// function you ask is not a model.
const SEPARATORS = /(\|\||&&|;|\||(?<!>)&(?!>))/;

// Does this statement reach its command through sudo? The wrappers stack
// (`timeout 280 sudo -n apt-get …`), so walk the same prefix unwrapCommand
// walks and look for sudo anywhere along it — requiring it FIRST would red
// a legitimately bounded install.
function runsThroughSudo(stmt) {
  let out = stmt.trim();
  for (;;) {
    if (/^sudo\b/.test(out)) return true;
    const next = stripPrefixLayer(out);
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
      // A backslash-escaped quote inside double quotes is literal text,
      // not the string's end — closing there re-opens a phantom quote that
      // swallows every separator after it. Single quotes have no escapes.
      // Mirrors logicalLinesOf's double-quote rule.
      if (quote === '"' && c === '\\' && i + 1 < line.length) {
        cur += c + line[++i];
        continue;
      }
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

// Whether one install argument names the EXACT package: apt's documented
// `pkg=version` and `pkg:arch` qualifications install that package and
// nothing else — rejecting them reddened a version-pinned install of the
// very same package. Near-misses stay caught: `powerline-tmux=1.0` starts
// with neither `tmux=` nor `tmux:`.
function isPackageToken(token, pkg) {
  return (
    token === pkg || token.startsWith(`${pkg}=`) || token.startsWith(`${pkg}:`)
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
      unwrapCommand(stmt)
        .split(/\s+/)
        .some((t) => isPackageToken(t, pkg)),
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
  // The short forms of --help and --version: apt PRINTS and exits 0
  // without installing anything, from any argument position.
  '-h',
  '-v',
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

// The same no-op modes hidden in apt's getopt short-flag clustering — the
// shipped step's own `-qq` (= `-q -q`) proves apt parses clusters, so
// `-qs` is `-q -s`: simulate, exit 0, nothing installed. apt-get install
// uses the short letters s/d for nothing but simulate/download-only, and
// package arguments never start with `-`.
const NO_OP_INSTALL_CLUSTER = /^-\w*[sd]\w*$/;

// The only env assignments that may qualify an apt call: DEBIAN_FRONTEND
// and the locale variables change how apt prompts and prints, never WHAT
// it installs. Anything else rides the prefix the NO_OP checks cannot see.
const SAFE_APT_ENV = /^(DEBIAN_FRONTEND|LC_ALL|LANG)=/;

// Statements that HARD-FAIL the step, so nothing may BE one. `exit` and
// `false` were the known pair; `return` and `exec` are the same family
// under the runner's `bash -e` — `return 0` errors outside a function and
// `-e` makes that fatal before the first branch runs, `exec true` replaces
// the shell — and either one leaves the required check green with nothing
// installed and not even the else-branch warning emitted. The argument
// does not save it: `exit $?` exits 0 at step top (the prior status) and
// `exit foo` errors to a status continue-on-error absorbs — both silent.
const HARD_FAIL = /^(exit(\s.*)?|false|return(\s.*)?|exec(\s.*)?)$/;

// The only statements a branch body may execute: the apt calls, the
// guard/fallback echoes, and the three already-installed probes (each
// pinned as an invocation elsewhere). Anything else there executes
// unpinned — a wrapper-shadowing function, a budget-eating sleep, an EXIT
// trap, a self-kill — silent, green, unannotated. `(\s|$)` after the probe
// flags: `tmux -V(` is a function definition, not a probe.
const BRANCH_STATEMENT =
  /^(apt-get\s+(update|install)\b|echo\b|(tmux|zip|unzip)\s+-(V|v)(\s|$))/;

// A branch condition that can be satisfied without the tools it claims to
// test: a literal constant, or bash's null command `:` (status 0 always).
function hasForcingTerm(line) {
  return /(^|[\s;&|(])(\|\|\s*(true|:)|&&\s*false)(\s|;|$)/.test(line);
}

// A constant as the condition's COMMAND — `elif true && …`, `if :; then`,
// `if command -v tmux; true; then` (the condition list's status is the
// LAST command's). Command position is the first word of each &&/||/;
// segment, after env assignments and the condition keyword: matching any
// whitespace position caught `sudo -n true` — the passwordless-sudo probe,
// where `true` is an ARGUMENT of sudo — and reddened a semantics-
// preserving rewording of the shipped elif. Split the QUOTE-BLANKED line,
// like the rest of this file: a separator inside a quoted word is text.
function hasConstantCommand(line) {
  return outsideQuotes(line)
    .split(/&&|\|\||;/)
    .some((segment) =>
      /^(true|false|:)(\s|$)/.test(
        segment
          .trim()
          .replace(/^(if|elif|while|until)\s+/, '')
          .replace(/^(\w+=\S+\s+)+/, ''),
      ),
    );
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
    // An incomplete LIST continues: a trailing `&&`, `||`, or bare `|`
    // joins the next physical line; a trailing `&` backgrounds, no join.
    expect(logicalLinesOf('echo a &&\nexit 1')).toEqual(['echo a && exit 1']);
    expect(logicalLinesOf('echo a ||\nexit 1')).toEqual(['echo a || exit 1']);
    expect(logicalLinesOf('echo a |\nwc -c')).toEqual(['echo a | wc -c']);
    expect(logicalLinesOf('sleep 1 &\nexit 1')).toEqual([
      'sleep 1 &',
      'exit 1',
    ]);
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
    // A backslash-escaped quote inside double quotes is literal text, not
    // the string's end — closing there re-opens a phantom quote that
    // swallowed every separator after it.
    expect(statementsOf('echo "a\\" b" && rm -rf x')).toEqual([
      'echo "a\\" b"',
      'rm -rf x',
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
    // apt's qualification forms install the exact package; a near-miss
    // keeps failing under them too.
    expect(
      installsPackage('sudo apt-get install -y tmux=1:3.5-1build1', 'tmux'),
    ).toBe(true);
    expect(installsPackage('sudo apt-get install -y tmux:amd64', 'tmux')).toBe(
      true,
    );
    expect(
      installsPackage('sudo apt-get install -y powerline-tmux=1.0', 'tmux'),
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

  it('finds sudo at any wrapper layer, env assignments included', () => {
    expect(runsThroughSudo('timeout 140 sudo -n apt-get update')).toBe(true);
    expect(
      runsThroughSudo('FOO=1 nice -n 10 BAR=2 sudo apt-get install -y tmux'),
    ).toBe(true);
    expect(
      runsThroughSudo(
        'timeout 140 DEBIAN_FRONTEND=noninteractive sudo -n apt-get install -y tmux',
      ),
    ).toBe(true);
    expect(runsThroughSudo('timeout 140 apt-get update')).toBe(false);
  });

  it('reads a timeout bound in the wrapper grammar', () => {
    expect(timeoutSeconds('timeout 140 apt-get update -qq')).toBe(140);
    expect(timeoutSeconds('timeout 140s apt-get update -qq')).toBe(140);
    expect(timeoutSeconds('timeout 2m apt-get update -qq')).toBe(120);
    // Worst case is duration PLUS kill-after: `timeout -k 9 140` can run
    // 149 s wall against a TERM-ignoring process.
    expect(timeoutSeconds('timeout -k 9 140 apt-get update -qq')).toBe(149);
    expect(timeoutSeconds('timeout --kill-after=100 140 apt-get update')).toBe(
      240,
    );
    expect(timeoutSeconds('timeout --signal=KILL 5 apt-get update')).toBe(5);
    expect(timeoutSeconds('timeout 0 apt-get update')).toBe(0);
    expect(timeoutSeconds('apt-get update')).toBe(null);
  });

  it('collects env assignments at every prefix layer', () => {
    expect(
      envAssignmentsOf(
        'timeout 140 env APT_CONFIG=/tmp/sim.conf apt-get install -y tmux',
      ),
    ).toEqual(['APT_CONFIG=/tmp/sim.conf']);
    expect(
      envAssignmentsOf('DEBIAN_FRONTEND=noninteractive apt-get update'),
    ).toEqual(['DEBIAN_FRONTEND=noninteractive']);
    expect(envAssignmentsOf('timeout 140 apt-get update')).toEqual([]);
  });

  it('anchors a constant condition to command position', () => {
    expect(hasConstantCommand('elif true && command -v apt-get; then')).toBe(
      true,
    );
    expect(hasConstantCommand('if :; then')).toBe(true);
    expect(hasConstantCommand('if command -v tmux; true; then')).toBe(true);
    expect(
      hasConstantCommand('elif sudo -n true && command -v apt-get; then'),
    ).toBe(false);
    expect(
      hasConstantCommand('if command -v tmux > /dev/null 2>&1; then'),
    ).toBe(false);
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
    // The budget the inner apt bounds must collectively stay under —
    // when the step-level timeout fires there is no `|| echo`, so a chain
    // that can outlast it loses the lane its tooling with no annotation.
    const stepBudget = steps[install]['timeout-minutes'] * 60;
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
      // WHICH packages too: the step-wide pin above is satisfied when ONE
      // branch installs all three and the other installs nothing — and
      // each branch must install on ITS OWN.
      for (const pkg of ['tmux', 'zip', 'unzip']) {
        expect(
          installStatements.some((s) =>
            unwrapCommand(s)
              .split(/\s+/)
              .some((t) => isPackageToken(t, pkg)),
          ),
          `${branch.name} branch does not install ${pkg}`,
        ).toBe(true);
      }
      for (const stmt of installStatements) {
        expect(unwrapCommand(stmt).split(/\s+/), stmt).toContain('-y');
        // The sudo branch runs through sudo, in any of its spellings and
        // behind any other wrapper: `sudo -n apt-get` is the sibling
        // workflow's convention and `timeout 140 sudo -n apt-get` is what a
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
      // Each apt call is wrapped in its OWN timeout — `unwrapCommand`
      // strips it, so ask the RAW statement — and the branch's bounds
      // together stay under the step budget, or the guard never runs.
      let innerTotal = 0;
      for (const stmt of branch.statements.filter((s) => isAptGet(s))) {
        const bound = timeoutSeconds(
          // See through the env prefix the env pin below allows:
          // `DEBIAN_FRONTEND=noninteractive timeout 140 …` is bounded at
          // 140 exactly like the bare form.
          stmt.replace(/^(\w+=\S+\s+)+/, ''),
        );
        expect(
          bound,
          `${branch.name} branch: ${stmt} carries no inner bound`,
        ).not.toBeNull();
        // GNU `timeout 0` DISABLES the bound — the command runs unbounded.
        expect(
          bound,
          `${branch.name} branch: ${stmt} bound is zero, which disables it`,
        ).toBeGreaterThan(0);
        innerTotal += bound;
      }
      expect(
        innerTotal,
        `${branch.name} branch: inner bounds outlast the step budget`,
      ).toBeLessThan(stepBudget);
      // The env assignments the unwrap strips ride the prefix no NO_OP
      // check can see: APT_CONFIG pointing at a simulate config turns the
      // install into a no-op with every other pin green. Only variables
      // that cannot change WHAT apt installs may ride there — at any
      // layer, since `timeout 140 env VAR=x apt-get` buries them one in.
      for (const stmt of branch.statements.filter((s) => isAptGet(s))) {
        for (const env of envAssignmentsOf(stmt)) {
          expect(
            SAFE_APT_ENV.test(env),
            `${branch.name} branch: ${env} qualifies ${stmt}`,
          ).toBe(true);
        }
      }
    }
    // Nothing foreign may EXECUTE anywhere in the step: allowlist every
    // statement of every branch body. Nothing else pins the bodies' other
    // statements — `function timeout { :; }` shadows the chain's wrapper
    // into a no-op, `sleep 295` eats the step budget before apt starts,
    // `trap 'rm …' EXIT` defers deletion past a fully green step, and
    // `kill -9 $$` SIGKILLs the runner shell: silent, green, unannotated.
    // (Statements before the `if` and after the `fi` are closed by the
    // boundary pins; the branch conditions are pinned whole, verbatim.)
    const ifIdx = installLines.findIndex((l) => l.startsWith('if '));
    const fiIdx = installLines.findIndex((l) => l === 'fi');
    const bodies = [
      { name: 'already-installed', from: ifIdx, to: elifIdxs[0] },
      { name: 'root', from: elifIdxs[0], to: elifIdxs[1] },
      { name: 'sudo', from: elifIdxs[1], to: elseLineIdx },
      {
        name: 'else',
        from: elseLineIdx,
        to: fiIdx === -1 ? installLines.length : fiIdx,
      },
    ];
    for (const body of bodies) {
      for (const stmt of statementsBetween(body.from, body.to).map(
        unwrapCommand,
      )) {
        // Subcommand and shape alike: `apt-get remove` is not an install,
        // `echo() {…;}` is not an echo.
        expect(
          BRANCH_STATEMENT.test(stmt),
          `${body.name} branch executes ${stmt}`,
        ).toBe(true);
        // Interior grouping is a function definition or a syntax error —
        // either executes nothing the pins describe. Leading/trailing
        // grouping already came off in the unwrap.
        expect(
          outsideQuotes(stmt),
          `${stmt} smuggles grouping into the ${body.name} branch`,
        ).not.toMatch(/[()]/);
        // Expansion syntax bash runs while building argv — including
        // inside the guard's own message: the offending statement IS the
        // allowlisted echo.
        expect(
          RUNTIME_EXPANSION.test(outsideSingleQuotes(stmt)),
          `runtime expansion in the ${body.name} branch :: ${stmt}`,
        ).toBe(false);
      }
    }
    // And it must really install: `-s`/`--download-only` and friends exit 0
    // having installed nothing, with no warning — the step stays green while
    // the real-tmux suite skips inside the required check. On the install
    // STATEMENT's own tokens, not the whole logical line: the guard's
    // quoted message shares the line, and a rewording that mentions `-s`
    // in it reddened this pin while the install itself stayed clean.
    for (const line of installLines) {
      for (const stmt of statementsOf(line)) {
        if (!/^apt-get\s+install\b/.test(stmt)) continue;
        for (const token of stmt.split(/\s+/)) {
          expect(
            NO_OP_INSTALL_FLAGS.has(token) || NO_OP_INSTALL_CLUSTER.test(token),
            `${token} makes the install a no-op :: ${line}`,
          ).toBe(false);
          // A no-op flag smuggled through expansion (`EVIL=--simulate` +
          // `… $EVIL`) is invisible as a literal token — reject the
          // indirection itself; the shipped install takes no variables.
          expect(
            /[$`]/.test(token),
            `runtime indirection in install argument :: ${token}`,
          ).toBe(false);
        }
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
    // describing a script nothing runs. A step with no `shell:` key
    // inherits defaults.run.shell, so follow GitHub's resolution chain —
    // a literal fallback let a pwsh default pass while PowerShell parsed
    // the block and the script died before its first branch.
    expect(install['shell'] ?? doc.defaults?.run?.shell ?? 'bash').toMatch(
      /^bash/,
    );
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
      expect(
        hasConstantCommand(line),
        `constant as the branch condition :: ${line}`,
      ).toBe(false);
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
      // As an INVOCATION, not a mention: the probe must BE a statement's
      // command — an echo that merely names the probe in its message
      // satisfied the old text anchor while the probe never ran.
      const at = new RegExp(`^${probe.replace(' ', '\\s+')}(\\s|$)`);
      const line = thenBody.find((l) =>
        statementsOf(l).some((s) => at.test(s)),
      );
      expect(
        line,
        `the already-installed branch never runs ${probe}`,
      ).toBeDefined();
      expect(line, `${probe} is unguarded`).toMatch(/\|\|\s*(?:\{\s*)?echo\b/);
    }
    // And the ELSE fallback exists: on a lane with no usable install path
    // — no apt-get at all, and no passwordless sudo when running non-root
    // — it is the only signal that the tooling is missing. Deleting it
    // passed every other pin.
    const elseIdx = lines.findIndex((l) => l === 'else');
    expect(elseIdx, 'no `else` fallback branch').toBeGreaterThan(-1);
    // And the conditional is CLOSED and BOUNDED: without `fi`, bash
    // rejects the block and the step runs nothing at all — which passed
    // every other pin. EXACTLY one `fi`, and nothing outside it: a stray
    // second `fi` is a syntax error the runner absorbs, and a statement
    // before the `if` or after the `fi` executes where no pin looks.
    expect(
      lines.filter((l) => l === 'fi').length,
      'expected exactly one fi closing the block',
    ).toBe(1);
    expect(
      lines[lines.length - 1],
      'statements may follow the closing fi',
    ).toBe('fi');
    expect(lines[0], 'statements may precede the if').toBe(ifLine);
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
        expect(line, line).toMatch(/tmux -V[^;&|]*\|\|\s*(?:\{\s*)?echo\b/);
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
        // An apt-get INSIDE the guard's quoted message is message text:
        // outsideQuotes blanks quoted spans while preserving offsets, so a
        // blanked span at this offset is a mention, not an invocation.
        if (
          outsideQuotes(line)
            .slice(at, at + 7)
            .trim() === ''
        )
          continue;
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
        // SEPARATORS again — rawStatementsOf's quote-aware char loop
        // mirrors the same alphabet (the two are not shared; keep them in
        // sync). `2>&1` and `&>` are redirections, not separators, and a
        // copy of this rule that drifts from the other is how a guarded
        // chain got misread as unguarded.
        const ops = new RegExp(SEPARATORS.source, 'g');
        for (let m = ops.exec(rest); m !== null; m = ops.exec(rest)) {
          if (m[1] === '&&') continue;
          guarded =
            m[1] === '||' &&
            /^\|\|\s*(?:\{\s*)?echo\b/.test(rest.slice(m.index));
          break;
        }
        expect(guarded, `apt-get reaches no \`|| echo\` guard :: ${line}`).toBe(
          true,
        );
      }
      // An annotation the runner never SEES is none at all: piped to a
      // sink, the echo's stdout never reaches the runner — it parses
      // workflow commands from stdout only. No statement-level pin can see
      // the pipe (rawStatementsOf splits on it), so ask the logical line:
      // the echo must be pipeline-terminal. `||` is not a pipe; the
      // guard's second `|` satisfies the prefix.
      if (
        statementsOf(line).some(
          (s) => /^echo\b/.test(s) && s.includes('::warning::'),
        )
      ) {
        expect(
          /(^|\|)\s*(?:\{\s*)?echo\b[^|]*$/.test(outsideQuotes(line)),
          `annotation piped to a sink :: ${line}`,
        ).toBe(true);
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
    // `bash -e` any one kills the step before its first branch — a green
    // check with nothing installed and no ::warning:: anywhere.
    const run = steps[nameIndex(INSTALL)].run;
    for (const splice of ['return 0', 'exec true', 'exit $?']) {
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
