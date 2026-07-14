/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Thin wrapper around `git` for the `qwen review` subcommands. Same
// `execFileSync` pattern as `lib/gh.ts` so quoting / escaping is consistent
// across platforms.

import { execFileSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';

/** Deadline for a single `git` invocation. Generous; a hang must still end. */
const GIT_TIMEOUT_MS = 120_000;

/**
 * Options every wrapper shares, **read fresh on every call**.
 *
 * `git fetch` is a network operation, and on a headless machine a missing
 * credential turns into a terminal prompt that never gets an answer. Without a
 * deadline and `GIT_TERMINAL_PROMPT=0` the process waits forever with no output
 * — indistinguishable from a deadlock.
 *
 * A module-level constant would snapshot `process.env` at **import** time, and
 * an importer cannot set an environment variable before that: the import is
 * hoisted above every statement in the file. That made the integration fixtures'
 * `GIT_CONFIG_GLOBAL` / `GIT_CONFIG_NOSYSTEM` isolation a no-op — the suite that
 * exists to prove a hostile developer config cannot reach the capture was
 * running with the developer's config the whole time, and the "fix" for it was
 * a comment. Read the environment when git is actually run.
 */
function gitOpts() {
  return {
    timeout: GIT_TIMEOUT_MS,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  };
}

/** Run `git` with args. Returns stdout, trimmed and CRLF-normalised. */
export function git(...args: string[]): string {
  return execFileSync('git', args, { ...gitOpts(), encoding: 'utf8' })
    .replace(/\r\n/g, '\n')
    .trim();
}

/**
 * Run `git` with `input` on its stdin. Returns stdout, trimmed.
 *
 * Exists so a command can be fed an empty stdin without naming a null device:
 * `/dev/null` and `NUL` are special-cased only on git's *diff* code path, so
 * every other subcommand would try to open the name as an ordinary file.
 */
export function gitWithInput(input: Buffer, args: string[]): string {
  return execFileSync('git', args, { ...gitOpts(), encoding: 'utf8', input })
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
      ...gitOpts(),
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
 * Free a review worktree's path **and** its branch. Returns whether anything
 * was there at the path to remove — a registered worktree OR an untracked
 * leftover directory (see the `rmSync` below); either way a `true` return means
 * the path is now gone.
 *
 * `git worktree remove` needs the directory. A user reclaiming disk with
 * `rm -rf .qwen/tmp` leaves the worktree *registered but missing*, and from then
 * on git refuses both of the things the next review needs:
 *
 *     $ git worktree add .qwen/tmp/review-pr-6457 qwen-review/pr-6457
 *     fatal: '...' is a missing but already registered worktree;
 *     use 'add -f' to override, or 'prune' or 'remove' to clear
 *
 * and `git branch -D qwen-review/pr-6457`, because the branch is still checked
 * out in that phantom. So `/review <same PR>` never runs again until someone
 * prunes by hand. `git worktree prune` is the only thing that clears the
 * registration and a no-op when nothing is stale — run it unconditionally, and
 * **before** the branch delete that depends on it.
 */
export function releaseWorktree(worktreePath: string): boolean {
  const existed = existsSync(worktreePath);
  if (existed) {
    gitOpt('worktree', 'remove', worktreePath, '--force');
    // `worktree remove` only clears a tree git still tracks. A directory left at
    // the path after metadata loss or a partial cleanup is reported "not a
    // working tree" and left in place — and a non-empty one then blocks the next
    // `worktree add` with `already exists`. So remove whatever remains. `rmSync`
    // unlinks a symlink rather than following it, so a tampered leftover cannot
    // redirect the delete.
    //
    // Swallowed on purpose, like every other failure here: `force` suppresses
    // ENOENT but not EPERM or EBUSY, and this function runs on the cleanup path,
    // where throwing would mask the error that got us there. The caller learns
    // the outcome from the return value, not from an exception.
    try {
      rmSync(worktreePath, { recursive: true, force: true });
    } catch {
      // Fall through — the existence check below is the real signal.
    }
  }
  gitOpt('worktree', 'prune');
  // `true` means the path is GONE, not merely unregistered — so a caller can
  // report "Removed …" without lying. A leftover we could not delete returns
  // false even though something was there, which is the honest answer to
  // "is this path free now?".
  return existed && !existsSync(worktreePath);
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
    ...gitOpts(),
    maxBuffer: 512 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/**
 * Like `gitRaw`, but treats "the inputs differ" — exit 1 **with output** — as
 * success and returns the diff the child produced anyway.
 *
 * `git diff --no-index` is the only way to diff a file git does not track
 * without first writing to the index, and it reports "the two inputs differ" by
 * **exiting 1**. Against the null device that is the only outcome a real file
 * has, so plain `gitRaw` would throw on every single capture and the whole point
 * (seeing brand-new files) would be lost.
 *
 * The `length > 0` half is not belt-and-braces; it is the difference between a
 * diff and a lie. `git diff --no-index -- <null> <dir>` — which is what an
 * embedded git repo or a symlink to a directory looks like coming out of
 * `ls-files --others` — also exits 1, with **empty stdout** and an error on
 * stderr. An empty `Buffer` is a truthy object, so a bare `&& e.stdout` accepted
 * that as a successful diff of nothing, and the caller went on to report the
 * path as reviewed. Exit 1 with no output is a failure, not an empty diff; a
 * genuinely differing pair always produces output. Exit codes above 1 were
 * always, and remain, real errors.
 */
export function gitRawTolerateDiff(...args: string[]): Buffer {
  try {
    return gitRaw(...args);
  } catch (err) {
    const e = err as { status?: number; stdout?: Buffer };
    if (e.status === 1 && e.stdout && e.stdout.length > 0) return e.stdout;
    throw err;
  }
}
