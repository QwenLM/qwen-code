/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { readCronTasks } from '@qwen-code/qwen-code-core/services/cronTasksFile.js';
import {
  fetchRemoteWebUrl,
  repoKeyFromWebUrl,
} from '@qwen-code/qwen-code-core/utils/github-prs.js';
import { listAutofixPrWatches } from './autofix-pr-watches.js';

/**
 * Active PR watches of one workspace, keyed sessionId → set of
 * `host/owner/repo#number` keys. Derived at scan time from the artifacts the
 * watch flows already write — no persisted watch state of its own:
 *
 * - `/autofix-pr` watches: the state files `listAutofixPrWatches` reads
 *   (owning session, not stopped or ended). Covers in-place watches and
 *   takeovers, whose state file is the authority.
 * - `/verify-pr <n> --watch`: the durable recurring scheduled task bound to
 *   the session, whose gate runs `verify-pr-watch-gate.mjs <n> --repo
 *   <owner>/<repo>`. The gate claim file records no session id, so the task
 *   is the only session-attributed artifact.
 *
 * Fail-open: when a source cannot be read the answer is `undefined`
 * (unknown), never a partial map — the caller leaves `watching` absent so
 * the channel keeps delivering as it did before the gate existed. That
 * includes the listing's NON-throwing failure shapes: `available: false`
 * (the clone's worktrees could not be enumerated) and a non-empty
 * `unreadable` (individual state files failed to read), any gate whose
 * shell words cannot be determined (see `parseVerifyPrWatchGate`), and a
 * workspace remote that cannot be resolved when a verify-pr watch needs
 * keying (the gate takes no host; the remote supplies it).
 */
export type ActivePrWatches = Map<string, Set<string>>;

/**
 * The watch-set key of a PR: `repoKeyFromWebUrl(url)#number`. The bindings
 * route derives its lookup key with the SAME function on the binding URL,
 * so host spellings (port, leading www, case) normalize identically on both
 * sides — a watch key built by hand from a raw host would never match a
 * binding URL on a non-default-port enterprise host.
 */
export function prWatchKey(url: string, pr: number): string | undefined {
  const repoKey = repoKeyFromWebUrl(url);
  return repoKey === undefined ? undefined : `${repoKey}#${pr}`;
}

/**
 * Split a simple shell command into the words the shell would pass as
 * argv, splitting only on the shell's default IFS (space and tab; newline
 * is an operator), honoring single quotes (literal), double quotes
 * (backslash escapes only `$`, backtick, `"`, `\`, and newline), backslash
 * escapes and backslash-newline continuations outside quotes (both
 * characters vanish without starting a word), and a word-start `#` comment,
 * which ends the command. Returns undefined when the argv CANNOT be
 * determined:
 * unterminated quotes, variable/command expansion (`$`, backticks),
 * glob/brace expansion characters (`*?[]{}`), or shell
 * operators/redirections/newlines outside quotes — a whitespace split
 * would silently disagree with the real argv there (e.g.
 * `--state-root '/tmp/pr 16772' 42` is ONE argument followed by the PR
 * number, not a PR named 16772).
 */
export function shellWords(input: string): string[] | undefined {
  const words: string[] = [];
  let current = '';
  let started = false;
  let i = 0;
  const push = (): void => {
    if (started) words.push(current);
    current = '';
    started = false;
  };
  while (i < input.length) {
    const ch = input[i]!;
    if (ch === "'") {
      started = true;
      i += 1;
      while (i < input.length && input[i] !== "'") {
        current += input[i];
        i += 1;
      }
      if (i >= input.length) return undefined; // unterminated single quote
      i += 1;
      continue;
    }
    if (ch === '"') {
      started = true;
      i += 1;
      while (i < input.length && input[i] !== '"') {
        const c = input[i]!;
        if (c === '\\') {
          const next = input[i + 1];
          if (next === undefined) return undefined;
          if (next === '\n') {
            i += 2; // line continuation inside double quotes
            continue;
          }
          if ('$`"\\'.includes(next)) {
            current += next;
            i += 2;
            continue;
          }
          current += c; // backslash is literal before other characters
          i += 1;
          continue;
        }
        if (c === '$' || c === '`') return undefined; // expansion
        current += c;
        i += 1;
      }
      if (i >= input.length) return undefined; // unterminated double quote
      i += 1;
      continue;
    }
    if (ch === '\\') {
      const next = input[i + 1];
      if (next === undefined) return undefined; // trailing backslash
      if (next === '\n') {
        // Line continuation: both characters vanish and the word state is
        // unchanged — starting a word here would push an empty argv element
        // when the continued line begins with indentation.
        i += 2;
        continue;
      }
      started = true;
      current += next;
      i += 2;
      continue;
    }
    if (ch === '$' || ch === '`') return undefined; // expansion
    if ('*?[]{}'.includes(ch)) return undefined; // glob/brace expansion
    if (';|&><()'.includes(ch) || ch === '\n') return undefined; // operator
    if (ch === '#' && !started) return words; // comment: the rest is not argv
    // The shell's default IFS is space, tab, newline (newline is an operator
    // above). Other Unicode whitespace (NBSP, CR, BOM, …) is a literal word
    // character, not a separator — splitting on it would invent argv the
    // real gate never sees.
    if (ch === ' ' || ch === '\t') {
      push();
      i += 1;
      continue;
    }
    started = true;
    current += ch;
    i += 1;
  }
  push();
  return words;
}

/**
 * What a scheduled task's gate says about a standing verify-pr watch:
 * - `watch`: the gate runs the probe for this (repo, PR);
 * - `none`: confirmed NOT a standing watch (the executed command is not the
 *   probe script — including a gate that only names it in a comment — a
 *   one-shot `--check`/`--claim`/`--release` invocation, or arguments the
 *   script itself would reject — such a gate never fires);
 * - `unknown`: the gate names the probe script but its shell words cannot
 *   be determined, or the name sits in a word whose execution we cannot
 *   model. The collector must fail open on `unknown` — turning it into
 *   `none` would stamp `watching: false` on a PR that may be watched.
 */
export type VerifyPrWatchGateParse =
  | { kind: 'watch'; repo: string; pr: number }
  | { kind: 'none' }
  | { kind: 'unknown' };

/**
 * Parse a `/verify-pr --watch` gate with the shell's own word semantics
 * (`shellWords`), then mirror the gate script's `parseArgs`
 * (scripts/verify-pr-watch-gate.mjs): `--repo`/`--cli`/`--state-root`
 * consume the following word, the first non-flag positional is the PR
 * number, and `--check`/`--claim`/`--release` are one-shot probe
 * invocations (setup/teardown), never a standing watch.
 */
export function parseVerifyPrWatchGate(
  gate: string | undefined,
): VerifyPrWatchGateParse {
  const SCRIPT = 'verify-pr-watch-gate.mjs';
  if (!gate) return { kind: 'none' };
  // Parse FIRST: the probe name can be assembled by a continuation or sit
  // across a quote boundary, so a raw-text substring check would misread a
  // live watch as a confirmed none. The raw text is only the fallback for an
  // argv we cannot determine at all.
  const tokens = shellWords(gate);
  if (tokens === undefined) {
    return gate.includes(SCRIPT) ? { kind: 'unknown' } : { kind: 'none' };
  }
  // The EXECUTED script word: the command itself, or the word right after
  // the node interpreter, skipping leading environment assignments. A name
  // embedded in another word (a lookalike script, another command's quoted
  // argument) is not the executed command and must not read as a watch.
  const isScriptWord = (token: string): boolean =>
    token === SCRIPT || token.endsWith(`/${SCRIPT}`);
  let commandIndex = 0;
  while (
    commandIndex < tokens.length &&
    /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[commandIndex]!)
  ) {
    commandIndex += 1;
  }
  const command = tokens[commandIndex];
  let scriptIndex = -1;
  if (command !== undefined && isScriptWord(command)) {
    scriptIndex = commandIndex;
  } else if (
    command !== undefined &&
    (command === 'node' ||
      command === 'node.exe' ||
      command.endsWith('/node')) &&
    tokens[commandIndex + 1] !== undefined &&
    isScriptWord(tokens[commandIndex + 1]!)
  ) {
    scriptIndex = commandIndex + 1;
  }
  if (scriptIndex === -1) {
    // The shell's argv never executes the probe. When no word even CONTAINS
    // the name, the gate cannot fire it — a comment-only gate runs nothing,
    // which is a confirmed none, not an undeterminable argv. A word that
    // merely contains the name (a lookalike script, a quoted `bash -c`
    // payload) could still execute it through a wrapper we do not model:
    // undeterminable, fail open.
    return tokens.some((token) => token.includes(SCRIPT))
      ? { kind: 'unknown' }
      : { kind: 'none' };
  }
  let pr: number | undefined;
  let repo: string | undefined;
  for (let i = scriptIndex + 1; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token === '--check' || token === '--claim' || token === '--release') {
      return { kind: 'none' };
    }
    if (token === '--repo' || token === '--cli' || token === '--state-root') {
      const value = tokens[++i];
      if (token === '--repo') repo = value;
      continue;
    }
    if (!token.startsWith('-') && pr === undefined) {
      // The script takes the FIRST non-flag positional unconditionally and
      // throws unless it is a positive integer — a gate it cannot run is no
      // watch, so a non-numeric first positional must not fall through to a
      // later number.
      const value = Number(token);
      if (!Number.isInteger(value) || value <= 0) return { kind: 'none' };
      pr = value;
    }
  }
  if (pr === undefined) return { kind: 'none' };
  if (!repo || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
    return { kind: 'none' };
  }
  // The gate script takes no --host; the collector keys the watch with the
  // workspace remote's host (see collectActivePrWatches).
  return { kind: 'watch', repo, pr };
}

export async function collectActivePrWatches(
  workspaceCwd: string,
): Promise<ActivePrWatches | undefined> {
  const watches: ActivePrWatches = new Map();
  const add = (sessionId: string, key: string): void => {
    let set = watches.get(sessionId);
    if (!set) {
      set = new Set();
      watches.set(sessionId, set);
    }
    set.add(key);
  };
  try {
    const listing = await listAutofixPrWatches(workspaceCwd);
    if (
      !listing.available ||
      (listing.unreadable !== undefined && listing.unreadable.length > 0)
    ) {
      return undefined;
    }
    for (const watch of listing.watches) {
      if (watch.session && watch.stopped === null && watch.ended === null) {
        const key = prWatchKey(watch.url, watch.pr);
        if (key !== undefined) add(watch.session, key);
      }
    }
  } catch {
    return undefined;
  }
  try {
    const tasks = await readCronTasks(workspaceCwd);
    // The gate script takes no --host: its probe resolves the host from
    // GH_HOST, the PR's recorded gate cursor, else github.com. The workspace
    // remote is the best available signal for that host — a hardcoded
    // github.com key would never match a GitHub Enterprise binding and would
    // stamp watching:false on a live watch (a delivery ban, the inverse of
    // fail-open). Resolve it lazily, once, and only when a verify-pr watch
    // actually needs keying; an unresolvable remote fails the workspace open.
    let remoteHost: string | undefined;
    let remoteResolved = false;
    for (const task of tasks) {
      if (task.enabled === false || !task.recurring || !task.sessionId) {
        continue;
      }
      const parsed = parseVerifyPrWatchGate(task.gate);
      if (parsed.kind === 'unknown') return undefined;
      if (parsed.kind === 'watch') {
        if (!remoteResolved) {
          const remoteUrl = await fetchRemoteWebUrl(workspaceCwd);
          remoteHost =
            remoteUrl === undefined
              ? undefined
              : repoKeyFromWebUrl(remoteUrl)?.split('/')[0];
          remoteResolved = true;
        }
        if (remoteHost === undefined) return undefined;
        const key = prWatchKey(
          `https://${remoteHost}/${parsed.repo}/pull/${parsed.pr}`,
          parsed.pr,
        );
        if (key !== undefined) add(task.sessionId, key);
      }
    }
  } catch {
    return undefined;
  }
  return watches;
}
