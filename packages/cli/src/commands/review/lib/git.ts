/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Thin wrapper around `git` for the `qwen review` subcommands. Same
// `execFileSync` pattern as `lib/gh.ts` so quoting / escaping is consistent
// across platforms.

import { execFileSync } from 'node:child_process';

/** Deadline for a single `git` invocation. Generous; a hang must still end. */
const GIT_TIMEOUT_MS = 120_000;

/**
 * Options every wrapper shares.
 *
 * `git fetch` is a network operation, and on a headless machine a missing
 * credential turns into a terminal prompt that never gets an answer. Without a
 * deadline and `GIT_TERMINAL_PROMPT=0` the process waits forever with no output
 * — indistinguishable from a deadlock.
 */
const GIT_OPTS = {
  timeout: GIT_TIMEOUT_MS,
  env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
} as const;

/** Run `git` with args. Returns stdout, trimmed and CRLF-normalised. */
export function git(...args: string[]): string {
  return execFileSync('git', args, { ...GIT_OPTS, encoding: 'utf8' })
    .replace(/\r\n/g, '\n')
    .trim();
}

/**
 * Run `git`, return null on non-zero exit (e.g. ref / file does not exist).
 *
 * Unlike `git`, this swallows the child's stderr too — callers use it to
 * probe for things that may be absent (a tag, a file in `git show`,
 * a branch name) and don't want git's "fatal: ..." chatter on the user's
 * terminal.
 */
export function gitOpt(...args: string[]): string | null {
  try {
    return execFileSync('git', args, {
      ...GIT_OPTS,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
      .replace(/\r\n/g, '\n')
      .trim();
  } catch {
    return null;
  }
}

/** True iff a ref (branch / tag / commit) exists locally. */
export function refExists(ref: string): boolean {
  return gitOpt('rev-parse', '--verify', '--quiet', ref) !== null;
}

/**
 * Run `git` and return stdout as raw bytes.
 *
 * `git` above is wrong for diffs on two counts: it CRLF-normalises (which
 * rewrites the content of every hunk touching a CRLF file) and it `.trim()`s
 * (which eats the trailing newline a patch needs). It also inherits
 * `execFileSync`'s 1 MB `maxBuffer` default, so any diff past ~1 MB dies with
 * ENOBUFS rather than returning a short read. Diff capture uses this instead.
 */
export function gitRaw(...args: string[]): Buffer {
  return execFileSync('git', args, {
    ...GIT_OPTS,
    maxBuffer: 512 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}
