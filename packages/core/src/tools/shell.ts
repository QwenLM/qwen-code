/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import * as childProcess from 'node:child_process';
import type { Config } from '../config/config.js';
import { ToolNames, ToolDisplayNames } from './tool-names.js';
import { ToolErrorType } from './tool-error.js';
import type {
  ToolInvocation,
  ToolResult,
  ToolResultDisplay,
  ToolCallConfirmationDetails,
  ToolExecuteConfirmationDetails,
  ToolConfirmationPayload,
  ToolConfirmationOutcome,
} from './tools.js';
import type { PermissionDecision } from '../permissions/types.js';
import { BaseDeclarativeTool, BaseToolInvocation, Kind } from './tools.js';
import { getErrorMessage } from '../utils/errors.js';
import { truncateToolOutput } from '../utils/truncation.js';
import {
  CommitAttributionService,
  type StagedFileInfo,
} from '../services/commitAttribution.js';
import { buildGitNotesCommand } from '../services/attributionTrailer.js';
import type {
  ShellExecutionConfig,
  ShellExecutionResult,
  ShellOutputEvent,
} from '../services/shellExecutionService.js';
import { ShellExecutionService } from '../services/shellExecutionService.js';
import type { BackgroundShellEntry } from '../services/backgroundShellRegistry.js';
import stripAnsi from 'strip-ansi';
import { formatMemoryUsage } from '../utils/formatters.js';
import type { AnsiOutput } from '../utils/terminalSerializer.js';
import { isSubpaths } from '../utils/paths.js';
import {
  getCommandRoot,
  getCommandRoots,
  getShellConfiguration,
  splitCommands,
  stripShellWrapper,
} from '../utils/shell-utils.js';
import { parse } from 'shell-quote';
import { createDebugLogger } from '../utils/debugLogger.js';
import {
  isShellCommandReadOnlyAST,
  extractCommandRules,
} from '../utils/shellAstParser.js';

const debugLogger = createDebugLogger('SHELL');

/**
 * Strip a single bare trailing `&` (bash background operator) from a
 * command string. Returns the input unchanged if the trailing form is
 * `&&` (logical AND), `\&` (escaped literal `&`), or there is no `&`
 * at the end at all. Linear time, no regex backtracking risk.
 */
function stripTrailingBackgroundAmp(command: string): string {
  const trimmed = command.trimEnd();
  if (!trimmed.endsWith('&')) return command;
  if (trimmed.endsWith('&&')) return command;
  if (trimmed.endsWith('\\&')) return command;
  return trimmed.slice(0, -1).trimEnd();
}

/**
 * Escape `s` so it is safe to interpolate inside a bash double-quoted
 * string. Inside `"..."`, bash still interprets `$`, backtick, `\`, and
 * `"`; escape those four. Newlines and other characters are literal.
 */
function escapeForBashDoubleQuote(s: string): string {
  return s.replace(/[\\"$`]/g, '\\$&');
}

/**
 * Escape `s` so it is safe to interpolate inside a bash single-quoted
 * string. Bash single quotes have no escape mechanism — the standard
 * trick is to close the quote, emit a backslash-escaped `'`, and reopen.
 */
function escapeForBashSingleQuote(s: string): string {
  return s.replace(/'/g, "'\\''");
}

/**
 * Return the LAST match from a RegExp.matchAll iterator, or `null` if
 * the iterator is empty. Used to find the final `-m` / `--body` flag
 * in a command segment: git/gh both honour the LAST occurrence when
 * multiple are passed, so the trailer has to land in that match to be
 * picked up by the actual commit / PR body.
 */
function lastMatchOf<T extends RegExpMatchArray>(
  matches: IterableIterator<T>,
): T | null {
  let result: T | null = null;
  for (const m of matches) result = m;
  return result;
}

/**
 * Return the position of the first unquoted `#` (start-of-comment) in
 * `s`, or -1 if none. Bash treats `#` as a comment marker only when it
 * begins a word — at start of input or preceded by whitespace — and
 * not when it appears inside a single- or double-quoted region. This
 * mirrors that semantics so the `-m` / `--body` rewriters can scope
 * their regex to the pre-comment part of a segment and avoid splicing
 * the trailer into a comment-out flag like
 * `git commit -m "real" # -m "fake"`, where the actual commit gets
 * "real" but `lastMatchOf` would otherwise pick the comment's `-m
 * "fake"` and put the trailer there.
 */
function findUnquotedCommentStart(s: string): number {
  let inSingle = false;
  let inDouble = false;
  let i = 0;
  while (i < s.length) {
    const c = s[i]!;
    if (c === '\\' && !inSingle && i + 1 < s.length) {
      i += 2;
      continue;
    }
    if (c === "'" && !inDouble) {
      inSingle = !inSingle;
      i++;
      continue;
    }
    if (c === '"' && !inSingle) {
      inDouble = !inDouble;
      i++;
      continue;
    }
    if (c === '#' && !inSingle && !inDouble) {
      const prev = i === 0 ? '' : s[i - 1]!;
      if (prev === '' || /\s/.test(prev)) return i;
    }
    i++;
  }
  return -1;
}

/**
 * Helpers for the nested-match-rejection logic shared between
 * addCoAuthorToGitCommit and addAttributionToPR. Both functions pick
 * the LAST `-m` / `--body` occurrence across two quote styles, but
 * have to reject a candidate that's nested INSIDE the other's range
 * — e.g. `git commit -m "docs mention -m 'flag'"` where the inner
 * `-m 'flag'` lives entirely inside the outer `-m "..."`. Without
 * the nesting check the inner (later) match would win and the
 * trailer would land in the body text.
 *
 * Extracted to module scope so future bug fixes can't apply to only
 * one of the two call sites.
 */
function matchSpan(
  m: RegExpMatchArray | null,
): { start: number; end: number } | null {
  return m ? { start: m.index ?? 0, end: (m.index ?? 0) + m[0].length } : null;
}

function isMatchInside(
  inner: RegExpMatchArray | null,
  outer: RegExpMatchArray | null,
): boolean {
  const i = matchSpan(inner);
  const o = matchSpan(outer);
  return !!(i && o && i.start >= o.start && i.end <= o.end);
}

/**
 * Pick the LAST non-nested match across two quote styles. Mirrors the
 * algorithm both rewriters use: prefer whichever appears later in the
 * segment, but if either match lives inside the other's range, take
 * the OUTER one. Returns the chosen match plus a marker telling the
 * caller which style won (so they can pick the right escape function).
 */
function pickOuterLastMatch<T extends RegExpMatchArray | null>(
  doubleMatch: T,
  singleMatch: T,
): { match: T; isDouble: boolean } {
  if (doubleMatch && singleMatch) {
    if (isMatchInside(singleMatch, doubleMatch)) {
      return { match: doubleMatch, isDouble: true };
    }
    if (isMatchInside(doubleMatch, singleMatch)) {
      return { match: singleMatch, isDouble: false };
    }
    return (doubleMatch.index ?? 0) > (singleMatch.index ?? 0)
      ? { match: doubleMatch, isDouble: true }
      : { match: singleMatch, isDouble: false };
  }
  if (doubleMatch) return { match: doubleMatch, isDouble: true };
  return { match: singleMatch, isDouble: false };
}

/**
 * Tokenise a single shell-command segment via `shell-quote`. Returns
 * the parsed string tokens with leading env-var assignments and a
 * small allowlist of safe wrappers (`sudo`, `command`, with their
 * flag block consumed) stripped. Returns `null` if the segment
 * doesn't parse — the caller should then skip the segment.
 *
 * Using `shell-quote.parse` (rather than a regex scan) is what makes
 * quoted env values (`FOO="a b" cmd`) tokenise correctly and avoids
 * the polynomial regex behaviour CodeQL flagged on the previous
 * `\S*\s+`-based slicing loop.
 */
function tokeniseSegment(segment: string): string[] | null {
  let tokens: string[];
  try {
    // Pass an env getter that preserves `$NAME` references in tokens
    // rather than collapsing them to `''` (shell-quote's default).
    // Without this, `cd $HOME` parses as `['cd', '']` and the downstream
    // `target.includes('$')` repo-shift detection silently fails: an
    // env-var that points to another repo would get treated as a
    // same-repo no-op and our Co-authored-by trailer would land on a
    // commit in whatever repo `$HOME`/`$REPO_ROOT` resolves to at
    // runtime. Same problem in `parseGitInvocation` for `git -C $HOME`.
    // Single-quoted forms (`cd '$HOME'`) end up looking like a variable
    // reference too, but in practice nobody creates a directory named
    // literally `$HOME`, so over-flagging is the conservative-correct
    // choice.
    tokens = parse(segment, (key) => '$' + key).filter(
      (t): t is string => typeof t === 'string',
    );
  } catch (e) {
    debugLogger.warn(
      `tokeniseSegment: parse failed for "${segment.slice(0, 80)}": ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
    return null;
  }
  let i = 0;
  // Skip env-var assignments (KEY=value). If the key is one of the
  // git-repo-redirecting variables, refuse to tokenise the segment at
  // all: `GIT_DIR=elsewhere/.git git commit ...` runs against another
  // repository, so treating it as an in-cwd commit and stamping our
  // attribution onto it would be wrong (and a `Co-authored-by` trailer
  // would land on a commit in a repo the user didn't expect us to touch).
  while (i < tokens.length) {
    const key = leadingEnvAssignmentKey(tokens[i]!);
    if (key === null) break;
    if (GIT_ENV_SHIFTS_REPO.has(key)) return null;
    i++;
  }
  // Strip a single safe wrapper, then any leading flag tokens it
  // took. Sudo's value-taking flags (`-u user`, `-g group`,
  // `-h host`, `-D path`, `-r role`, `-t type`) consume the next
  // argv slot, so without explicitly knowing which take values we'd
  // leave e.g. `user` standing in for the program in
  // `sudo -u user git commit ...`. `command` doesn't take any flag
  // values. `env` accepts both flags (`-i`, `-S`, `-u name`) AND
  // `KEY=VALUE` argv entries before the program — both need
  // skipping so `env GIT_COMMITTER_DATE=now git commit ...` resolves
  // to `git`.
  if (tokens[i] === 'sudo' || tokens[i] === 'command' || tokens[i] === 'env') {
    const wrapper = tokens[i];
    i++;
    while (i < tokens.length && tokens[i]!.startsWith('-')) {
      const flag = tokens[i]!;
      i++;
      // `env -C DIR` / `env --chdir DIR` (GNU coreutils 8.30+) and
      // `sudo -D DIR` / `sudo --chdir DIR` (Linux sudo with --chdir)
      // both relocate the working directory before exec. Treat the
      // segment as repo-shifting (same contract as a leading
      // `GIT_DIR=...` assignment) so we don't stamp our trailer onto
      // a commit that landed in a different repository.
      //
      // Also catch the attached-value forms `--chdir=DIR` and the
      // short-form `-CDIR` / `-DDIR` that shell-quote tokenises as a
      // single argv entry. Without this, `sudo --chdir=/tmp git
      // commit` and `env -C/tmp git commit` would both pass through
      // the bare-flag check (which is set-membership, not prefix-
      // match) and silently land our trailer on a commit in the
      // wrong repo.
      const shiftSet =
        wrapper === 'env'
          ? ENV_FLAGS_SHIFT_CWD
          : wrapper === 'sudo'
            ? SUDO_FLAGS_SHIFT_CWD
            : null;
      if (shiftSet && isShiftCwdFlag(flag, shiftSet)) {
        return null;
      }
      // Value-taking flag tables, per wrapper: `sudo -u user`,
      // `env -u NAME` (unset), `env -S string` (split-string args).
      // `command` has no value-taking options in this allowlist.
      // Without skipping the value, `env -u FOO git commit ...`
      // would leave `FOO` as `tokens[0]` and the parser would treat
      // it as the program — masking the real `git commit`.
      const takesValue =
        (wrapper === 'sudo' && SUDO_FLAGS_WITH_VALUE.has(flag)) ||
        (wrapper === 'env' && ENV_FLAGS_WITH_VALUE.has(flag));
      if (takesValue && i < tokens.length) {
        i++;
      }
    }
    // `env` puts KEY=VALUE pairs between its flags and the real
    // program, so skip those too. Same git-repo-redirect bail as
    // above applies — a `env GIT_DIR=elsewhere git commit` segment
    // is non-attributable.
    if (wrapper === 'env') {
      while (i < tokens.length) {
        const key = leadingEnvAssignmentKey(tokens[i]!);
        if (key === null) break;
        if (GIT_ENV_SHIFTS_REPO.has(key)) return null;
        i++;
      }
    }
  }
  return tokens.slice(i);
}

const SUDO_FLAGS_WITH_VALUE = new Set([
  '-u',
  '-g',
  '-h',
  '-D',
  '-r',
  '-t',
  '-C',
  '--user',
  '--group',
  '--host',
  '--chdir',
  '--role',
  '--type',
]);

// `env`'s value-taking flags. `-u NAME` unsets a variable;
// `-S "string"` splits a single string into args. Without skipping
// the value, `env -u FOO git commit ...` would leave `FOO` as the
// next token and the parser would treat it as the program.
const ENV_FLAGS_WITH_VALUE = new Set(['-u', '--unset', '-S', '--split-string']);

// `env`'s flags that relocate the working directory (and therefore
// the implicit repository) before exec — GNU coreutils 8.30+'s
// `-C DIR` / `--chdir DIR`. A `git commit` inside such an env wrapper
// runs against whatever repo lives at DIR, NOT our cwd, so we must
// refuse the segment outright the same way `cd /elsewhere && git
// commit` is refused. Returning null from tokeniseSegment makes the
// segment non-attributable, which suppresses both trailer injection
// and the per-file note.
const ENV_FLAGS_SHIFT_CWD = new Set(['-C', '--chdir']);

// `sudo`'s flags that relocate the working directory before exec.
// Linux sudo's `-D DIR` / `--chdir DIR` (1.9.2+) makes the inner
// command run in DIR, which means a `git commit` underneath it
// targets DIR's repo, not ours. Refuse the segment.
const SUDO_FLAGS_SHIFT_CWD = new Set(['-D', '--chdir']);

/**
 * Match a flag token against a SHIFT_CWD set, including attached-value
 * forms. Bare `--chdir`/`-D`/`-C` are caught by direct set membership;
 * the long attached form `--name=value` matches when `--name` is in the
 * set, and the short attached form `-Xvalue` matches when `-X` is in
 * the set AND the token is longer than the flag (so `-D` alone doesn't
 * spuriously match `-D` against itself twice).
 */
function isShiftCwdFlag(flag: string, set: ReadonlySet<string>): boolean {
  if (set.has(flag)) return true;
  for (const f of set) {
    if (f.startsWith('--') && flag.startsWith(f + '=')) return true;
    if (
      f.length === 2 &&
      f.startsWith('-') &&
      flag.startsWith(f) &&
      flag.length > 2
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Environment variables that redirect git's repository selection. A
 * leading `GIT_DIR=...`, `GIT_WORK_TREE=...`, etc. on a command makes
 * the inner `git commit` operate on a different repo than our cwd
 * suggests; treating it as an in-cwd commit would attach our
 * `Co-authored-by` trailer (and per-file note) to the wrong
 * repository. tokeniseSegment refuses to parse such segments so the
 * caller skips them.
 *
 * Identity / date variables (`GIT_AUTHOR_*`, `GIT_COMMITTER_*`) are
 * deliberately NOT in this set — they tweak the commit's metadata
 * but don't move it to another repo, so attribution is still
 * meaningful.
 */
// `GIT_NAMESPACE` is intentionally NOT here: it prefixes ref names
// within the same repository, but the working tree and object store
// are unchanged, so a `git commit` under it still lands in our cwd's
// repo. The set covers ONLY variables that change which on-disk
// repository git acts on.
const GIT_ENV_SHIFTS_REPO = new Set([
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_COMMON_DIR',
  'GIT_INDEX_FILE',
]);

/**
 * Match the `KEY=` prefix of a `KEY=value` token and return KEY,
 * or null if the token isn't a leading env-var assignment. Centralised
 * so the leading-env-strip and the env-wrapper KEY=VALUE strip share
 * the same parsing.
 */
function leadingEnvAssignmentKey(token: string): string | null {
  const m = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(token);
  return m ? m[1]! : null;
}

/**
 * Walk a `git ...` token sequence past git's global flags
 * (`-c key=val`, `-C path`, `--no-pager`, `--git-dir`, `--work-tree`,
 * `--namespace`, etc.) to find the actual subcommand. Without this,
 * `git -c k=v commit -m x` and `git --no-pager commit -m x` would
 * silently slip past a fixed-position check at index 1.
 *
 * `changesCwd` is true when any of the consumed flags would relocate
 * the working directory (`-C`, `--git-dir`, `--work-tree`).
 */
// Two-token global flags whose second token is consumed as a value.
const GIT_GLOBAL_FLAGS_TAKES_VALUE = new Set([
  '-c',
  '-C',
  '--git-dir',
  '--work-tree',
  '--namespace',
  '--exec-path',
  '--config-env',
  '--super-prefix',
  '--list-cmds',
]);
// Flags whose presence shifts cwd interpretation.
const GIT_GLOBAL_FLAGS_SHIFTS_CWD = new Set(['-C', '--git-dir', '--work-tree']);

// `-C .` (and `./`, attached `-C.`) are no-op cwd shifts; treating
// them as cwd-changing would suppress attribution for `git -C . commit`
// (a common alias for "explicit current dir").
//
// Empty string is intentionally NOT treated as no-op even though
// `-C "" commit` is technically a no-op — `shell-quote` returns ''
// for any env-var or command-substitution that it cannot resolve at
// parse time (e.g. `-C $HOME`, `-C $REPO_ROOT`, `-C $UNSET`), so
// the literal-empty and the unknown-env-var cases are
// indistinguishable from our static view. Treating them as no-op
// would silently stamp our Co-authored-by trailer onto a commit
// that lands in whatever repo `$HOME`/`$REPO_ROOT` resolves to at
// runtime. Conservative skip is the safer call; the only missed
// attribution is for `-C $PWD commit` (rare) and literal `-C ""
// commit` (malformed and won't actually commit).
//
// Same conservatism applies to literal absolute paths that happen
// to resolve to cwd at runtime — we only have the argv at parse
// time, so the cheap textual comparison is what we can reasonably
// check here.
function isNoopCwdTarget(target: string): boolean {
  const t = target.trim();
  return t === '.' || t === './';
}

function parseGitInvocation(tokens: string[]): {
  subcommand: string | undefined;
  changesCwd: boolean;
} {
  let i = 1; // skip 'git'
  let changesCwd = false;
  while (i < tokens.length) {
    const t = tokens[i]!;
    if (GIT_GLOBAL_FLAGS_TAKES_VALUE.has(t)) {
      const value = tokens[i + 1] ?? '';
      // For `-C` specifically, the value is the new cwd. `-C .` is
      // a no-op so don't flip changesCwd. (`--git-dir`/`--work-tree`
      // path arguments aren't cwd in the same sense — leave those
      // unconditional.)
      if (t === '-C') {
        if (!isNoopCwdTarget(value)) changesCwd = true;
      } else if (GIT_GLOBAL_FLAGS_SHIFTS_CWD.has(t)) {
        changesCwd = true;
      }
      i += 2;
      continue;
    }
    // Attached-value form: `--git-dir=path`, `--work-tree=path`, etc.
    if (t.startsWith('--git-dir=') || t.startsWith('--work-tree=')) {
      changesCwd = true;
      i++;
      continue;
    }
    // Attached-value form for `-C`: `git -C/path commit ...` and
    // `git -C. commit ...`. Git accepts both `-C path` (handled
    // above by TAKES_VALUE) and the concatenated form. shell-quote
    // tokenises the latter as a single `-Cpath` token.
    if (t.length > 2 && t.startsWith('-C')) {
      const value = t.slice(2);
      if (!isNoopCwdTarget(value)) changesCwd = true;
      i++;
      continue;
    }
    // Other long/short flag (no separate arg, e.g. --no-pager,
    // --version, --bare, -p).
    if (t.startsWith('-')) {
      i++;
      continue;
    }
    // First non-flag is the subcommand.
    return { subcommand: t, changesCwd };
  }
  return { subcommand: undefined, changesCwd };
}

/**
 * Classify whether a command chain (potentially compound) contains a
 * `git commit` invocation, and whether that invocation lands in the
 * tool's initial cwd.
 *
 * Two flags are returned because the answers feed different decisions:
 * - `hasCommit` is the broader "did the user try to commit anywhere
 *   in this chain?" — used to refuse background mode and to gate
 *   prompt-counter snapshotting.
 * - `attributableInCwd` is the stricter "is it safe to capture HEAD
 *   in our cwd and write a note to that repo?" — used by the actual
 *   trailer rewrite and git-notes write.
 *
 * Walks segments in order so a `cd` AFTER an in-cwd commit doesn't
 * invalidate that commit's attribution; only a `cd` (or `git -C` /
 * `--git-dir` / `--work-tree`) BEFORE the commit shifts safety.
 *
 * `cwdShifted` is intentionally a one-way latch — it isn't reset on
 * a subsequent `cd .` or `cd ..`, so harmless cd cycles like
 * `cd src && cd .. && git commit -m x` will conservatively skip
 * attribution. The trade-off matches the wrong-repo guard's intent
 * (better miss than corrupt unrelated repos).
 */
function gitCommitContext(command: string): {
  hasCommit: boolean;
  attributableInCwd: boolean;
} {
  let hasCommit = false;
  let attributable = false;
  let cwdShifted = false;

  for (const sub of splitCommands(command)) {
    const tokens = tokeniseSegment(sub);
    if (!tokens || tokens.length === 0) continue;

    const program = tokens[0]!;

    if (program === 'cd' || program === 'pushd') {
      // A cd / pushd before any commit might redirect a later
      // `git commit` into a different repo. A cd AFTER the commit
      // doesn't matter for the commit we already saw.
      //
      // A heuristic relaxation: relative cd targets that don't escape
      // upward (no `..`, no absolute path, no env-var/$home expansion)
      // almost always stay within the same repo. The very common
      // `cd subdir && git commit -m "..."` flow is the motivating case
      // — same repo, same toplevel, attribution is still safe. Only
      // mark as shifted when the target *could* land us in a different
      // repo. We can't be 100% certain without running `git rev-parse
      // --show-toplevel` after the cd, which would require a synchronous
      // fs/exec call that the rest of this walk avoids — the heuristic
      // covers the common case and stays conservative on the rest.
      if (!hasCommit && cdTargetMayChangeRepo(tokens)) cwdShifted = true;
      continue;
    }
    if (program === 'popd') {
      // `popd` returns to a previous directory in the bash dir-stack.
      // Without tracking the stack we can't know whether the resulting
      // cwd is the same repo or a different one — treat conservatively
      // as a shift before any commit.
      if (!hasCommit) cwdShifted = true;
      continue;
    }

    if (program === 'git') {
      const { subcommand, changesCwd } = parseGitInvocation(tokens);
      if (subcommand === 'commit') {
        hasCommit = true;
        // The commit lands in our cwd only if no preceding cd shifted
        // us and this very invocation didn't redirect via -C/--git-dir.
        if (!cwdShifted && !changesCwd) attributable = true;
      } else if (changesCwd && !hasCommit) {
        // `git -C /path status` and friends signal cwd-elsewhere
        // intent; subsequent in-cwd commits in this chain are unusual
        // enough to be conservative about.
        cwdShifted = true;
      }
    }
  }

  return { hasCommit, attributableInCwd: attributable };
}

/**
 * Walk a `gh ...` token sequence past gh's global flags
 * (`--repo owner/repo`, `--hostname host`, `--help`, `--version`) and
 * return the resulting subcommand chain. Same purpose as
 * `parseGitInvocation`: a fixed-position check at index 1 misses
 * `gh --repo owner/repo pr create ...`, which is a common form.
 */
const GH_GLOBAL_FLAGS_TAKES_VALUE = new Set(['--repo', '-R', '--hostname']);

function parseGhInvocation(tokens: string[]): string[] {
  let i = 1; // skip 'gh'
  while (i < tokens.length) {
    const t = tokens[i]!;
    if (GH_GLOBAL_FLAGS_TAKES_VALUE.has(t)) {
      i += 2;
      continue;
    }
    if (
      t.startsWith('--repo=') ||
      t.startsWith('--hostname=') ||
      t.startsWith('-R=')
    ) {
      i++;
      continue;
    }
    if (t.startsWith('-')) {
      i++;
      continue;
    }
    return tokens.slice(i);
  }
  return [];
}

/**
 * Heuristic: does this `cd` invocation potentially redirect us into
 * a different repository? Used by `gitCommitContext` to decide
 * whether a subsequent `git commit` in the same chain is still
 * attributable in our cwd.
 *
 * Returns true (conservative — assume shift) when the target is
 * absolute, escapes upward (`..`), goes to `$HOME` / `~`, contains an
 * env-var (we can't resolve it statically), or is missing entirely
 * (`cd` alone goes to `$HOME`). Plain relative paths like `cd src`,
 * `cd ./packages/foo`, or `cd subdir/nested` are treated as in-repo.
 */
function cdTargetMayChangeRepo(tokens: string[]): boolean {
  // tokens[0] is 'cd'. The next non-flag token is the target.
  let i = 1;
  while (i < tokens.length && tokens[i]!.startsWith('-')) i++;
  const target = tokens[i];
  // `cd` with no argument goes to $HOME.
  if (target === undefined) return true;
  if (target.startsWith('/')) return true;
  if (target.startsWith('~')) return true;
  // Env-var reference (e.g. `$HOME`, `$REPO`) — can't resolve here.
  if (target.includes('$')) return true;
  // `..`, `../..`, `..\\foo` etc. could escape the repo root.
  if (target === '..') return true;
  if (target.startsWith('../') || target.startsWith('..\\')) return true;
  // Embedded parent-dir traversal can also escape: `foo/../../escape`,
  // `./..`, `nested/..`, etc. Catching `/..` and `\..` anywhere in
  // the path covers both POSIX and Windows separators without
  // false-positiving on legitimate names that happen to contain `..`
  // (which only escape when followed by a separator).
  if (target.includes('/..') || target.includes('\\..')) return true;
  // `-` is bash's "previous directory" — could be anywhere.
  if (target === '-') return true;
  return false;
}

/**
 * Detect whether the attributable `git commit` invocation in
 * `command` carries the `--amend` flag. Used so attachCommitAttribution
 * can switch the diff range from `${postHead}~1..${postHead}` (the
 * amended commit vs its parent — too broad for amend, since the
 * amended commit's parent is the original commit's parent, so this
 * diff lumps both commits' worth of changes) to
 * `${preHead}..${postHead}` (the actual amend delta — `preHead` was
 * captured synchronously before spawn and is the pre-amend SHA).
 *
 * Only the *first* commit segment that runs in the same cwd as the
 * shell tool counts. `git -C ../other commit --amend && git commit -m x`
 * must not flip the diff range for the second (fresh) commit, since
 * `preHead` would be the inner repo's SHA there, not ours.
 */
function isAmendCommit(command: string): boolean {
  let cwdShifted = false;
  for (const sub of splitCommands(command)) {
    const tokens = tokeniseSegment(sub);
    if (!tokens || tokens.length === 0) continue;
    const program = tokens[0]!;
    if (program === 'cd' || program === 'pushd') {
      if (!cwdShifted && cdTargetMayChangeRepo(tokens)) cwdShifted = true;
      continue;
    }
    if (program === 'popd') {
      cwdShifted = true;
      continue;
    }
    if (program !== 'git') continue;
    const { subcommand, changesCwd } = parseGitInvocation(tokens);
    if (subcommand === 'commit' && !cwdShifted && !changesCwd) {
      return (
        tokens.includes('--amend') ||
        tokens.some((t) => t.startsWith('--amend='))
      );
    }
    if (changesCwd && !cwdShifted) cwdShifted = true;
  }
  return false;
}

/**
 * Locate the character range of the *first* attributable
 * `git commit` invocation in the (potentially compound) command, or
 * `null` if none is attributable in the current cwd. The range
 * covers the segment as `splitCommands` tokenised it — i.e. just
 * the `git commit ...` part, NOT later `&& git tag -m ...` or
 * earlier `git status &&` segments.
 *
 * Used by `addCoAuthorToGitCommit` to scope the `-m` regex rewrite
 * so a later `git tag -m "..."` (different sub-command in the same
 * compound) can't be mistaken for the commit message.
 */
function findAttributableCommitSegment(
  command: string,
): { start: number; end: number } | null {
  let cursor = 0;
  let cwdShifted = false;
  for (const sub of splitCommands(command)) {
    const start = command.indexOf(sub, cursor);
    if (start < 0) {
      // splitCommands strips line continuations (`\<newline>`) and
      // some whitespace, so the trimmed segment text may not appear
      // verbatim in the original command. Log so a multi-line
      // command silently dropping its trailer is at least visible
      // when QWEN_DEBUG_LOG_FILE is set.
      debugLogger.warn(
        `findAttributableCommitSegment: cannot map segment "${sub.slice(0, 60)}" ` +
          `back to the original command (likely line-continuation / whitespace mismatch).`,
      );
      continue;
    }
    const end = start + sub.length;
    cursor = end;
    const tokens = tokeniseSegment(sub);
    if (!tokens || tokens.length === 0) continue;
    const program = tokens[0]!;
    if (program === 'cd' || program === 'pushd') {
      // Mirror gitCommitContext's cd/pushd heuristic: relative paths
      // that don't escape upward are treated as in-repo, so
      // `cd subdir && git commit ...` still finds the segment.
      if (!cwdShifted && cdTargetMayChangeRepo(tokens)) cwdShifted = true;
      continue;
    }
    if (program === 'popd') {
      cwdShifted = true;
      continue;
    }
    if (program === 'git') {
      const { subcommand, changesCwd } = parseGitInvocation(tokens);
      if (subcommand === 'commit' && !cwdShifted && !changesCwd) {
        return { start, end };
      }
      if (changesCwd && !cwdShifted) cwdShifted = true;
    }
  }
  return null;
}

/**
 * Locate the character range of the `gh pr create` (or alias
 * `gh pr new`) segment in a potentially compound command. Used by
 * `addAttributionToPR` so the `--body`/`-b` rewrite is scoped to
 * just that segment — without scoping, a command like
 * `curl -b "session=abc" && gh pr create --body "summary"` would
 * have the regex match `curl`'s `-b` cookie flag and inject
 * attribution there.
 */
function findGhPrCreateSegment(
  command: string,
): { start: number; end: number } | null {
  let cursor = 0;
  for (const sub of splitCommands(command)) {
    const start = command.indexOf(sub, cursor);
    if (start < 0) {
      debugLogger.warn(
        `findGhPrCreateSegment: cannot map segment "${sub.slice(0, 60)}" ` +
          `back to the original command (likely line-continuation / whitespace mismatch).`,
      );
      continue;
    }
    const end = start + sub.length;
    cursor = end;
    const tokens = tokeniseSegment(sub);
    if (!tokens || tokens[0] !== 'gh') continue;
    const rest = parseGhInvocation(tokens);
    if (rest[0] === 'pr' && (rest[1] === 'create' || rest[1] === 'new')) {
      return { start, end };
    }
  }
  return null;
}

/**
 * Approximate characters per text line for the diff-size proxy.
 * `numstat` reports added+deleted line counts; we multiply by this
 * constant to get a coarse "change magnitude" the per-file AI
 * accumulator can be clamped against. The downstream `aiChars` /
 * `humanChars` fields in the git-notes payload are literally
 * (lines × this constant) — they are NOT real character counts.
 * See the `FileAttributionDetail` interface doc for the consequences
 * for consumers that aggregate the raw values.
 */
const APPROX_CHARS_PER_LINE = 40;
/**
 * Fallback diff-size proxy for binary files. `numstat` reports `-`
 * (instead of integer counts) for any non-text blob, so we can't
 * compute a per-line estimate; this flat value lets the entry
 * survive into the payload at a consistent (if coarse) size.
 * Same heuristic-not-literal caveat as `APPROX_CHARS_PER_LINE` —
 * a 5 MB image change and a 1-byte binary tweak both report this
 * value.
 */
const BINARY_DIFF_SIZE_FALLBACK = 1024;

/**
 * Parse `git diff --numstat` output into a `path → approximate change
 * size` map for attribution accounting. The result feeds in as the
 * denominator clamp for `aiChars`, so missing entries would silently
 * drop a file from attribution — every changed file must land in the
 * map.
 *
 * `--numstat` is preferred over `--stat` because the columns are exact
 * integers (no graphical bars to parse). Each line is:
 *   `<additions>\t<deletions>\t<path>`
 * For binary files, both counts are `-`; we fall back to a fixed
 * estimate so binary-only changes still get a non-zero entry.
 *
 * The `(adds + dels) * 40` figure remains a heuristic — git diff has no
 * cheap way to surface exact character counts. The clamp in
 * `generateNotePayload` keeps the math consistent (aiChars never
 * exceeds diffSize), so the heuristic drives the precision of the
 * percentage but cannot make `aiChars + humanChars` diverge from
 * `diffSize`.
 *
 * Rename notations (`{old => new}` and bare `old => new`) are
 * normalized to the new path so lookups match `--name-only` output.
 *
 * Exported for unit testing — the function is otherwise an
 * implementation detail of `attachCommitAttribution`.
 */
export function parseNumstat(numstatOutput: string): Map<string, number> {
  const sizes = new Map<string, number>();
  const lines = numstatOutput.split('\n').filter(Boolean);

  const normalizeFilePath = (filePath: string): string => {
    let p = filePath.trim();
    // Brace rename: `{old => new}` or `dir/{old => new}/file`
    p = p.replace(/\{[^}]*?=>\s*([^}]*)\}/g, '$1');
    // Bare rename across directories: `old/path/file => new/path/file`
    if (p.includes('=>')) {
      const m = p.match(/^(.*?)\s=>\s(.*)$/);
      if (m) p = m[2]!.trim();
    }
    return p;
  };

  for (const line of lines) {
    // Format: "<additions>\t<deletions>\t<path>" — a literal "-" stands
    // in for both counts on binary entries.
    const m = line.match(/^([\d-]+)\t([\d-]+)\t(.+)$/);
    if (!m) continue;
    const filePath = normalizeFilePath(m[3]!);
    if (m[1] === '-' && m[2] === '-') {
      // Binary file: numstat omits exact counts. Fall back to a fixed
      // estimate so the entry isn't missing entirely (which would zero
      // out attribution for the file).
      sizes.set(filePath, BINARY_DIFF_SIZE_FALLBACK);
      continue;
    }
    const adds = parseInt(m[1]!, 10);
    const dels = parseInt(m[2]!, 10);
    if (Number.isNaN(adds) || Number.isNaN(dels)) continue;
    sizes.set(filePath, (adds + dels) * APPROX_CHARS_PER_LINE);
  }

  return sizes;
}

export const OUTPUT_UPDATE_INTERVAL_MS = 1000;
const DEFAULT_FOREGROUND_TIMEOUT_MS = 120000;

/**
 * Time we give SIGTERM to settle a promoted-then-cancelled child
 * before escalating to SIGKILL. Mirrors `SIGKILL_TIMEOUT_MS` inside
 * `ShellExecutionService` (which runs the same SIGTERM-then-SIGKILL
 * pattern on the non-promote cancel path) but kept as a separate
 * constant here so tuning one doesn't silently change the other.
 */
const PROMOTE_CANCEL_SIGKILL_TIMEOUT_MS = 200;

// Long-run advisory threshold: half the EFFECTIVE foreground timeout
// (not the default), computed per-invocation by `longRunThresholdFor`.
// Couples to whichever timeout actually governs THIS command — so a
// user who sets `timeout: 600_000` (10 min) gets the advisory at 5 min,
// not at 60s. The 1/2 ratio is chosen so the hint surfaces well before
// the timeout would hard-kill, but late enough that normal foreground
// commands (under the 120s default) don't trigger it before ~60s.
//
// Floor of 1000ms guards the pathological tiny-positive-timeout edge.
// `timeout <= 0` is already rejected by `validateToolParamValues` so
// only positive values reach here, but `timeout: 1` (or any value < 2)
// would otherwise produce `Math.floor(timeout / 2) = 0` and make
// `elapsedMs >= 0` fire on every invocation showing "ran for 0s",
// surfacing the hint before the command had a chance to fail by
// timing out.
const MIN_LONG_RUN_THRESHOLD_MS = 1000;
function longRunThresholdFor(effectiveTimeoutMs: number): number {
  return Math.max(
    MIN_LONG_RUN_THRESHOLD_MS,
    Math.floor(effectiveTimeoutMs / 2),
  );
}

/**
 * Format the long-run advisory appended to long foreground commands.
 * Exported so tests and any future consumer (e.g. an alternative
 * renderer) can render the same text without duplicating the threshold
 * logic.
 *
 * Wording deliberately keeps the dialog mention conditional ("when
 * running interactively") so the LLM doesn't relay misleading guidance
 * to non-TTY users (`-p` headless / ACP / SDK consumers, where no
 * dialog or footer pill exists). `/tasks` and the on-disk output file
 * work in every mode.
 */
export function buildLongRunningForegroundHint(elapsedMs: number): string {
  const seconds = Math.round(elapsedMs / 1000);
  return (
    `Note: this foreground command ran for ${seconds}s. ` +
    `Next time you run a similar long-running process (build watchers, ` +
    `dev servers, soak tests, polling loops), pass \`is_background: true\` ` +
    `so the agent isn't blocked while the command runs. ` +
    `(This is forward-looking guidance for FUTURE invocations — do NOT ` +
    `re-run the command that just completed; for stateful operations ` +
    `like deploys, migrations, or git push, that would cause double ` +
    `side effects.) The output of background runs stays inspectable ` +
    `via /tasks (text, any mode) or the on-disk output file; in ` +
    `interactive mode the Background tasks dialog also has a per-entry ` +
    `detail view + live updates.`
  );
}

/**
 * Detect standalone or leading `sleep N` patterns that should use Monitor
 * instead. Catches `sleep 5`, `sleep 2.5`, `sleep 2s`,
 * `sleep 5 && check`, `sleep 5; check`, `sleep 5 # wait` — but not sleep
 * inside pipelines, subshells, backgrounded commands, or scripts (those are
 * fine).
 */
export function detectBlockedSleepPattern(command: string): string | null {
  // Strip trailing shell comments first; otherwise `sleep 5 # wait` would
  // present `# wait` as the suffix, which `getSleepSequentialSeparator`
  // rejects (only &&/||/;/\n are recognized), letting the foreground sleep
  // bypass the guard. Shell ignores top-level trailing comments, so for the
  // purposes of detection they are equivalent to end-of-command.
  const trimmed = trimTrailingShellComment(command).trim();
  if (!trimmed.startsWith('sleep')) return null;
  const afterSleep = trimmed.slice('sleep'.length);
  if (!afterSleep || !/\s/.test(afterSleep[0]!)) return null;

  let index = 0;
  while (index < afterSleep.length && /\s/.test(afterSleep[index]!)) {
    index++;
  }
  const durationStart = index;
  while (
    index < afterSleep.length &&
    !/\s/.test(afterSleep[index]!) &&
    ![';', '&', '|', '\n'].includes(afterSleep[index]!)
  ) {
    index++;
  }

  const durationToken = afterSleep.slice(durationStart, index);
  const secs = parseSleepDurationToSeconds(durationToken);
  if (secs === null || secs < 2) return null;

  const suffix = afterSleep.slice(index);
  const separator = getSleepSequentialSeparator(suffix);
  if (separator === null) return null;

  const rest = separator.rest.trim();
  return rest
    ? `sleep ${durationToken} followed by: ${rest}`
    : `standalone sleep ${durationToken}`;
}

function parseSleepDurationToSeconds(token: string): number | null {
  if (!token) return null;

  let index = 0;
  let seenDigit = false;
  let seenDot = false;
  while (index < token.length) {
    const char = token[index]!;
    if (char >= '0' && char <= '9') {
      seenDigit = true;
      index++;
      continue;
    }
    if (char === '.' && !seenDot) {
      seenDot = true;
      index++;
      continue;
    }
    break;
  }

  if (!seenDigit) return null;
  const value = Number.parseFloat(token.slice(0, index));
  if (!Number.isFinite(value)) return null;

  const unit = token.slice(index).toLowerCase();
  switch (unit || 's') {
    case 'ms':
      return value / 1000;
    case 's':
      return value;
    case 'm':
      return value * 60;
    case 'h':
      return value * 60 * 60;
    case 'd':
      return value * 60 * 60 * 24;
    default:
      return null;
  }
}

function getSleepSequentialSeparator(suffix: string): { rest: string } | null {
  let index = 0;
  while (
    index < suffix.length &&
    suffix[index] !== '\n' &&
    /\s/.test(suffix[index]!)
  ) {
    index++;
  }

  const restWithSeparator = suffix.slice(index);
  if (!restWithSeparator) return { rest: '' };
  if (
    restWithSeparator.startsWith('&&') ||
    restWithSeparator.startsWith('||')
  ) {
    return { rest: restWithSeparator.slice(2) };
  }
  if (restWithSeparator[0] === ';' || restWithSeparator[0] === '\n') {
    return { rest: restWithSeparator.slice(1) };
  }
  return null;
}

function trimTrailingShellComment(command: string): string {
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let inBacktick = false;
  let escapeNext = false;
  let commandSubstitutionDepth = 0;

  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;

    if (inSingleQuote) {
      if (ch === "'") inSingleQuote = false;
      continue;
    }

    if (inBacktick) {
      if (escapeNext) {
        escapeNext = false;
        continue;
      }
      if (ch === '\\') {
        escapeNext = true;
        continue;
      }
      if (ch === '`') inBacktick = false;
      continue;
    }

    if (inDoubleQuote) {
      if (escapeNext) {
        escapeNext = false;
        continue;
      }
      if (ch === '\\') {
        escapeNext = true;
        continue;
      }
      if (ch === '"') {
        inDoubleQuote = false;
        continue;
      }
      if (ch === '$' && command[i + 1] === '(') {
        commandSubstitutionDepth++;
        i++;
        continue;
      }
      if (ch === ')' && commandSubstitutionDepth > 0) {
        commandSubstitutionDepth--;
      }
      continue;
    }

    if (escapeNext) {
      escapeNext = false;
      continue;
    }
    if (ch === '\\') {
      escapeNext = true;
      continue;
    }
    if (ch === "'") {
      inSingleQuote = true;
      continue;
    }
    if (ch === '"') {
      inDoubleQuote = true;
      continue;
    }
    if (ch === '`') {
      inBacktick = true;
      continue;
    }
    if (ch === '$' && command[i + 1] === '(') {
      commandSubstitutionDepth++;
      i++;
      continue;
    }
    if (ch === ')' && commandSubstitutionDepth > 0) {
      commandSubstitutionDepth--;
      continue;
    }
    if (
      ch === '#' &&
      commandSubstitutionDepth === 0 &&
      (i === 0 || /\s/.test(command[i - 1]!))
    ) {
      return command.slice(0, i);
    }
  }

  return command;
}

function hasTopLevelTrailingBackgroundOperator(command: string): boolean {
  const commentTrimmed = trimTrailingShellComment(command);
  const trimmed = commentTrimmed.trimEnd();
  if (!trimmed.endsWith('&')) return false;

  const trailingAmpIndex = trimmed.length - 1;
  const previousNonWhitespaceIndex = (() => {
    for (let i = trailingAmpIndex - 1; i >= 0; i--) {
      if (!/\s/.test(trimmed[i]!)) return i;
    }
    return -1;
  })();

  if (previousNonWhitespaceIndex >= 0) {
    const previous = trimmed[previousNonWhitespaceIndex]!;
    if (previous === '&' || previous === '|' || previous === '\\') {
      return false;
    }
  }

  let backslashCount = 0;
  for (let i = trailingAmpIndex - 1; i >= 0 && trimmed[i] === '\\'; i--) {
    backslashCount++;
  }
  if (backslashCount % 2 === 1) return false;

  let inSingleQuote = false;
  let inDoubleQuote = false;
  let inBacktick = false;
  let escapeNext = false;
  let commandSubstitutionDepth = 0;

  for (let i = 0; i <= trailingAmpIndex; i++) {
    const ch = trimmed[i]!;

    if (inSingleQuote) {
      if (ch === "'") inSingleQuote = false;
      continue;
    }

    if (inBacktick) {
      if (escapeNext) {
        escapeNext = false;
        continue;
      }
      if (ch === '\\') {
        escapeNext = true;
        continue;
      }
      if (ch === '`') inBacktick = false;
      continue;
    }

    if (inDoubleQuote) {
      if (escapeNext) {
        escapeNext = false;
        continue;
      }
      if (ch === '\\') {
        escapeNext = true;
        continue;
      }
      if (ch === '"') {
        inDoubleQuote = false;
        continue;
      }
      if (ch === '$' && trimmed[i + 1] === '(') {
        commandSubstitutionDepth++;
        i++;
        continue;
      }
      if (ch === ')' && commandSubstitutionDepth > 0) {
        commandSubstitutionDepth--;
      }
      continue;
    }

    if (escapeNext) {
      escapeNext = false;
      continue;
    }
    if (ch === '\\') {
      escapeNext = true;
      continue;
    }
    if (ch === "'") {
      inSingleQuote = true;
      continue;
    }
    if (ch === '"') {
      inDoubleQuote = true;
      continue;
    }
    if (ch === '`') {
      inBacktick = true;
      continue;
    }
    if (ch === '$' && trimmed[i + 1] === '(') {
      commandSubstitutionDepth++;
      i++;
      continue;
    }
    if (ch === ')' && commandSubstitutionDepth > 0) {
      commandSubstitutionDepth--;
      continue;
    }
    if (i === trailingAmpIndex) {
      return commandSubstitutionDepth === 0;
    }
  }

  return false;
}

export interface ShellToolParams {
  command: string;
  is_background: boolean;
  timeout?: number;
  description?: string;
  directory?: string;
}

export class ShellToolInvocation extends BaseToolInvocation<
  ShellToolParams,
  ToolResult
> {
  constructor(
    private readonly config: Config,
    params: ShellToolParams,
  ) {
    super(params);
  }

  getDescription(): string {
    let description = `${this.params.command}`;
    // append optional [in directory]
    // note description is needed even if validation fails due to absolute path
    if (this.params.directory) {
      description += ` [in ${this.params.directory}]`;
    }
    // append background indicator
    if (this.params.is_background) {
      description += ` [background]`;
    } else if (this.params.timeout) {
      // append timeout for foreground commands
      description += ` [timeout: ${this.params.timeout}ms]`;
    }
    // append optional (description), replacing any line breaks with spaces
    if (this.params.description) {
      description += ` (${this.params.description.replace(/\n/g, ' ')})`;
    }
    return description;
  }

  /**
   * AST-based permission check for the shell command.
   * - Read-only commands (via AST analysis) → 'allow'
   * - All other commands → 'ask'
   */
  override async getDefaultPermission(): Promise<PermissionDecision> {
    const command = stripShellWrapper(this.params.command);

    // AST-based read-only detection
    try {
      const isReadOnly = await isShellCommandReadOnlyAST(command);
      if (isReadOnly) {
        return 'allow';
      }
    } catch (e) {
      debugLogger.warn('AST read-only check failed, falling back to ask:', e);
    }

    return 'ask';
  }

  /**
   * Constructs confirmation dialog details for a shell command that needs
   * user approval.  For compound commands (e.g. `cd foo && npm run build`),
   * sub-commands that are already allowed (read-only) are excluded from both
   * the displayed root-command list and the suggested permission rules.
   */
  override async getConfirmationDetails(
    _abortSignal: AbortSignal,
  ): Promise<ToolCallConfirmationDetails> {
    const command = stripShellWrapper(this.params.command);
    const pm = this.config.getPermissionManager?.();
    const cwd = this.params.directory || this.config.getTargetDir();

    // Split compound command and filter out already-allowed (read-only) sub-commands
    const subCommands = splitCommands(command);
    const confirmableSubCommands: string[] = [];
    for (const sub of subCommands) {
      let isReadOnly = false;
      try {
        isReadOnly = await isShellCommandReadOnlyAST(sub);
      } catch {
        // conservative: treat unknown commands as requiring confirmation
      }

      if (isReadOnly) {
        continue;
      }

      if (pm) {
        try {
          if ((await pm.isCommandAllowed(sub, cwd)) === 'allow') {
            continue;
          }
        } catch (e) {
          debugLogger.warn('PermissionManager command check failed:', e);
        }
      }

      confirmableSubCommands.push(sub);
    }

    // Fallback to all sub-commands if everything was filtered out (shouldn't
    // normally happen since getDefaultPermission already returned 'ask').
    const effectiveSubCommands =
      confirmableSubCommands.length > 0 ? confirmableSubCommands : subCommands;

    const rootCommands = [
      ...new Set(
        effectiveSubCommands
          .map((c) => getCommandRoot(c))
          .filter((c): c is string => !!c),
      ),
    ];

    // Extract minimum-scope permission rules only for sub-commands that
    // actually need confirmation.
    let permissionRules: string[] = [];
    try {
      const allRules: string[] = [];
      for (const sub of effectiveSubCommands) {
        const rules = await extractCommandRules(sub);
        allRules.push(...rules);
      }
      permissionRules = [...new Set(allRules)].map((rule) => `Bash(${rule})`);
    } catch (e) {
      debugLogger.warn('Failed to extract command rules:', e);
    }

    const confirmationDetails: ToolExecuteConfirmationDetails = {
      type: 'exec',
      title: 'Confirm Shell Command',
      command: this.params.command,
      rootCommand: rootCommands.join(', '),
      permissionRules,
      onConfirm: async (
        _outcome: ToolConfirmationOutcome,
        _payload?: ToolConfirmationPayload,
      ) => {
        // No-op: persistence is handled by coreToolScheduler via PM rules
      },
    };
    return confirmationDetails;
  }

  async execute(
    signal: AbortSignal,
    updateOutput?: (output: ToolResultDisplay) => void,
    shellExecutionConfig?: ShellExecutionConfig,
    setPidCallback?: (pid: number) => void,
    setPromoteAbortControllerCallback?: (ac: AbortController) => void,
  ): Promise<ToolResult> {
    const strippedCommand = stripShellWrapper(this.params.command);

    if (signal.aborted) {
      return {
        llmContent: 'Command was cancelled by user before it could start.',
        returnDisplay: 'Command cancelled by user.',
      };
    }

    if (this.params.is_background) {
      return this.executeBackground(signal, shellExecutionConfig);
    }

    const effectiveTimeout =
      this.params.timeout ?? DEFAULT_FOREGROUND_TIMEOUT_MS;

    // Create combined signal with timeout AND promote-trigger for
    // foreground execution. The promoteAbortController is exposed to
    // the caller (the future Ctrl+B keybind handler in PR-3) via
    // `setPromoteAbortControllerCallback`. When the keybind fires
    // `promoteAbortController.abort({ kind: 'background', shellId })`,
    // ShellExecutionService detects the discriminated reason and
    // returns `result.promoted: true` instead of killing the child —
    // see #3842 / #3886 for the foundation.
    const promoteAbortController = new AbortController();
    let combinedSignal = AbortSignal.any([
      signal,
      promoteAbortController.signal,
    ]);
    if (effectiveTimeout) {
      const timeoutSignal = AbortSignal.timeout(effectiveTimeout);
      combinedSignal = AbortSignal.any([
        signal,
        timeoutSignal,
        promoteAbortController.signal,
      ]);
    }

    // Add co-author to git commit commands and Qwen Code attribution to
    // `gh pr create` bodies. Both wrappers are no-ops on commands they
    // don't recognise. Apply to the *trimmed original* (not strippedCommand)
    // so leading env assignments and shell wrappers (`FOO=bar bash -c '...'`)
    // are preserved through to execution; the rewriters operate at the
    // top-level shell layer and become no-ops when the commit hides
    // inside a wrapper.
    const processedCommand = this.addAttributionToPR(
      this.addCoAuthorToGitCommit(this.params.command.trim()),
    );
    const commandToExecute = processedCommand;
    const cwd = this.params.directory || this.config.getTargetDir();

    // Snapshot HEAD before running so attachCommitAttribution can detect
    // commit creation by HEAD movement instead of trusting the shell
    // exit code (which is unreliable for compound commands).
    //
    // Synchronous capture via `execFileSync`: a fire-and-forget async
    // rev-parse can resolve AFTER a fast-cached `git commit` moves
    // HEAD (real race seen on slow filesystems / heavy contention),
    // leaving preHead === postHead and silently skipping the
    // attribution note. ~10–50ms event-loop block per commit-shaped
    // command, only when `commitCtx.hasCommit` is true.
    //
    // We act on `gitCommitContext` rather than a raw regex so quoted
    // text like `echo "git commit"` doesn't trigger snapshot/notes,
    // and so attribution still runs after a `git commit && cd ..`
    // chain (which would have failed an "any cd anywhere" gate).
    const commitCtx = gitCommitContext(strippedCommand);
    // Capture preHead only when the commit will actually be
    // attributed in our cwd: that's the only consumer (the
    // `attributableInCwd` branch below feeds preHead into
    // `attachCommitAttribution`). For non-attributable
    // hasCommit cases (`cd /elsewhere && git commit`,
    // `git -C /other commit`), no consumer reads preHead and the
    // ~10–50 ms execFileSync is dead work that just blocks the
    // event loop before the user's real command spawns.
    const preHead: string | null = commitCtx.attributableInCwd
      ? this.getGitHeadSync(cwd)
      : null;

    let cumulativeOutput: string | AnsiOutput = '';
    let lastUpdateTime = Number.NEGATIVE_INFINITY;
    let isBinaryStream = false;
    let totalLines = 0;
    let totalBytes = 0;
    let trailingFlushTimer: ReturnType<typeof setTimeout> | null = null;

    const cancelTrailingFlush = () => {
      if (trailingFlushTimer !== null) {
        clearTimeout(trailingFlushTimer);
        trailingFlushTimer = null;
      }
    };

    const doUpdate = () => {
      // Any path that emits an update supersedes a pending trailing flush —
      // cancel centrally so leading-edge text, ANSI, binary_detected, and
      // binary_progress branches all stay consistent without each having to
      // remember to clear the timer themselves.
      cancelTrailingFlush();
      lastUpdateTime = Date.now();
      if (!updateOutput) return;
      if (typeof cumulativeOutput === 'string') {
        updateOutput(cumulativeOutput);
      } else {
        updateOutput({
          ansiOutput: cumulativeOutput,
          totalLines,
          totalBytes,
          ...(this.params.timeout != null && {
            timeoutMs: this.params.timeout,
          }),
        });
      }
    };

    // If the command is aborted (user cancel or timeout) while a trailing
    // flush is pending, cancel the timer so we don't emit a stale frame
    // between the abort signal firing and the result promise settling.
    const onAbort = () => {
      cancelTrailingFlush();
    };
    combinedSignal.addEventListener('abort', onAbort, { once: true });

    const onShellOutputEvent = (event: ShellOutputEvent) => {
      let shouldUpdate = false;

      switch (event.type) {
        case 'data':
          if (isBinaryStream) break;
          cumulativeOutput = event.chunk;
          // Stats are only consumed by the ANSI-output branch below,
          // so skip the per-chunk accounting for plain string chunks.
          if (Array.isArray(event.chunk)) {
            totalLines = event.chunk.length;
            totalBytes = event.chunk.reduce(
              (sum, line) =>
                sum +
                line.reduce(
                  (ls, token) => ls + Buffer.byteLength(token.text, 'utf-8'),
                  0,
                ),
              0,
            );
          }
          // ANSI output is already throttled and semantically deduped by
          // ShellExecutionService, so preserve its live responsiveness.
          // Plain text data can arrive in bursts and does not need every
          // chunk to force a React render; the final ToolResult still
          // carries the complete output after command completion.
          if (Array.isArray(event.chunk)) {
            shouldUpdate = true;
          } else if (Date.now() - lastUpdateTime > OUTPUT_UPDATE_INTERVAL_MS) {
            shouldUpdate = true;
          } else if (trailingFlushTimer === null) {
            // Throttled: schedule a trailing flush so the last suppressed
            // chunk is still shown if the command goes quiet within the
            // window. The timer's callback reads `cumulativeOutput` by
            // closure, so subsequent suppressed chunks within the same
            // window don't need to reschedule — the latest value will be
            // emitted when the timer fires.
            const remaining =
              OUTPUT_UPDATE_INTERVAL_MS - (Date.now() - lastUpdateTime);
            trailingFlushTimer = setTimeout(() => {
              trailingFlushTimer = null;
              doUpdate();
            }, remaining);
          }
          break;
        case 'binary_detected':
          isBinaryStream = true;
          cumulativeOutput = '[Binary output detected. Halting stream...]';
          shouldUpdate = true;
          break;
        case 'binary_progress':
          isBinaryStream = true;
          cumulativeOutput = `[Receiving binary output... ${formatMemoryUsage(
            event.bytesReceived,
          )} received]`;
          if (Date.now() - lastUpdateTime > OUTPUT_UPDATE_INTERVAL_MS) {
            shouldUpdate = true;
          }
          break;
        default: {
          throw new Error('An unhandled ShellOutputEvent was found.');
        }
      }

      if (shouldUpdate) {
        doUpdate();
      }
    };

    let executionHandle;
    try {
      executionHandle = await ShellExecutionService.execute(
        commandToExecute,
        cwd,
        onShellOutputEvent,
        combinedSignal,
        this.config.getShouldUseNodePtyShell(),
        shellExecutionConfig ?? {},
      );
    } catch (err) {
      // ShellExecutionService.execute() can throw before resolving (e.g.
      // PTY dynamic import failure). Tear down the abort listener and any
      // (theoretically) scheduled trailing flush so nothing fires after we
      // re-throw to the caller.
      cancelTrailingFlush();
      combinedSignal.removeEventListener('abort', onAbort);
      throw err;
    }
    const { result: resultPromise, pid } = executionHandle;

    if (pid && setPidCallback) {
      setPidCallback(pid);
    }
    // Hand the promote controller up to the scheduler so a future UI
    // surface (PR-3 Ctrl+B keybind) can find it and trigger promote.
    // Done unconditionally — the caller can ignore it if they don't
    // implement promote yet, but exposing it now means PR-3 doesn't
    // need to revisit shell.ts.
    setPromoteAbortControllerCallback?.(promoteAbortController);

    // Bracket the spawn → settle wall-clock so the result builder below
    // can decide whether to append the long-run advisory. Captured AFTER
    // `await ShellExecutionService.execute(...)` returns its handle so
    // pre-spawn setup (PTY dynamic import via `getPty()`, ~50–200ms on
    // first call) is excluded — the elapsed should reflect the
    // command's actual runtime, not the tool call's total wall time.
    // The `pid` set above confirms the process has been spawned by this
    // point, so subtraction below is true post-spawn-to-settle.
    //
    // `performance.now()` (monotonic high-res, ms-precision) instead of
    // `Date.now()` so NTP corrections / VM clock drift between capture
    // and read can't make `elapsedMs` go negative (which would silently
    // skip the hint with no observable failure). Returned origin is
    // arbitrary but consistent across the two reads — only the
    // difference matters here.
    const executionStartTime = performance.now();

    let result;
    try {
      result = await resultPromise;
    } finally {
      // Cancel any pending trailing flush — the command has settled (or
      // threw) and either the final ToolResult carries the complete output
      // or the caller will surface an error. Either way the timer must not
      // fire a stale frame after we've returned. `finally` covers both the
      // happy path and the (theoretical) reject path so no timer leaks.
      cancelTrailingFlush();
      combinedSignal.removeEventListener('abort', onAbort);
    }

    // Background-promote path: the user pressed Ctrl+B (PR-3 wires the
    // keybind to `promoteAbortController.abort({ kind: 'background' })`),
    // ShellExecutionService skipped the kill, snapshotted the output up
    // to that moment, and resolved with `promoted: true`. Per #3831
    // design question 7, `result.aborted` is `false` for promoted
    // results, so this branch is checked BEFORE the `if (result.aborted)`
    // arm and falls through naturally to the success-shape arm if
    // promote didn't fire.
    //
    // What we do here:
    //   1. Generate a `bg_xxx` shell id + on-disk output path under the
    //      same project temp dir `executeBackground` uses.
    //   2. Write `result.output` (the snapshot ShellExecutionService
    //      built right before promote) to the file as the initial
    //      content. The agent / `/tasks` / dialog can `Read` this file.
    //   3. Register a `BackgroundShellEntry` with the existing pid +
    //      a FRESH `AbortController` whose abort listener kills the
    //      still-running child (mirroring `ShellExecutionService`'s
    //      SIGTERM → 200ms → SIGKILL cascade) and sync-marks the
    //      entry `cancelled`. `task_stop bg_xxx` and the dialog's
    //      `x` key route through `entry.abortController.abort()` →
    //      kill listener → child gets SIGTERM/SIGKILL. Reusing the
    //      already-aborted `promoteAbortController` would have made
    //      `task_stop` a no-op (Web `AbortController.abort()` is
    //      idempotent on already-aborted controllers per spec) — see
    //      `handlePromotedForeground` for the full rationale.
    //   4. Return a model-facing `ToolResult` with promote-flavored copy
    //      pointing the agent at `/tasks` / the Background tasks dialog
    //      / `task_stop` for follow-up.
    //
    // KNOWN LIMITATION (deferred to PR-2.5): post-promote, the
    // ShellExecutionService no longer streams output to the file (PR-1
    // detached its data listener as part of the ownership-transfer
    // contract), and there's no path for the registry entry to settle
    // when the underlying child exits naturally. The entry stays
    // `'running'` until `task_stop bg_xxx` or session shutdown
    // (`abortAll`) clears it. PR-2.5 will add post-promote stream
    // redirect (so /tasks shows live output) and a settle hook (so
    // natural exit transitions the entry to `completed`/`failed`).
    if (result.promoted) {
      const promotedToolResult = await this.handlePromotedForeground(
        result,
        cwd,
        commandToExecute,
        promoteAbortController,
      );
      return promotedToolResult;
    }

    let llmContent = '';
    if (result.aborted) {
      // Check if it was a timeout or user cancellation. Exclude BOTH
      // the user signal AND the promote signal — the latter matters
      // when PR-3's Ctrl+B keybind fires `promoteAbortController.abort`
      // but the service's race guard refused promotion (the child
      // terminated a beat earlier). The result then lands with
      // `aborted: true, promoted: false`; without the
      // `promoteAbortController.signal.aborted` exclusion, the
      // foreground path would falsely report "Command timed out" for
      // a process that finished naturally.
      const wasTimeout =
        effectiveTimeout &&
        combinedSignal.aborted &&
        !signal.aborted &&
        !promoteAbortController.signal.aborted;
      const wasPromoteRefused =
        promoteAbortController.signal.aborted && !signal.aborted;

      if (wasTimeout) {
        llmContent = `Command timed out after ${effectiveTimeout}ms before it could complete.`;
        if (result.output.trim()) {
          llmContent += ` Below is the output before it timed out:\n${result.output}`;
        } else {
          llmContent += ' There was no output before it timed out.';
        }
      } else if (wasPromoteRefused) {
        // The user pressed Ctrl+B (promote) but the service refused —
        // typically the child had already terminated by the time the
        // signal was checked. Treat as a benign race: report what
        // actually happened (the run completed, just without the
        // promote handoff) rather than as a cancellation or timeout.
        llmContent =
          'Command finished before the background-promote request could be honoured (the child had already exited).';
        if (result.output.trim()) {
          llmContent += ` Output:\n${result.output}`;
        }
      } else {
        llmContent = 'Command was cancelled by user before it could complete.';
        if (result.output.trim()) {
          llmContent += ` Below is the output before it was cancelled:\n${result.output}`;
        } else {
          llmContent += ' There was no output before it was cancelled.';
        }
      }
    } else {
      // Create a formatted error string for display, replacing the wrapper command
      // with the user-facing command.
      const finalError = result.error
        ? result.error.message.replace(commandToExecute, this.params.command)
        : '(none)';

      llmContent = [
        `Command: ${this.params.command}`,
        `Directory: ${this.params.directory || '(root)'}`,
        `Output: ${result.output || '(empty)'}`,
        `Error: ${finalError}`, // Use the cleaned error string.
        `Exit Code: ${result.exitCode ?? '(none)'}`,
        `Signal: ${result.signal ?? '(none)'}`,
        `Process Group PGID: ${result.pid ?? '(none)'}`,
      ].join('\n');

      // (Long-run advisory append happens AFTER `truncateToolOutput`
      // below — see the explanation there for why post-truncation.)
    }

    // Run attribution outside the aborted/non-aborted branch: a
    // `git commit -m "x" && sleep 999` chain can move HEAD and then
    // time out, leaving the new commit without its attribution note
    // while the stale per-file attribution stays around for a later
    // unrelated commit. attachCommitAttribution already gates on HEAD
    // movement, so it's a no-op when no commit was actually created.
    let attributionWarning: string | null = null;
    if (commitCtx.attributableInCwd) {
      // `git commit --amend` rewrites HEAD in place, so the standard
      // parent-vs-postHead diff (`${postHead}~1..${postHead}`) would
      // span the entire amended commit (the amended commit's parent
      // is the original's parent, so diffing against it lumps both
      // commits' worth of changes). Detect the flag so
      // `getCommittedFileInfo` can switch to `${preHead}..${postHead}`
      // — `preHead` was captured synchronously before spawn and is
      // the pre-amend SHA, so this range captures only the amend
      // delta.
      const isAmend = isAmendCommit(strippedCommand);
      attributionWarning = await this.attachCommitAttribution(
        cwd,
        preHead,
        isAmend,
      );
    }
    // Intentionally NO `else if (commitCtx.hasCommit)` cleanup branch:
    // commands that match `hasCommit` but not `attributableInCwd`
    // (e.g. `cd /abs/path/to/this/repo && git commit`, `git -C . commit`)
    // can land a commit in our cwd, but we don't know which files were
    // staged — the user may have done a partial `git add A` and left
    // unstaged AI edits to B and C pending. A wholesale
    // `clearAttributions(true)` here would silently lose B and C even
    // though they weren't committed. Leave the singleton alone; the
    // next attributable commit's `attachCommitAttribution` will do a
    // proper partial clear via `clearAttributedFiles`.

    // Decide whether to emit the long-run advisory. Conditions:
    //   - Process completed under its own steam (no AbortSignal
    //     trigger, no external signal). Specifically:
    //       * Suppressed on aborted (`result.aborted: true`) — covers
    //         the `if (result.aborted)` arm above (timeout / user-
    //         cancel). Their own messaging is enough; a "should have
    //         been background" reminder when the agent already knows
    //         the command didn't complete is noise.
    //       * Suppressed on external signal kills (`result.signal !=
    //         null` with `aborted: false`, e.g. SIGTERM from container
    //         shutdown, k8s eviction, OOM killer, sibling reaping the
    //         process group). `shellExecutionService` only sets
    //         `aborted` when the AbortSignal we passed was triggered,
    //         so external signals fall through to the non-aborted
    //         branch — same rationale as timeout.
    //   - Wall-clock duration ≥ threshold. Measured spawn → resultPromise
    //     settle, intentionally BEFORE the post-processing block below
    //     (truncation I/O, output-file write). The hint reports how long
    //     the COMMAND blocked the agent, not how long the tool call
    //     spent including post-processing — that's the number the agent
    //     should be reasoning about when deciding whether to background
    //     next time. Truncation time is bounded by the temp-dir backend
    //     and isn't representative of the command's actual wait.
    // Fires on both successful and naturally-failed completions since
    // the advice ("next time, background it") is the same in both.
    const elapsedMs = performance.now() - executionStartTime;
    const longRunThreshold = longRunThresholdFor(effectiveTimeout);
    const shouldAppendLongRunHint =
      !result.aborted &&
      result.signal === null &&
      elapsedMs >= longRunThreshold;
    // Observability: the hint decision is otherwise invisible. If a
    // user reports "my 65s command didn't get the hint" or "5s command
    // got the hint", the debug log shows which suppression branch fired
    // (aborted / signal / under-threshold) plus the actual elapsed and
    // computed threshold. No PII — just timing + result flags.
    debugLogger.debug(
      `long-run hint: elapsed=${Math.round(elapsedMs)}ms threshold=${longRunThreshold}ms ` +
        `aborted=${result.aborted} signal=${result.signal} → ${shouldAppendLongRunHint ? 'fire' : 'suppress'}`,
    );

    // returnDisplayMessage build order — chronologically:
    //   1. Initial value: in debug mode, snapshot of pre-truncation
    //      `llmContent`; in non-debug mode, terse output-or-status.
    //   2. Truncation block (below) appends `Output too long and was
    //      saved to: <path>` if truncation fired (BOTH modes).
    //   3. Long-run hint append (further below) appends the hint
    //      itself with append-style re-sync (BOTH modes), so the user
    //      sees the same advisory the agent does — otherwise the
    //      agent would suddenly suggest `is_background: true` with no
    //      visible trigger in the TUI.
    // The pre-existing debug snapshot is captured here (pre-truncation,
    // pre-hint); both subsequent steps APPEND to it rather than
    // replacing, so all information accumulates rather than being lost
    // when later steps fire.
    let returnDisplayMessage = '';
    if (this.config.getDebugMode()) {
      returnDisplayMessage = llmContent;
    } else {
      if (result.output.trim()) {
        returnDisplayMessage = result.output;
      } else {
        if (result.aborted) {
          // Check if it was a timeout, a refused-promote, or a real user
          // cancellation. See the matching block above for why we also
          // exclude `promoteAbortController.signal.aborted` from the
          // timeout discriminator.
          const wasTimeout =
            effectiveTimeout &&
            combinedSignal.aborted &&
            !signal.aborted &&
            !promoteAbortController.signal.aborted;
          const wasPromoteRefused =
            promoteAbortController.signal.aborted && !signal.aborted;

          returnDisplayMessage = wasTimeout
            ? `Command timed out after ${effectiveTimeout}ms.`
            : wasPromoteRefused
              ? 'Command finished before background-promote could be honoured.'
              : 'Command cancelled by user.';
        } else if (result.signal) {
          returnDisplayMessage = `Command terminated by signal: ${result.signal}`;
        } else if (result.error) {
          returnDisplayMessage = `Command failed: ${getErrorMessage(
            result.error,
          )}`;
        } else if (result.exitCode !== null && result.exitCode !== 0) {
          returnDisplayMessage = `Command exited with code: ${result.exitCode}`;
        }
        // If output is empty and command succeeded (code 0, no error/signal/abort),
        // returnDisplayMessage will remain empty, which is fine.
      }
    }

    // Truncate large output and save full content to a temp file.
    if (typeof llmContent === 'string') {
      const truncatedResult = await truncateToolOutput(
        this.config,
        ShellTool.Name,
        llmContent,
      );

      if (truncatedResult.outputFile) {
        llmContent = truncatedResult.content;
        returnDisplayMessage +=
          (returnDisplayMessage ? '\n' : '') +
          `Output too long and was saved to: ${truncatedResult.outputFile}`;
      }
    }

    // Append the long-run advisory AFTER truncation so the hint isn't
    // wrapped in `truncateToolOutput`'s "Truncated part of the output"
    // header (which the LLM might misread as part of the command's own
    // output). The hint is process metadata about the command, not
    // command output, so it belongs outside the truncation envelope.
    const longRunHint = shouldAppendLongRunHint
      ? buildLongRunningForegroundHint(elapsedMs)
      : null;
    if (longRunHint) {
      if (typeof llmContent === 'string') {
        llmContent += `\n\n${longRunHint}`;
        // Surface the hint in the user-facing TUI too — the user is
        // the one waiting for long commands and benefits from the
        // same "consider backgrounding next time" cue the agent sees.
        // Append (not replace) in BOTH modes so the truncation marker
        // line ("Output too long and was saved to: ...") and any
        // pre-existing returnDisplayMessage content (debug snapshot,
        // status line, command output) are preserved.
        returnDisplayMessage +=
          (returnDisplayMessage ? '\n\n' : '') + longRunHint;
      }
      // else: llmContent is a structured `Part[]` / `Part` rather than
      // a plain string. Today shell.ts only emits string llmContent,
      // but the type union allows structured content. If a future
      // refactor changes that, the hint silently disappears here. We
      // accept that risk for now — the alternative (encoding the hint
      // as a Part) would require deciding on a rendering convention,
      // and structured llmContent isn't on the roadmap. Revisit if
      // someone adds a non-string return path.
    }

    // Surface AI-attribution failures (note exec failure, payload too
    // large, diff-analysis exception, shallow clone, etc.) on the tool
    // result so the user knows their commit succeeded but the per-file
    // git note didn't land. Without this, the only signal is a
    // QWEN_DEBUG_LOG_FILE entry the user has likely never set up.
    // Appended to BOTH llmContent (so the agent can react / report) and
    // returnDisplayMessage (so the human sees it in the TUI). Skipped
    // when null (intentional skips like a bare `git commit` with no
    // tracked AI edits don't need user-visible feedback).
    if (attributionWarning) {
      if (typeof llmContent === 'string') {
        llmContent += `\n\n${attributionWarning}`;
      }
      returnDisplayMessage +=
        (returnDisplayMessage ? '\n\n' : '') + attributionWarning;
    }

    // When `result.error` is set, `coreToolScheduler` builds the
    // model-facing functionResponse from `error.message`, NOT from
    // `llmContent` (see `convertToFunctionResponse` and the error
    // branch in scheduler's success/error split). So if a long
    // command hits this path the hint we appended to llmContent above
    // would be silently dropped before reaching the agent. Append the
    // hint to error.message too so the advisory survives whichever
    // branch the scheduler takes.
    //
    // Note on reach: `ShellExecutionResult.error` is reserved for
    // SPAWN / setup failures (per the field's doc comment in
    // shellExecutionService.ts); non-zero exits leave it null. Real
    // spawn failures (ENOENT, permission denied) typically resolve in
    // <1s, so the elapsed >= threshold + spawn-error combination is
    // rare. The preservation is here for the slow-spawn edge cases
    // (PTY init dragging, remote-fs exec syscalls, security scanners
    // interposing) where the rare path could still trigger and the
    // hint would otherwise vanish.
    //
    // Use a `---` divider line so downstream consumers of
    // `error.message` (firePostToolUseFailureHook, telemetry grouping,
    // SIEM alerting, hook-side error parsers) have an unambiguous
    // boundary they can split on rather than getting ~400 chars of
    // advisory text mixed inline with the original error body.
    const executionError = result.error
      ? {
          error: {
            message:
              result.error.message +
              (longRunHint ? `\n\n---\n${longRunHint}` : ''),
            type: ToolErrorType.SHELL_EXECUTE_ERROR,
          },
        }
      : {};

    return {
      llmContent,
      returnDisplay: returnDisplayMessage,
      ...executionError,
    };
  }

  /**
   * Foreground → background promote handler. Called when the foreground
   * execute path observes `result.promoted: true` (the user pressed
   * Ctrl+B mid-flight). Snapshots captured output to a `bg_xxx.output`
   * file, registers a `BackgroundShellEntry` in the same registry the
   * `is_background: true` path uses, and returns a model-facing
   * `ToolResult` pointing at `/tasks` / the dialog / `task_stop` for
   * follow-up.
   *
   * Limitations (PR-2.5 follow-up):
   *   - The registry entry stays `'running'` until `task_stop bg_xxx`
   *     or session-end `abortAll` clears it; natural child exit does
   *     NOT auto-settle the entry today (no settle hook from the
   *     service after promote — the listener was detached as part of
   *     PR-1's ownership-transfer contract).
   *   - The `outputPath` content is FROZEN at the promote moment; the
   *     service no longer streams post-promote bytes to the file.
   *     Caller-side stream redirect lands in PR-2.5.
   */
  private async handlePromotedForeground(
    result: ShellExecutionResult,
    cwd: string,
    commandToExecute: string,
    abortController: AbortController,
  ): Promise<ToolResult> {
    // Mirror executeBackground's outputPath layout so /tasks-on-disk and
    // ReadFileTool's auto-allow rules treat foreground-promoted shells
    // and originally-background shells identically.
    const outputDir = path.join(
      this.config.storage.getProjectTempDir(),
      'background-shells',
      this.config.getSessionId(),
    );
    // The service has already detached its kill path by the time we
    // get here (PR-1's ownership-transfer contract), so any throw
    // before we wire up the registry's kill listener leaves the still-
    // running child as an orphan zombie that nothing can stop until
    // the OS reaps it on session end. Wrap the mkdir + write best-
    // effort: if either fails, log + reap the child immediately and
    // report the failure to the caller (mirrors the safety pattern
    // around `registry.register` further down).
    let mkdirError: Error | undefined;
    try {
      fs.mkdirSync(outputDir, { recursive: true });
    } catch (err) {
      mkdirError = err instanceof Error ? err : new Error(String(err));
    }
    if (mkdirError) {
      debugLogger.warn(
        `promote: mkdirSync(${outputDir}) failed before registry register — killing orphan child: ${mkdirError.message}`,
      );
      const pid = result.pid;
      if (pid !== undefined) {
        if (os.platform() === 'win32') {
          try {
            const taskkillChild = childProcess.spawn('taskkill', [
              '/pid',
              String(pid),
              '/f',
              '/t',
            ]);
            taskkillChild.on('error', () => {
              /* swallow — already in error path */
            });
          } catch {
            /* swallow */
          }
        } else {
          try {
            process.kill(-pid, 'SIGTERM');
          } catch {
            /* swallow — pid gone or perms */
          }
        }
      }
      throw mkdirError;
    }

    const shellId = `bg_${crypto.randomBytes(4).toString('hex')}`;
    const outputPath = path.join(outputDir, `shell-${shellId}.output`);
    // Best-effort initial snapshot write — if disk is full or
    // permission flips, log + continue (the registry entry is still
    // valuable on its own; the file is only the inspection surface).
    try {
      fs.writeFileSync(outputPath, result.output);
    } catch (err) {
      debugLogger.warn(
        `promote: failed to write initial output snapshot to ${outputPath}: ${getErrorMessage(err)}`,
      );
    }

    const startTime = Date.now();
    const registry = this.config.getBackgroundShellRegistry();
    // Create a FRESH AbortController for the registry entry. Using the
    // promote AbortController directly (which is already in the
    // `aborted` state — that's what triggered the promote) would be
    // a real bug: `task_stop bg_xxx` calls `entry.abortController.abort()`
    // which is a no-op on an already-aborted controller, AND
    // `ShellExecutionService` has detached its abort listener as part
    // of the promote handoff (PR-1's ownership-transfer contract), so
    // there's nobody left to translate the abort into an actual signal
    // to the still-running child. Instead, the entry gets a new
    // controller, and we wire the abort listener directly to send
    // SIGTERM → SIGKILL ourselves (mirroring the kill semantics
    // `ShellExecutionService.execute()`'s abort handler uses for the
    // non-promote path) and to mark the registry entry `cancelled`.
    const entryAc = new AbortController();
    const cancelChild = async () => {
      const pid = result.pid;
      if (pid !== undefined) {
        if (os.platform() === 'win32') {
          try {
            const taskkillChild = childProcess.spawn('taskkill', [
              '/pid',
              String(pid),
              '/f',
              '/t',
            ]);
            // Without an 'error' listener on the spawned ChildProcess,
            // a taskkill spawn failure (binary missing, permission
            // denied, etc.) would emit 'error' with no listener — which
            // crashes Node by default. Log + drop is the sane recovery:
            // the registry entry still transitions via `registry.cancel`
            // below; the still-running child is at worst an orphan,
            // which Windows reaps when the CLI session ends.
            taskkillChild.on('error', (err) => {
              debugLogger.warn(
                `promote: taskkill spawn failed for pid=${pid}: ${err.message}`,
              );
            });
          } catch (e) {
            // childProcess.spawn itself throwing (sync) is rare but possible
            // (e.g. EMFILE — too many open files) — same recovery.
            debugLogger.warn(
              `promote: childProcess.spawn('taskkill') threw for pid=${pid}: ${getErrorMessage(e)}`,
            );
          }
        } else {
          try {
            // Negative pid → kill the whole process group; matches the
            // `detached: !isWindows` spawn the foreground path uses.
            process.kill(-pid, 'SIGTERM');
            await new Promise((res) =>
              setTimeout(res, PROMOTE_CANCEL_SIGKILL_TIMEOUT_MS),
            );
            try {
              process.kill(-pid, 'SIGKILL');
            } catch {
              // Already dead before SIGKILL — happy path.
            }
          } catch (e) {
            debugLogger.warn(
              `promote: process.kill on -${pid} threw: ${getErrorMessage(e)}`,
            );
          }
        }
      }
      // Sync-mark the registry entry `cancelled` so /tasks reflects the
      // user intent immediately. (Recursive note: `registry.cancel`
      // calls `entry.abortController.abort()` internally, but our
      // entryAc is already aborted by the time we got here, so that
      // call is a no-op + our listener was `{ once: true }` and has
      // already detached.)
      registry.cancel(shellId, Date.now());
    };
    entryAc.signal.addEventListener('abort', () => void cancelChild(), {
      once: true,
    });
    const entry: BackgroundShellEntry = {
      shellId,
      // Use `commandToExecute` (post-co-author transform) so the registry
      // shows what actually ran. `this.params.command` is the pre-transform
      // form and would diverge for git-commit invocations that
      // `addCoAuthorToGitCommit()` rewrote (#3894 review).
      command: commandToExecute,
      cwd,
      pid: result.pid,
      status: 'running',
      startTime,
      outputPath,
      abortController: entryAc,
    };
    // Reference `abortController` so it's not unused — the parameter
    // is kept on the signature so a future PR-2.5 that needs to
    // double-link the original promote signal can read it without
    // re-plumbing.
    void abortController;

    // `registry.register` is internally safe today (Map.set + emit),
    // but if a future implementation throws, the promoted child is
    // already detached from the service and would become an orphan
    // zombie with no kill path. Wrap defensively: best-effort kill the
    // child and re-throw so the scheduler surfaces the failure instead
    // of pretending promote succeeded.
    try {
      registry.register(entry);
    } catch (e) {
      debugLogger.warn(
        `promote: registry.register threw for ${shellId} (pid=${result.pid}) — killing orphan child: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
      try {
        entryAc.abort();
      } catch {
        /* swallow — we're already in an error path */
      }
      throw e;
    }

    const llmContent = [
      `Foreground command "${commandToExecute}" promoted to background as ${shellId}.`,
      `Status: running. PID: ${result.pid ?? '(unknown)'}.`,
      `Output snapshot at promote time saved to: ${outputPath}`,
      `To inspect: \`/tasks\` (text), the Background tasks dialog (↓ + Enter on the footer pill), or \`Read\` the output file directly.`,
      `To stop the now-background process: \`task_stop({ task_id: '${shellId}' })\`.`,
    ].join('\n');

    debugLogger.debug(
      `promote: registered ${shellId} (pid=${result.pid}) — outputPath=${outputPath}`,
    );

    return {
      llmContent,
      returnDisplay: `Promoted to background: ${shellId}`,
    };
  }

  /**
   * Background-execution path: spawn the command into a managed registry
   * entry instead of detaching with `&`. Output streams to a per-shell file
   * the agent can `Read`; cancellation flows through the entry's
   * AbortController; the registry's terminal status is set when the process
   * exits. Returns immediately so the agent's turn isn't blocked.
   */
  private async executeBackground(
    signal: AbortSignal,
    shellExecutionConfig?: ShellExecutionConfig,
  ): Promise<ToolResult> {
    const strippedCommand = stripShellWrapper(this.params.command);

    // The background lifecycle (BackgroundShellRegistry) doesn't run
    // the post-command attribution path — there's no clean place to
    // hook pre/post-HEAD comparison and `git notes` writes between
    // the early `Background shell started` return and the eventual
    // process exit. Allowing `git commit` to slip through would leave
    // the new commit without notes and let stale per-file attribution
    // leak into the next foreground commit. Refuse the request and
    // tell the user to run it foreground.
    //
    // Use the broader `hasCommit` flag rather than `attributableInCwd`:
    // `cd /elsewhere && git commit` should still be refused even
    // though we wouldn't attribute it.
    if (gitCommitContext(strippedCommand).hasCommit) {
      return {
        llmContent:
          'Refusing to run `git commit` in background mode: AI-attribution notes ' +
          'are written by the foreground completion path. Re-run the commit ' +
          'with is_background=false (or split it out of the compound command).',
        returnDisplay:
          'Refused: `git commit` is not supported in background shell mode.',
      };
    }
    // Strip a single bare trailing `&` (the bash background operator) before
    // spawn: bash treats it as background-detach, exits the wrapper
    // immediately, and the real child outlives the wrapper — the registry
    // would settle as `completed` while the shell is still running, and
    // chunked output would land on a closed stream. The managed path is
    // itself the backgrounding mechanism, so the trailing `&` is redundant.
    //
    // Deliberately precise: do not touch `&&` (logical AND), `\&` (escaped
    // literal `&`), or commands without a trailing `&`. Earlier `\s*&+\s*$`
    // was both too greedy (it ate `&&` and `\&`) and a ReDoS hazard on
    // long all-`&` inputs. Plain string checks here are linear and clearer
    // than a lookbehind regex.
    //
    // Operate on the trimmed *original* command so leading env assignments
    // / shell wrappers survive through to execution; ShellExecutionService
    // re-runs the user-approved invocation verbatim.
    const trimmedOriginal = this.params.command.trim();
    const noTrailingAmp = stripTrailingBackgroundAmp(trimmedOriginal);
    if (noTrailingAmp !== trimmedOriginal) {
      debugLogger.warn(
        'Stripped trailing & from background shell command — managed path handles backgrounding',
      );
    }
    const processedCommand = this.addAttributionToPR(
      this.addCoAuthorToGitCommit(noTrailingAmp),
    );
    const cwd = this.params.directory || this.config.getTargetDir();

    // Output goes under the project temp dir (which `ReadFileTool`
    // auto-allows by default), so the LLM can `Read` the captured output
    // without bouncing off a permission prompt — important because
    // background-agent contexts can't surface interactive prompts.
    const outputDir = path.join(
      this.config.storage.getProjectTempDir(),
      'background-shells',
      this.config.getSessionId(),
    );
    fs.mkdirSync(outputDir, { recursive: true });

    const shellId = `bg_${crypto.randomBytes(4).toString('hex')}`;
    const outputPath = path.join(outputDir, `shell-${shellId}.output`);

    // Background shells are explicitly independent of the current turn:
    // the user pressing Ctrl+C on a turn (which aborts `signal`) should
    // NOT kill a long-running dev server / watcher they intentionally
    // backgrounded. Cancellation flows only through the entry's own
    // AbortController, driven by future `task_stop` integration (#3471).
    // The `signal` parameter is still honored for the synchronous early
    // return below (don't even spawn if the agent already aborted), but
    // we deliberately do not forward it.
    const entryAc = new AbortController();

    const outputStream = fs.createWriteStream(outputPath, { flags: 'w' });
    // Without an 'error' listener, a write failure (disk full, permission
    // change, fs going away) would surface as an uncaught exception and
    // kill the entire CLI session. Log + drop is the sane default — the
    // process keeps running, the registry still settles via resultPromise.
    outputStream.on('error', (err) => {
      debugLogger.warn(
        `background shell ${shellId} output write error: ${err.message}`,
      );
    });

    const startTime = Date.now();
    const entry: BackgroundShellEntry = {
      shellId,
      command: processedCommand,
      cwd,
      status: 'running',
      startTime,
      outputPath,
      abortController: entryAc,
    };

    const { result: resultPromise, pid } = await ShellExecutionService.execute(
      processedCommand,
      cwd,
      (event: ShellOutputEvent) => {
        if (event.type === 'data' && typeof event.chunk === 'string') {
          // Strip ANSI escape codes (color, cursor-move, clear-screen) before
          // writing — agents read the file as plain text, and dev servers /
          // build tools spam plenty of escape sequences that would render as
          // garbage. Costs ~one regex per chunk; cheap relative to disk I/O.
          outputStream.write(stripAnsi(event.chunk));
        }
        // ANSI array chunks and binary streams are not written to the output
        // file: agents read the file as plain text and binary spam would be
        // unhelpful.
      },
      entryAc.signal,
      // Background shells are non-interactive by design — no terminal to
      // attach a PTY to, no human to type at it. Force the child_process
      // path so we don't pull in node-pty for fire-and-forget commands.
      false,
      shellExecutionConfig ?? {},
      // Stream stdout/stderr through to the output file as chunks arrive.
      // Default child_process mode buffers until exit, which would leave
      // dev-server / watcher output files empty until the process dies.
      { streamStdout: true },
    );

    if (pid !== undefined) entry.pid = pid;
    const registry = this.config.getBackgroundShellRegistry();
    registry.register(entry);

    // Settle in the background — do NOT await here, the agent should be
    // unblocked immediately.
    void resultPromise.then(
      (result) => {
        outputStream.end();
        const endTime = Date.now();
        if (entryAc.signal.aborted) {
          if (registry.get(shellId)?.status === 'running') {
            registry.cancel(shellId, endTime);
          }
        } else if (
          result.error ||
          (result.exitCode !== null && result.exitCode !== 0) ||
          result.signal !== null
        ) {
          // Non-zero exit / killed by signal / spawn error all count as failed.
          // Treating them as `completed` would let `/tasks` (and any future
          // model-facing notification) misreport a failed `npm test` or
          // `false` command as a success.
          const reason = result.error
            ? result.error.message
            : result.signal !== null
              ? `terminated by signal ${result.signal}`
              : `exited with code ${result.exitCode}`;
          registry.fail(shellId, reason, endTime);
        } else {
          registry.complete(shellId, result.exitCode ?? 0, endTime);
        }
      },
      (err) => {
        outputStream.end();
        registry.fail(shellId, getErrorMessage(err), Date.now());
      },
    );

    const pidLine = pid !== undefined ? `pid: ${pid}\n` : '';
    return {
      llmContent:
        `Background shell started.\n` +
        `id: ${shellId}\n` +
        pidLine +
        `output file: ${outputPath}\n` +
        `To inspect: /tasks (text) or the interactive Background tasks dialog (focus the footer Background tasks pill, then Enter — detail view + live updates). Read the output file directly to view the captured output.`,
      returnDisplay: `Background shell ${shellId} started${pid !== undefined ? ` (pid ${pid})` : ''}.`,
    };
  }

  /**
   * Count the commits between `preHead` (exclusive) and `postHead`
   * (inclusive). SHA-pinned on both ends so a post-commit hook moving
   * HEAD between this check and the note write can't change the
   * answer (`HEAD~1..HEAD` here would race the same TOCTOU window
   * the diff calls were just pinned against). Returns 0 if either
   * side is unreadable. Goes through `child_process.execFile` with
   * argv to stay independent of the mockable `ShellExecutionService`.
   */
  private async countCommitsAfter(
    cwd: string,
    preHead: string,
    postHead: string,
  ): Promise<number> {
    return this.runGitCount(cwd, [
      'rev-list',
      '--count',
      `${preHead}..${postHead}`,
    ]);
  }

  /**
   * Count commits reachable from `postHead` when the repo had no prior
   * HEAD before the user's command — i.e. the very first commit (or
   * compound `init && commit && commit ...`). Without this fallback
   * the multi-commit guard would be skipped on a brand-new repo and
   * mis-attribute combined data to the final commit. SHA-pinned for
   * the same reason as `countCommitsAfter`.
   */
  private async countCommitsFromRoot(
    cwd: string,
    postHead: string,
  ): Promise<number> {
    return this.runGitCount(cwd, ['rev-list', '--count', postHead]);
  }

  /** Shared helper for the two `rev-list --count` invocations. */
  private async runGitCount(cwd: string, args: string[]): Promise<number> {
    return new Promise((resolve) => {
      const child = childProcess.execFile(
        'git',
        args,
        { cwd, timeout: 2000 },
        (error, stdout) => {
          if (error) {
            resolve(0);
            return;
          }
          const n = parseInt(String(stdout).trim(), 10);
          resolve(Number.isFinite(n) && n > 0 ? n : 0);
        },
      );
      child.on('error', () => {});
    });
  }

  /**
   * Read the current HEAD SHA, or null if unavailable (no commits
   * yet, not a git repo, or git failed). Used to detect whether a
   * `git commit` actually created a new commit, independent of the
   * shell's exit code. Goes through `child_process.execFile` rather
   * than {@link ShellExecutionService} so the lookup is unaffected
   * by test mocks of the shell service and stays well clear of any
   * user-supplied shell wrapper.
   */
  private async getGitHead(cwd: string): Promise<string | null> {
    return new Promise((resolve) => {
      const child = childProcess.execFile(
        'git',
        ['rev-parse', 'HEAD'],
        { cwd, timeout: 2000 },
        (error, stdout) => {
          if (error) {
            resolve(null);
            return;
          }
          const sha = String(stdout).trim();
          resolve(sha.length > 0 ? sha : null);
        },
      );
      // Suppress unhandled-error events from the child stream (e.g. ENOENT
      // when git is missing); the callback still receives the error.
      child.on('error', () => {});
    });
  }

  /**
   * Synchronous companion to {@link getGitHead}. Captured BEFORE the
   * user's shell command spawns so a fast `git commit` (hot-cached,
   * no hooks) cannot move HEAD before our async rev-parse has a chance
   * to read it — a real race seen on slow filesystems / heavy contention
   * where preHead would otherwise resolve to the new SHA, postHead would
   * match, and `attachCommitAttribution` would silently skip writing the
   * attribution note even though the commit succeeded.
   *
   * Worst case is ~10–50 ms of event-loop block per commit-shaped shell
   * command; acceptable trade for correctness of the post-command HEAD
   * comparison.
   */
  private getGitHeadSync(cwd: string): string | null {
    try {
      const stdout = childProcess.execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd,
        timeout: 2000,
        // Discard stderr noise (e.g. "fatal: not a git repository") —
        // the catch-or-empty-output path already covers failure.
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      const sha = String(stdout).trim();
      return sha.length > 0 ? sha : null;
    } catch {
      return null;
    }
  }

  /**
   * After a successful git commit, attach per-file AI attribution metadata
   * as git notes. Analyzes staged files via `git diff` to calculate real
   * AI vs human contribution percentages.
   *
   * Detects commit creation by HEAD movement, not by shell exit code:
   * for compound commands like `git commit -m "x" && npm test`, the
   * commit can succeed and a later step can fail. Gating on `exitCode
   * !== 0` would skip attribution for the successful commit, so we
   * compare pre- and post-command HEAD instead.
   *
   * Respects the gitCoAuthor.commit setting: if the user disables commit
   * attribution, the per-file note is skipped too (same toggle governs
   * the Co-authored-by trailer and the git-notes payload).
   */
  private async attachCommitAttribution(
    cwd: string,
    preHead: string | null,
    isAmend: boolean,
  ): Promise<string | null> {
    // Returns a one-line warning suitable for appending to the tool's
    // returnDisplay when a write that the user could plausibly fix
    // (note exec failure, payload too large, exception during diff
    // analysis) drops the AI-attribution note. Returns null when the
    // skip is intentional / inherent to the situation (no commit
    // landed, multi-commit chain, attribution toggle off, no tracked
    // edits) — those don't need user-visible feedback.
    // Caller (`execute`) gates this with `commitCtx.attributableInCwd`,
    // so we don't re-parse the command here. Re-parsing would be dead
    // work and a maintenance trap — if the two checks ever drifted,
    // trailer injection and git-notes writes could diverge silently.

    const postHead = await this.getGitHead(cwd);
    const commitCreated = postHead !== null && postHead !== preHead;
    const attributionService = CommitAttributionService.getInstance();

    if (!commitCreated) {
      // HEAD didn't move in this cwd. Possible causes:
      //   1. Commit failed (hook rejected, nothing staged, etc.)
      //   2. User did `git commit && git reset HEAD~1` — HEAD reverted
      //   3. Submodule case (`cd submodule && git commit`) — the inner
      //      repo's HEAD moved, ours didn't
      // We can't tell these apart reliably from here. Dropping the
      // per-file attributions on (1)/(2) is fine in isolation, but on
      // (3) we'd silently lose the user's outer-repo edits even though
      // none of them were committed. Leave attributions intact instead:
      // a later successful commit will overwrite the counters and the
      // accumulated aiContribution still represents real AI work.
      return null;
    }

    // Refuse to attribute when a single shell command produced more
    // than one commit (e.g. `git commit -m a && git commit -m b`).
    // Our singleton has no way to partition the per-file AI
    // contribution across the individual commits, so attaching the
    // combined note to HEAD would mis-attribute earlier commits'
    // changes to the last one. Snapshot prompt counters and bail.
    //
    // For a brand-new repo (preHead === null), use `git rev-list
    // --count HEAD` so the very first compound `init && commit a &&
    // commit b` chain still gets caught.
    const commitCount =
      preHead !== null
        ? await this.countCommitsAfter(cwd, preHead, postHead)
        : await this.countCommitsFromRoot(cwd, postHead);
    // commitCreated has already established that HEAD moved, so we
    // expect exactly 1 commit. Anything else is suspicious:
    // - >1: actual multi-commit chain we can't partition
    // - 0:  rev-list errored / timed out — could not verify, so
    //   we'd otherwise silently attribute as a single commit even
    //   though the count is unknown
    // Bail in either case.
    if (commitCount !== 1) {
      const reason =
        commitCount === 0
          ? 'commit count unavailable (rev-list failed) ' +
            'after HEAD moved — refusing to assume single commit'
          : `multi-commit shell command (${commitCount} commits since ` +
            `${preHead ? preHead.slice(0, 12) : 'repo root'})`;
      debugLogger.warn(`Refusing AI attribution: ${reason}.`);
      // Snapshot the prompt counter but do NOT clear per-file
      // attributions: in a `commit a && commit b` chain, the user
      // may have unstaged AI edits to files that appeared in NEITHER
      // commit. Wholesale-clearing here would erase those even
      // though the rest of the flow is built to preserve unstaged
      // entries across partial commits.
      attributionService.noteCommitWithoutClearing();
      return null;
    }

    // A new commit landed. Even when no per-file attribution was
    // tracked (rare but possible — e.g. user committed external
    // changes), we still need to snapshot the prompt counters as
    // "at last commit" so a later `gh pr create` doesn't report an
    // inflated N-shotted count spanning multiple commits.
    if (!attributionService.hasAttributions()) {
      attributionService.noteCommitWithoutClearing();
      return null;
    }

    let committedAbsolutePaths: Set<string> | null = null;
    // Separate from `committedAbsolutePaths` so a failed note write
    // (oversized payload, `git notes` non-zero exit, exception) does
    // NOT also delete the per-file attribution data the user might
    // need to amend & retry. `shouldClear` flips to the partial-clear
    // set only on (a) note-write success, or (b) attribution toggle
    // OFF — both cases where the file is genuinely "done" from the
    // attribution path's POV.
    let shouldClear: Set<string> | null = null;
    let warning: string | null = null;
    try {
      // Analyze the just-committed files by diffing the captured
      // `postHead` against its parent (or `preHead` for amend). All
      // diff calls are SHA-pinned so a post-commit hook / chained
      // `git tag` / parallel git process moving HEAD between the
      // analysis phase and the note write can't leave the note
      // attached to commit A but describing commit B.
      const stagedInfo = await this.getCommittedFileInfo(
        cwd,
        isAmend,
        postHead,
        preHead,
      );

      // null = analysis failed (shallow clone, --amend without reflog,
      // partial diff failure, etc.). Leave `committedAbsolutePaths`
      // null so the finally block calls `noteCommitWithoutClearing()`
      // — snapshotting the prompt counter while leaving per-file
      // attributions intact. (Earlier revisions of this code did a
      // wholesale clear here, but that erased pending unstaged AI
      // edits for files outside the just-failed commit; the
      // smaller-evil trade-off is documented in the finally block.)
      // Skip the note write entirely — emitting a structurally valid
      // but factually wrong all-zero note is worse than no note.
      if (stagedInfo === null) {
        warning =
          'AI attribution note skipped: could not analyze the commit ' +
          'diff (shallow clone, missing reflog for --amend, or partial ' +
          '`git diff` failure). Co-authored-by trailer is unaffected.';
        return warning; // finally still runs for cleanup
      }

      // Pass the actual model name (e.g. `qwen3-coder-plus`) rather than the
      // co-author display label so the note's `generator` field reflects
      // which model produced the changes — and so generateNotePayload's
      // sanitizeModelName() actually has the codename it's meant to scrub.
      // The base directory must be the git repo root: getCommittedFileInfo
      // returns paths relative to `git rev-parse --show-toplevel`, and any
      // mismatch here would cause path.relative to produce `../...` keys
      // that never match in the AI-attribution lookup.
      const baseDir = stagedInfo.repoRoot ?? this.config.getTargetDir();

      // Capture the absolute paths actually included in this commit so
      // the finally block can do a partial clear: files the AI edited
      // but the user didn't `git add` should still be tracked for a
      // later commit.
      //
      // Match against the canonical keys already stored in
      // `fileAttributions` (recordEdit canonicalises every component
      // via realpathSync) rather than re-resolving each diff path on
      // the fly. Re-resolving fails for deleted files (realpathSync
      // throws on a missing leaf) and for files behind intermediate
      // symlinked directories (path.resolve only canonicalises the
      // base) — both cases produced cleanup keys that didn't match
      // the stored canonical keys, leaking stale per-file attribution
      // into subsequent commits.
      let canonicalBase: string;
      try {
        canonicalBase = fs.realpathSync(baseDir);
      } catch {
        canonicalBase = baseDir;
      }

      attributionService.applyCommittedRenames(
        stagedInfo.renamedFiles,
        canonicalBase,
      );

      // First-pass match: which tracked entries are part of THIS
      // commit? Validation must run against this subset only — a
      // tracked file the user didn't stage isn't in HEAD's new tree
      // post-commit (HEAD still has the pre-AI-edit version), so
      // `git show HEAD:<rel>` would return the OLD content and the
      // hash divergence check would drop the AI's pending unstaged
      // work. Scope the reader to the committed set only.
      const committedScope = attributionService.matchCommittedFiles(
        stagedInfo.files,
        canonicalBase,
      );

      // Drop tracked entries whose COMMITTED content has diverged
      // from what AI's last write recorded — catches the case where
      // the user paste-replaced via an external editor, ran
      // `git checkout`, or otherwise modified the file outside the
      // Edit/Write tools. Validate against the COMMITTED blob rather
      // than the live working tree: the user can `git add` AI's
      // content, then make additional unstaged edits, then
      // `git commit` — the commit's blob still matches AI's recorded
      // hash, but the working-tree file does not. A working-tree
      // comparison would drop the entry on a commit that legitimately
      // came from AI.
      //
      // Pin the read to the captured `postHead` SHA, NOT the symbolic
      // `HEAD`, for the same TOCTOU reason `buildGitNotesCommand`
      // does: a post-commit hook or chained command can advance HEAD
      // between our postHead capture and these reads, and a symbolic
      // `git show HEAD:<rel>` would then compare against the WRONG
      // commit's content and spuriously drop entries.
      attributionService.validateAgainst((absPath) => {
        // ONLY check files that landed in this commit. Anything else
        // (unstaged AI work, files in other directories) returns null
        // so validateAgainst leaves them alone.
        if (!committedScope.has(absPath)) return null;
        const rel = path
          .relative(canonicalBase, absPath)
          .split(path.sep)
          .join('/');
        if (!rel || rel.startsWith('..')) return null;
        try {
          return childProcess
            .execFileSync('git', ['show', `${postHead}:${rel}`], {
              cwd,
              timeout: 2000,
              stdio: ['ignore', 'pipe', 'ignore'],
              maxBuffer: 16 * 1024 * 1024,
            })
            .toString('utf-8');
        } catch {
          // No committed content (deleted file, file not in the
          // commit, or git error) — leave the entry alone.
          return null;
        }
      });

      // Recompute the committed set after validation: dropped entries
      // shouldn't appear in the per-file payload OR in the partial
      // clear set (they were already deleted from fileAttributions).
      committedAbsolutePaths = attributionService.matchCommittedFiles(
        stagedInfo.files,
        canonicalBase,
      );

      // No file in this commit was AI-touched in the current session.
      // Writing a note anyway would emit an all-zero "0% AI" payload
      // attached to a commit that legitimately had no AI involvement
      // — actively misleading. Skip the note; the partial clear in
      // the finally block is a no-op (empty set) so unrelated pending
      // attributions stay tracked for a later commit.
      if (committedAbsolutePaths.size === 0) {
        return null;
      }

      // Toggle gate AFTER computing committedAbsolutePaths so the
      // finally block still does a proper partial clear of files
      // that just landed. Without this, a user who turned off
      // attribution would have those just-committed files' tracked
      // AI work sit in the singleton; flipping the toggle back on
      // and committing the same file again would re-attribute the
      // earlier (already-committed) AI edits to the new commit.
      const gitCoAuthorSettings = this.config.getGitCoAuthor();
      if (!gitCoAuthorSettings.commit) {
        // Toggle-off but the commit landed — partial-clear the files
        // that just landed so re-enabling later doesn't re-attribute
        // earlier (already-committed) AI edits to a future commit.
        shouldClear = committedAbsolutePaths;
        return null;
      }

      const note = attributionService.generateNotePayload(
        stagedInfo,
        baseDir,
        this.config.getModel(),
      );
      // Pin the note to the SHA we captured at commit-detection time
      // (`postHead`) rather than the symbolic `HEAD`. A post-commit
      // hook, chained `git commit && git tag -m ...`, or parallel
      // process can advance HEAD between that capture and this
      // execFile — without the SHA pin, `-f` would silently land the
      // note on the wrong commit.
      const notesCommand = buildGitNotesCommand(note, postHead);

      if (!notesCommand) {
        debugLogger.warn(
          'AI attribution note too large, skipping git notes attachment',
        );
        warning =
          'AI attribution note skipped: payload exceeded the 30 KB ' +
          'size cap (large generated-file exclusion list?). ' +
          'Co-authored-by trailer is unaffected.';
        // Leave per-file state intact: the user might `git commit
        // --amend` after pruning excluded paths, and partial-clearing
        // here would erase the data they'd need to retry.
        return warning;
      }

      // Use execFile with argv (rather than ShellExecutionService) so the
      // JSON note isn't subjected to shell quoting at all — important on
      // Windows where the bash-style escape used previously is invalid
      // for cmd.exe / PowerShell. 5s timeout keeps a wedged repo from
      // stalling the user-visible turn.
      const { exitCode, output, timedOut } = await new Promise<{
        exitCode: number | null;
        output: string;
        timedOut: boolean;
      }>((resolve) => {
        const child = childProcess.execFile(
          notesCommand.command,
          notesCommand.args,
          { cwd, timeout: 5000 },
          (error, stdout, stderr) => {
            const merged = (stdout || '') + (stderr || '');
            if (error) {
              // execFile signals timeout via either `error.killed === true`
              // + `error.signal === 'SIGTERM'` (default kill), or
              // `error.code === 'ETIMEDOUT'` on some platforms. Detect
              // both so the caller's warning can name the actual cause
              // ("timed out") instead of mislabeling it as exit-code 1.
              const errno = error as NodeJS.ErrnoException & {
                killed?: boolean;
                signal?: string | null;
              };
              const isTimeout =
                errno.code === 'ETIMEDOUT' ||
                (errno.killed === true && errno.signal === 'SIGTERM');
              const code =
                typeof errno.code === 'number'
                  ? (errno.code as unknown as number)
                  : null;
              resolve({
                exitCode: code ?? 1,
                output: merged,
                timedOut: isTimeout,
              });
            } else {
              resolve({ exitCode: 0, output: merged, timedOut: false });
            }
          },
        );
        child.on('error', () => {});
      });

      if (exitCode !== 0) {
        if (timedOut) {
          debugLogger.warn(`git notes timed out after 5s: ${output}`);
          warning =
            'AI attribution note skipped: `git notes add` timed out ' +
            'after 5s' +
            (output ? ` (${output.trim().slice(0, 120)})` : '') +
            '. Co-authored-by trailer is unaffected.';
        } else {
          debugLogger.warn(`git notes exited with code ${exitCode}: ${output}`);
          warning =
            `AI attribution note skipped: \`git notes add\` exited ${exitCode}` +
            (output ? ` (${output.trim().slice(0, 120)})` : '') +
            '. Co-authored-by trailer is unaffected.';
        }
        // Note didn't land — leave per-file state intact so the user
        // can amend the commit (or manually run `git notes add`)
        // without losing attribution data they'd need to reproduce.
      } else {
        debugLogger.debug(
          `Attached AI attribution note: ${note.summary.aiPercent}% AI, ${note.summary.totalFilesTouched} file(s)`,
        );
        // Successful note write — partial-clear the just-committed
        // files so a later commit doesn't re-attribute them.
        shouldClear = committedAbsolutePaths;
      }
    } catch (err) {
      debugLogger.warn(
        `Failed to attach AI attribution note: ${getErrorMessage(err)}`,
      );
      warning =
        `AI attribution note skipped: ${getErrorMessage(err)}. ` +
        'Co-authored-by trailer is unaffected.';
    } finally {
      // Partial clear: only drop tracking for files that landed in
      // this commit AND the note write actually succeeded (or the
      // user disabled the toggle). `shouldClear` stays null when the
      // note was skipped (oversized payload, non-zero exit, exception)
      // so the user can amend & retry without their per-file
      // attribution being silently destroyed first. When `shouldClear`
      // is null, just snapshot the prompt counter — DON'T
      // wholesale-clear, since that would erase pending AI edits for
      // files the user never staged in this commit.
      if (shouldClear) {
        attributionService.clearAttributedFiles(shouldClear);
      } else {
        attributionService.noteCommitWithoutClearing();
      }
    }
    return warning;
  }

  /**
   * Get information about files in the just-landed commit by diffing
   * the captured `postHead` against its parent (`${postHead}~1`), or
   * for amend against `preHead` (the captured pre-amend SHA). All
   * probes/diffs are SHA-pinned so a post-commit hook moving HEAD
   * between this call and the eventual `git notes` write can't make
   * the note describe a different commit than it attaches to.
   *
   * Returns:
   * - A populated `StagedFileInfo` when analysis succeeded.
   * - An empty `StagedFileInfo` when the commit truly has no files
   *   (e.g. `--allow-empty`). The caller does a no-op partial clear so
   *   pending AI attributions stay tracked for the next real commit.
   * - `null` when analysis itself failed (shallow clone with no parent
   *   object, --amend with `preHead === null` or unresolvable `preHead`,
   *   partial diff failure, exception).
   *   The caller treats this as "could not determine the committed
   *   set" and falls back to `noteCommitWithoutClearing()` — snapshots
   *   the prompt counter but leaves per-file attribution intact, so
   *   pending AI edits for files NOT in the just-committed set don't
   *   get wiped along with the analysis failure. (The just-committed
   *   file's stale entry may re-attribute on a later commit; that's
   *   the smaller evil compared to wholesale loss.)
   */
  private async getCommittedFileInfo(
    cwd: string,
    isAmend: boolean,
    postHead: string,
    preHead: string | null,
  ): Promise<StagedFileInfo | null> {
    const empty: StagedFileInfo = {
      files: [],
      diffSizes: new Map(),
      deletedFiles: new Set(),
      renamedFiles: new Map(),
    };

    // Distinguish a successful git command with no output (e.g.
    // `--allow-empty` -> empty `--name-only` listing) from a failed
    // git command (silenced by ShellExecutionService) so the caller
    // can choose between the empty-commit sentinel and the analysis-
    // failure sentinel. Returning the same `''` for both used to
    // alias `--allow-empty` to a `--name-only` failure, which left
    // pending attributions tracked across the just-committed file
    // and re-attributed it on the next commit.
    const runGit = async (args: string): Promise<string | null> => {
      const handle = await ShellExecutionService.execute(
        `git ${args}`,
        cwd,
        () => {},
        AbortSignal.timeout(5000),
        false,
        {},
      );
      const r = await handle.result;
      return r.exitCode === 0 ? r.output : null;
    };

    try {
      // SHA-pin every probe and diff to the captured `postHead` (and
      // `preHead` for amend). Using symbolic `HEAD` here would re-open
      // the same TOCTOU class that the `git notes` write was already
      // pinned against: between this analysis phase and the note write,
      // a post-commit hook (husky/lefthook auto-amend, sign-off, signed
      // commits adjustment), a chained `git tag -m ...`, or a parallel
      // git process can advance HEAD — and then `HEAD~1..HEAD` /
      // `diff-tree HEAD` would describe whatever commit HEAD now
      // points at, while the note still attaches to the original
      // `postHead`. The result is a note on commit A whose contents
      // describe commit B. Pinning to `postHead` keeps the analysis
      // and the note consistent.
      //
      // The three calls are independent — fan out so we don't pay the
      // spawn latency serially. Same for the three diff calls below
      // once we know which form to use.
      // - `rev-parse --verify ${postHead}~1`: probe whether the parent
      //   OBJECT is locally available (fails in shallow clones where
      //   the parent was pruned).
      // - `log -1 --pretty=%P ${postHead}`: read the parent SHA from
      //   the commit metadata. Works regardless of shallow status
      //   because the parent SHA is recorded on the commit itself, not
      //   derived by walking. Empty output = postHead is a true root
      //   commit. Non-empty output = postHead has a parent (whether or
      //   not its object is locally available).
      // - `rev-parse --show-toplevel`: capture the repo root (HEAD-
      //   independent).
      //
      // `rev-list --count` looks tempting as a "is this a root
      // commit?" probe but it returns 1 in a depth-1 shallow clone
      // (only the local object is reachable), aliasing the shallow
      // and root cases. The parent-SHA approach disambiguates them
      // correctly.
      const [hasParentOutput, parentShaOutput, repoRootOutput] =
        await Promise.all([
          runGit(`rev-parse --verify ${postHead}~1`),
          runGit(`log -1 --pretty=%P ${postHead}`),
          runGit('rev-parse --show-toplevel'),
        ]);
      // `rev-parse --verify <sha>~1` is allowed to fail (shallow
      // clone, true root commit) — treat null and '' uniformly.
      const hasParent = hasParentOutput !== null && hasParentOutput.length > 0;
      // `log -1 --pretty=%P <sha>` MUST succeed; if git can't read
      // postHead's metadata we have no way to tell shallow apart from
      // a real root commit. Bail.
      if (parentShaOutput === null) {
        debugLogger.warn(
          'getCommittedFileInfo: log -1 --pretty=%P <postHead> failed; ' +
            'cannot distinguish shallow clone from true root commit.',
        );
        return null;
      }
      const isTrueRootCommit = parentShaOutput.trim().length === 0;
      // Shallow clone: postHead has a parent recorded but the object
      // isn't local. Bail rather than over-attribute via --root.
      if (!hasParent && !isTrueRootCommit) {
        debugLogger.warn(
          'getCommittedFileInfo: <postHead>~1 unreadable but commit is not ' +
            'the true root (shallow clone?); skipping attribution to avoid ' +
            'attributing the entire commit contents.',
        );
        return null;
      }
      // Capture the repo root so the attribution service can
      // reconcile paths from `git diff` (relative to the toplevel)
      // against absolute paths recorded by the edit/write tools.
      // Using the configured target directory as base would zero out
      // attribution for any file outside it. Tolerate failure (null
      // -> empty string -> caller falls back to targetDir).
      const repoRoot = (repoRootOutput ?? '').trim();

      // Choose the diff range:
      // - amend: `${preHead}..${postHead}` — the actual amend delta.
      //   `preHead` was captured BEFORE the user's command ran and so
      //   points at the original (pre-amend) commit. The amend rewrote
      //   that commit into postHead; diffing them captures only what
      //   changed in this amend, not the entire amended commit's
      //   contents (which `${postHead}~1..${postHead}` would falsely
      //   include — postHead's parent is the original's parent, so
      //   diffing against it spans both commits' worth of changes).
      // - has parent: `${postHead}~1..${postHead}` — pin both ends.
      //   We do NOT use `${preHead}..${postHead}` here: in chains like
      //   `git reset HEAD~3 && git commit`, preHead points well above
      //   postHead's parent and the diff would include the reset-away
      //   commits as deletions, dramatically over-attributing.
      // - root commit: `diff-tree --root <postHead>` against the empty
      //   tree.
      let diffArgs: { name: string; status: string; numstat: string };
      if (isAmend) {
        // For amend, the pre-amend SHA we need is `preHead`. It must
        // be non-null (caller's `attributableInCwd` gate already
        // captured it for any commit attempt); a missing preHead means
        // a brand-new repo where amend isn't meaningful anyway.
        if (preHead === null) {
          debugLogger.warn(
            'getCommittedFileInfo: --amend with no preHead; skipping ' +
              'attribution note (cannot determine amend delta).',
          );
          return null;
        }
        // Verify the pre-amend SHA still resolves. preHead is captured
        // synchronously before spawn, but a concurrent `git gc` /
        // `git prune` could in principle remove the object before we
        // try to diff against it.
        const preHeadProbe = await runGit(`rev-parse --verify ${preHead}`);
        if (preHeadProbe === null || preHeadProbe.length === 0) {
          debugLogger.warn(
            'getCommittedFileInfo: --amend preHead unresolvable; skipping ' +
              'attribution note (cannot determine amend delta).',
          );
          return null;
        }
        diffArgs = {
          name: `diff --find-renames --name-only ${preHead} ${postHead}`,
          status: `diff --find-renames --name-status ${preHead} ${postHead}`,
          numstat: `diff --find-renames --numstat ${preHead} ${postHead}`,
        };
      } else if (hasParent) {
        diffArgs = {
          name: `diff --find-renames --name-only ${postHead}~1 ${postHead}`,
          status: `diff --find-renames --name-status ${postHead}~1 ${postHead}`,
          numstat: `diff --find-renames --numstat ${postHead}~1 ${postHead}`,
        };
      } else {
        diffArgs = {
          name: `diff-tree --root --find-renames --no-commit-id -r --name-only ${postHead}`,
          status: `diff-tree --root --find-renames --no-commit-id -r --name-status ${postHead}`,
          numstat: `diff-tree --root --find-renames --no-commit-id -r --numstat ${postHead}`,
        };
      }
      const [nameOutput, statusOutput, numstatOutput] = await Promise.all([
        runGit(diffArgs.name),
        runGit(diffArgs.status),
        runGit(diffArgs.numstat),
      ]);

      // ANY of the three diffs failing (null) is an analysis failure,
      // NOT an empty commit. Without this check, a `--name-only` that
      // failed silently used to alias to `--allow-empty`, leaving the
      // just-committed file's tracked AI edit in the singleton and
      // re-attributing it to the next commit.
      if (
        nameOutput === null ||
        statusOutput === null ||
        numstatOutput === null
      ) {
        debugLogger.warn(
          'getCommittedFileInfo: one or more diff calls failed; ' +
            'cannot distinguish empty commit from analysis failure.',
        );
        return null;
      }

      const files = nameOutput
        .split('\n')
        .map((f) => f.trim())
        .filter(Boolean);
      if (files.length === 0) return empty;

      // Get deleted files
      const deletedFiles = new Set<string>();
      const renamedFiles = new Map<string, string>();
      for (const line of statusOutput.split('\n')) {
        if (line.startsWith('D\t')) {
          deletedFiles.add(line.slice(2).trim());
          continue;
        }
        const parts = line.split('\t');
        const status = parts[0] ?? '';
        if (status.startsWith('R') && parts.length >= 3) {
          renamedFiles.set(parts[1]!.trim(), parts[2]!.trim());
        }
      }

      // Get diff sizes from numstat output. Bail if `--numstat`
      // returned nothing while `--name-only` succeeded — that's the
      // partial-failure signal for `Promise.all`, and writing a note
      // anyway would force every file's diffSize to 0, then
      // generateNotePayload would clamp aiChars to 0 and emit a
      // structurally valid but factually wrong all-zero attribution.
      const diffSizes = parseNumstat(numstatOutput);
      if (diffSizes.size === 0) {
        debugLogger.warn(
          'getCommittedFileInfo: --numstat returned empty while ' +
            '--name-only listed files; skipping attribution note to ' +
            'avoid emitting all-zero AI percentages.',
        );
        return null;
      }

      return {
        files,
        diffSizes,
        deletedFiles,
        renamedFiles,
        repoRoot: repoRoot.length > 0 ? repoRoot : undefined,
      };
    } catch {
      return null;
    }
  }

  /**
   * Append a configured `Co-authored-by:` trailer to `git commit`
   * commands when the commit co-author feature is enabled. No-op for
   * commands that don't carry an inline `-m`/`-am` message (those open
   * an editor, which we don't try to rewrite).
   */
  private addCoAuthorToGitCommit(command: string): string {
    // Check if commit co-author feature is enabled
    const gitCoAuthorSettings = this.config.getGitCoAuthor();

    if (!gitCoAuthorSettings.commit) {
      return command;
    }

    // Same shell-type guard as addAttributionToPR — bash escaping is
    // wrong for cmd/PowerShell. Gating on the active shell rather than
    // the OS platform keeps Windows + Git Bash users (where
    // getShellConfiguration() reports shell:'bash') working.
    if (getShellConfiguration().shell !== 'bash') {
      return command;
    }

    // Shell-aware detection — a raw regex would falsely match quoted
    // text such as `echo "git commit"` and hand a corrupted command
    // (with the trailer mid-string) back to the executor. The stricter
    // `attributableInCwd` is what we want here: only inject the
    // trailer when we're confident the commit lands in our cwd.
    const segmentRange = findAttributableCommitSegment(command);
    if (!segmentRange) {
      return command;
    }

    // Handle different git commit patterns:
    // Match -m "message" or -m 'message', including combined flags like -am
    // Use separate patterns to avoid ReDoS (catastrophic backtracking).
    // The regex tolerates `-m"msg"` shorthand (no space) — bash accepts
    // both `-m foo` and `-mfoo`, and we shouldn't silently skip the
    // shorthand form.
    //
    // The regex is scoped to the actual `git commit` segment (not the
    // whole compound command) so a later `git tag -a v1 -m "..."` in
    // the same chain can't be mistaken for the commit message.
    //
    // Pattern breakdown:
    //   -[a-zA-Z]*m  matches -m, -am, -nm, etc. (combined short flags)
    //   \s*          matches optional whitespace after the flag
    //   [^"\\]       matches any char except double-quote and backslash
    //   \\.          matches escape sequences like \" or \\
    //   (?:...|...)* matches normal chars or escapes, repeated
    // Match both the short form (`-m`, `-am`, combined short flags)
    // and git's long alias `--message` (with optional `=` separator:
    // `--message="..."`). Inner alternation is non-capturing so the
    // existing `[full, prefix, body]` destructure still applies.
    const FLAG_PREFIX = `(?:-[a-zA-Z]*m|--message)\\s*=?\\s*`;
    const doubleQuotePattern = new RegExp(
      `(${FLAG_PREFIX})"((?:[^"\\\\]|\\\\.)*)"`,
      'g',
    );
    // Bash single quotes can't be escaped, so apostrophes inside a
    // single-quoted message use the close-escape-reopen form `'\''`
    // (e.g. `git commit -m 'don'\''t'`). The inner alternation matches
    // either a non-apostrophe character or that escape sequence as a
    // whole, so the trailer lands at the true end of the body — at the
    // FINAL closing `'` after the user's content — rather than after
    // the first interior apostrophe. Mirrors `bodySinglePattern` in
    // `addAttributionToPR`.
    const singleQuotePattern = new RegExp(
      `(${FLAG_PREFIX})'((?:[^']|'\\\\'')*)'`,
      'g',
    );
    // Trim a trailing shell comment from the segment so an inert
    // `git commit -m "real" # -m "fake"` doesn't have `lastMatchOf`
    // pick the comment's `-m "fake"` and splice the trailer into the
    // comment (where bash discards it), leaving the actual commit
    // unattributed.
    const fullSegment = command.slice(segmentRange.start, segmentRange.end);
    const commentStart = findUnquotedCommentStart(fullSegment);
    const segment =
      commentStart >= 0 ? fullSegment.slice(0, commentStart) : fullSegment;
    // Git concatenates multiple `-m` values with a blank line, so the
    // co-author trailer has to land in the *last* `-m` value to be
    // recognised by `git interpret-trailers`. matchAll → take the
    // last match (`lastMatchOf` is the shared helper).
    const doubleMatch = lastMatchOf(segment.matchAll(doubleQuotePattern));
    const singleMatch = lastMatchOf(segment.matchAll(singleQuotePattern));

    // Pick whichever match appears LAST in the segment, regardless of
    // quote style — but reject any candidate that's nested inside the
    // other's range. For `git commit -m "docs mention -m 'flag'"` the
    // single-quoted `-m 'flag'` lives INSIDE the double-quoted real
    // message; without the nesting check the later (inner) `-m` would
    // win and the trailer would be spliced into the body text.
    const picked = pickOuterLastMatch(doubleMatch, singleMatch);
    const match = picked.match;
    const quote = picked.isDouble ? '"' : "'";

    // Escape the configured name/email for the surrounding quote
    // style — has to follow the actually-selected match.
    const escape = picked.isDouble
      ? escapeForBashDoubleQuote
      : escapeForBashSingleQuote;
    const escapedName = escape(gitCoAuthorSettings.name ?? '');
    const escapedEmail = escape(gitCoAuthorSettings.email ?? '');
    const coAuthor = `\n\nCo-authored-by: ${escapedName} <${escapedEmail}>`;

    if (match) {
      const [fullMatch, prefix, existingMessage] = match;

      // Bail on `$(...)` command substitution inside the captured
      // body: our regex's `(?:[^"\\]|\\.)*` body group stops at the
      // first interior `"`, so a heredoc-style
      // `git commit -m "$(cat <<'HEREDOC' ... HEREDOC)"` (which the
      // tool description recommends for multi-line messages) would
      // be matched only up to the first inner `"`, then the trailer
      // would be spliced into the middle of the command
      // substitution and break the shell command. Recognising
      // `$(` is enough — if it's there we can't safely rewrite
      // without a real shell parser.
      //
      // We do NOT bail on a bare backtick: while `\`cmd "with" quotes\``
      // suffers the same regex-truncation bug, the common markdown-
      // style `\`func()\`` in a commit body has no inner `"` and works
      // fine. Bailing on any backtick would lose attribution for the
      // common case to defend against a near-zero-traffic pathological
      // case where the user typed raw backticks INSIDE a double-quoted
      // body and put inner double-quotes inside the backtick span.
      // bash itself would interpret that as command substitution
      // anyway — almost certainly a user error rather than a real
      // commit message — so the rewrite is at most one of several
      // things that go wrong.
      if (existingMessage.includes('$(')) {
        return command;
      }

      const newMessage = existingMessage + coAuthor;
      const replacement = prefix + quote + newMessage + quote;

      // Splice the modified segment back into the original command,
      // preserving everything outside the commit segment exactly as
      // the caller had it.
      const matchStart = (match.index ?? 0) + segmentRange.start;
      if (matchStart >= segmentRange.start) {
        return (
          command.slice(0, matchStart) +
          replacement +
          command.slice(matchStart + fullMatch.length)
        );
      }
    }

    // If no -m flag found, the command might open an editor
    // In this case, we can't easily modify it, so return as-is
    return command;
  }

  /**
   * Detect `gh pr create` commands and append AI attribution text to the
   * PR body. Format: "🤖 Generated with Qwen Code (N-shotted by Qwen-Coder)"
   * when at least one user prompt has been recorded since the last commit;
   * otherwise just "🤖 Generated with Qwen Code".
   *
   * Skipped on Windows: the appended text relies on bash quote-escape
   * conventions (`\$`, `'\''`) that cmd.exe and PowerShell don't honor,
   * so on those shells our injection could either break the user-approved
   * `gh pr create` command or be evaluated as command substitution.
   * Losing PR attribution on Windows is an acceptable trade for safety.
   */
  private addAttributionToPR(command: string): string {
    // Shell-aware detection — a raw regex would falsely match quoted
    // text such as `echo "gh pr create --body \"x\""` and rewrite a
    // command that wasn't actually creating a PR.
    const ghSegment = findGhPrCreateSegment(command);
    if (!ghSegment) {
      return command;
    }

    // Gate on shell type rather than OS platform: bash escaping is
    // invalid under cmd/PowerShell but works fine under Windows +
    // Git Bash, which `getShellConfiguration()` reports as `'bash'`.
    if (getShellConfiguration().shell !== 'bash') {
      return command;
    }

    const gitCoAuthorSettings = this.config.getGitCoAuthor();
    if (!gitCoAuthorSettings.pr) {
      return command;
    }

    const attributionService = CommitAttributionService.getInstance();
    const shots = attributionService.getPromptsSinceLastCommit();
    const generator = gitCoAuthorSettings.name ?? 'Qwen-Coder';

    const attribution =
      shots > 0
        ? `\n\n🤖 Generated with Qwen Code (${shots}-shotted by ${generator})`
        : `\n\n🤖 Generated with Qwen Code`;

    // Match both the long form `--body` and the short alias `-b`
    // (documented in `gh pr create --help`), with either space or
    // `=` separator: `--body "..."`, `--body="..."`, `-b "..."`,
    // `-b="..."`. Inner alternation is non-capturing so the existing
    // `[full, prefix, body]` destructure stays intact.
    //
    // Run the regex against just the gh segment, NOT the full
    // command. Otherwise a compound like
    // `curl -b "session=abc" && gh pr create --body "summary"` would
    // have the body regex match `curl`'s `-b` cookie flag and inject
    // attribution into the cookie value, corrupting the curl call.
    const BODY_FLAG = `(?:--body|-b)[\\s=]+`;
    const bodyDoublePattern = new RegExp(
      `(${BODY_FLAG})"((?:[^"\\\\]|\\\\.)*)"`,
      'g',
    );
    // Bash apostrophes inside a single-quoted body use the
    // close-escape-reopen form `'\''`. The inner alternation matches
    // either a non-apostrophe character or that escape sequence as a
    // whole, so the trailer lands at the true end of the body rather
    // than after only the first quoted segment.
    const bodySinglePattern = new RegExp(
      `(${BODY_FLAG})'((?:[^']|'\\\\'')*)'`,
      'g',
    );
    // Trim a trailing shell comment off the segment for the same
    // reason as addCoAuthorToGitCommit — `gh pr create --body "real"
    // # --body "fake"` would otherwise let `lastMatchOf` pick the
    // comment's `--body "fake"` and inject attribution into a `--body`
    // flag bash discards.
    const fullSegment = command.slice(ghSegment.start, ghSegment.end);
    const commentStart = findUnquotedCommentStart(fullSegment);
    const segment =
      commentStart >= 0 ? fullSegment.slice(0, commentStart) : fullSegment;
    // gh ignores all but the last `--body`/`-b` flag, so the trailer
    // has to land in the final occurrence to actually appear in the PR.
    // matchAll → take the last match for each quote style, then pick
    // whichever sits later in the segment (mirrors addCoAuthorToGitCommit;
    // shares the `lastMatchOf` helper).
    const bodyDoubleMatch = lastMatchOf(segment.matchAll(bodyDoublePattern));
    const bodySingleMatch = lastMatchOf(segment.matchAll(bodySinglePattern));
    // Pick whichever match appears LAST in the segment, regardless of
    // quote style — but reject any candidate that's nested inside the
    // other's range. For `gh pr create --body "docs mention -b 'flag'"`
    // the inner `-b 'flag'` is INSIDE the outer `--body "..."`; without
    // a nesting check the inner (later) `-b` would win and the trailer
    // would be spliced into the body text rather than appended after it.
    // Shared with addCoAuthorToGitCommit via `pickOuterLastMatch`.
    const pickedBody = pickOuterLastMatch(bodyDoubleMatch, bodySingleMatch);
    const bodyMatch = pickedBody.match;
    const bodyQuote = pickedBody.isDouble ? '"' : "'";

    if (bodyMatch) {
      const [fullMatch, prefix, existingBody] = bodyMatch;
      // Same `$(...)` bailout as addCoAuthorToGitCommit: a heredoc-
      // style body (`gh pr create --body "$(cat <<'EOF' ... EOF)"`)
      // contains nested `"` that our regex's `(?:[^"\\]|\\.)*` body
      // group can't span — the match would terminate at the first
      // interior quote and the splice would land mid-substitution,
      // corrupting the user-approved command.
      if (existingBody.includes('$(')) {
        return command;
      }
      // Escape the appended text for the surrounding quote style.
      // Without this, a configured generator name containing `"`, `$`, a
      // backtick, or `'` would either break the user-approved `gh pr
      // create` command or, worse, be interpreted as command substitution.
      const escapedAttribution = pickedBody.isDouble
        ? escapeForBashDoubleQuote(attribution)
        : escapeForBashSingleQuote(attribution);
      const newBody = existingBody + escapedAttribution;
      // Splice the modified segment back into the original command,
      // offsetting the in-segment match index by the segment start.
      const idx = (bodyMatch.index ?? 0) + ghSegment.start;
      if (idx >= ghSegment.start) {
        const replacement = prefix + bodyQuote + newBody + bodyQuote;
        return (
          command.slice(0, idx) +
          replacement +
          command.slice(idx + fullMatch.length)
        );
      }
    }

    // Reached here means: `gh pr create`/`gh pr new` was detected,
    // `gitCoAuthor.pr` is enabled, but the regex found no inline
    // `--body`/`-b` to splice the attribution into. Common causes
    // are `--body-file <path>`, `--fill` (uses commit messages as
    // body), or just bare `gh pr create` (opens an editor). The
    // command runs as the user typed it; we just don't add the
    // attribution line. Surface this as a debug warning so a user
    // wondering "why isn't my PR getting the trailer?" can see the
    // skip in `QWEN_DEBUG_LOG_FILE`. Inline-body rewriting is the
    // only safe automatic path — `--body-file` would require us to
    // mutate the user's file on disk; `--fill` and editor flows
    // have no body in argv at all.
    debugLogger.warn(
      'addAttributionToPR: gh pr create detected but no inline ' +
        '`--body`/`-b` argument found to append attribution to ' +
        '(--body-file / --fill / editor flows are unsupported); ' +
        'PR will be created without the AI attribution line. ' +
        'Pass `--body "..."` inline to enable automatic attribution.',
    );
    return command;
  }
}

function getShellToolDescription(): string {
  const isWindows = os.platform() === 'win32';
  const executionWrapper = isWindows
    ? 'cmd.exe /c <command>'
    : 'bash -c <command>';
  const processGroupNote = isWindows
    ? ''
    : '\n  - Command is executed as a subprocess that leads its own process group. Command process group can be terminated as `kill -- -PGID` or signaled as `kill -s SIGNAL -- -PGID`.';

  return `Executes a given shell command (as \`${executionWrapper}\`) in a persistent shell session with optional timeout, ensuring proper handling and security measures.

IMPORTANT: This tool is for terminal operations like git, npm, docker, etc. DO NOT use it for file operations (reading, writing, editing, searching, finding files) - use the specialized tools for this instead.

**Usage notes**:
- The command argument is required.
- You can specify an optional timeout in milliseconds (up to 600000ms / 10 minutes). If not specified, commands will timeout after 120000ms (2 minutes).
- It is very helpful if you write a clear, concise description of what this command does in 5-10 words.

- Avoid using run_shell_command with the \`find\`, \`grep\`, \`cat\`, \`head\`, \`tail\`, \`sed\`, \`awk\`, or \`echo\` commands, unless explicitly instructed or when these commands are truly necessary for the task. Instead, always prefer using the dedicated tools for these commands:
  - File search: Use ${ToolNames.GLOB} (NOT find or ls)
  - Content search: Use ${ToolNames.GREP} (NOT grep or rg)
  - Read files: Use ${ToolNames.READ_FILE} (NOT cat/head/tail)
  - Edit files: Use ${ToolNames.EDIT} (NOT sed/awk)
  - Write files: Use ${ToolNames.WRITE_FILE} (NOT echo >/cat <<EOF)
  - Communication: Output text directly (NOT echo/printf)
- **Shell argument quoting and special characters**: When passing arguments that contain special characters (parentheses \`()\`, backticks \`\`\`\`, dollar signs \`$\`, backslashes \`\\\`, semicolons \`;\`, pipes \`|\`, angle brackets \`<>\`, ampersands \`&\`, exclamation marks \`!\`, etc.), you MUST ensure they are properly quoted to prevent the shell from misinterpreting them as shell syntax:
  - **Single quotes** \`'...'\` pass everything literally, but cannot contain a literal single quote.
  - **ANSI-C quoting** \`$'...'\` supports escape sequences (e.g. \`\\n\` for newline, \`\\'\` for single quote) and is the safest approach for multi-line strings or strings with single quotes.
  - **Heredoc** is the most robust approach for large, multi-line text with mixed quotes:
    \`\`\`bash
    gh pr create --title "My Title" --body "$(cat <<'HEREDOC'
    Multi-line body with (parentheses), \`backticks\`, and 'single-quotes'.
    HEREDOC
    )"
    \`\`\`
  - NEVER use unescaped single quotes inside single-quoted strings (e.g. \`'it\\'s'\` is wrong; use \`$'it\\'s'\` or \`"it's"\` instead).
  - If unsure, prefer double-quoting arguments and escape inner double-quotes as \`\\"\`.
- When issuing multiple commands:
  - If the commands are independent and can run in parallel, make multiple run_shell_command tool calls in a single message. For example, if you need to run "git status" and "git diff", send a single message with two run_shell_command tool calls in parallel.
  - If the commands depend on each other and must run sequentially, use a single run_shell_command call with '&&' to chain them together (e.g., \`git add . && git commit -m "message" && git push\`). For instance, if one operation must complete before another starts (like mkdir before cp, Write before run_shell_command for git operations, or git add before git commit), run these operations sequentially instead.
  - Use ';' only when you need to run commands sequentially but don't care if earlier commands fail
  - DO NOT use newlines to separate commands (newlines are ok in quoted strings)
- Try to maintain your current working directory throughout the session by using absolute paths and avoiding usage of \`cd\`. You may use \`cd\` if the User explicitly requests it.
  <good-example>
  pytest /foo/bar/tests
  </good-example>
  <bad-example>
  cd /foo/bar && pytest tests
  </bad-example>

**Background vs Foreground Execution:**
- You should decide whether commands should run in background or foreground based on their nature:
- Use background execution (is_background: true) for:
  - Long-running development servers: \`npm run start\`, \`npm run dev\`, \`yarn dev\`, \`bun run start\`
  - Build watchers: \`npm run watch\`, \`webpack --watch\`
  - Database servers: \`mongod\`, \`mysql\`, \`redis-server\`
  - Web servers: \`python -m http.server\`, \`php -S localhost:8000\`
  - Any command expected to run indefinitely until manually stopped
${processGroupNote}
- Use foreground execution (is_background: false) for:
  - One-time commands: \`ls\`, \`cat\`, \`grep\`
  - Build commands: \`npm run build\`, \`make\`
  - Installation commands: \`npm install\`, \`pip install\`
  - Git operations: \`git commit\`, \`git push\`
  - Test runs: \`npm test\`, \`pytest\`
`;
}

function getCommandDescription(): string {
  if (os.platform() === 'win32') {
    return 'Exact command to execute as `cmd.exe /c <command>`';
  } else {
    return 'Exact bash command to execute as `bash -c <command>`';
  }
}

export class ShellTool extends BaseDeclarativeTool<
  ShellToolParams,
  ToolResult
> {
  static Name: string = ToolNames.SHELL;

  constructor(private readonly config: Config) {
    super(
      ShellTool.Name,
      ToolDisplayNames.SHELL,
      getShellToolDescription(),
      Kind.Execute,
      {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            description: getCommandDescription(),
          },
          is_background: {
            type: 'boolean',
            description:
              'Optional: Whether to run the command in background. If not specified, defaults to false (foreground execution). Explicitly set to true for long-running processes like development servers, watchers, or daemons that should continue running without blocking further commands.',
          },
          timeout: {
            type: 'number',
            description: 'Optional timeout in milliseconds (max 600000)',
          },
          description: {
            type: 'string',
            description:
              'Brief description of the command for the user. Be specific and concise. Ideally a single sentence. Can be up to 3 sentences for clarity. No line breaks.',
          },
          directory: {
            type: 'string',
            description:
              '(OPTIONAL) The absolute path of the directory to run the command in. If not provided, the project root directory is used. Must be a directory within the workspace and must already exist.',
          },
        },
        required: ['command'],
      },
      false, // output is not markdown
      true, // output can be updated
    );
  }

  protected override validateToolParamValues(
    params: ShellToolParams,
  ): string | null {
    // NOTE: Permission checks (read-only detection, PM rules) are handled at
    // L3 (getDefaultPermission) and L4 (PM override) in coreToolScheduler.
    // This method only performs pure parameter validation.
    if (!params.command.trim()) {
      return 'Command cannot be empty.';
    }
    const strippedCommand = stripShellWrapper(params.command);
    if (
      params.is_background &&
      hasTopLevelTrailingBackgroundOperator(strippedCommand)
    ) {
      return 'Background shell commands must not end with a bare "&". Remove the trailing "&" and rely on is_background: true instead.';
    }
    if (getCommandRoots(params.command).length === 0) {
      return 'Could not identify command root to obtain permission from user.';
    }
    if (params.timeout !== undefined) {
      if (
        typeof params.timeout !== 'number' ||
        !Number.isInteger(params.timeout)
      ) {
        return 'Timeout must be an integer number of milliseconds.';
      }
      if (params.timeout <= 0) {
        return 'Timeout must be a positive number.';
      }
      if (params.timeout > 600000) {
        return 'Timeout cannot exceed 600000ms (10 minutes).';
      }
    }
    if (params.directory) {
      if (!path.isAbsolute(params.directory)) {
        return 'Directory must be an absolute path.';
      }

      const userSkillsDirs = this.config.storage.getUserSkillsDirs();
      const resolvedDirectoryPath = path.resolve(params.directory);
      const isWithinUserSkills = isSubpaths(
        userSkillsDirs,
        resolvedDirectoryPath,
      );
      if (isWithinUserSkills) {
        return `Explicitly running shell commands from within the user skills directory is not allowed. Please use absolute paths for command parameter instead.`;
      }

      const workspaceDirs = this.config.getWorkspaceContext().getDirectories();
      const isWithinWorkspace = workspaceDirs.some((wsDir) =>
        params.directory!.startsWith(wsDir),
      );

      if (!isWithinWorkspace) {
        return `Directory '${params.directory}' is not within any of the registered workspace directories.`;
      }
    }
    // Sleep interception: block sleep >= 2s in foreground, suggest Monitor.
    // Strip shell wrappers first so `bash -c 'sleep 5'` / `sh -c '...'` etc.
    // cannot route around the check by hiding the foreground sleep inside a
    // `-c` script. This matches every other sensitive check in this file
    // (directory, read-only, command-root extraction, etc.).
    if (!params.is_background) {
      const sleepPattern = detectBlockedSleepPattern(
        stripShellWrapper(params.command),
      );
      if (sleepPattern !== null) {
        return (
          `Blocked: ${sleepPattern}. ` +
          'Run blocking commands in the background with is_background: true. ' +
          'For streaming events (watching logs, polling APIs), use the Monitor tool. ' +
          'If you genuinely need a delay (rate limiting, deliberate pacing), keep it under 2 seconds.'
        );
      }
    }
    return null;
  }

  protected createInvocation(
    params: ShellToolParams,
  ): ToolInvocation<ShellToolParams, ToolResult> {
    return new ShellToolInvocation(this.config, params);
  }
}
