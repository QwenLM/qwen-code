/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Thin wrapper around `git` for the `qwen review` subcommands. Same
// `execFileSync` pattern as `lib/gh.ts` so quoting / escaping is consistent
// across platforms.

import { execFileSync } from 'node:child_process';
import {
  mountRootFor,
  redirectedAncestor,
  sanitizedGitEnv,
  untrustedRepositoryFrom,
} from './worktree.js';
import { existsSync, lstatSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/** Deadline for a single `git` invocation. Generous; a hang must still end. */
export const GIT_TIMEOUT_MS = 120_000;

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
    // `sanitizedGitEnv`, not `process.env`: an exported `GIT_DIR` redirects
    // discovery for every command here at once — `releaseWorktree`'s
    // `worktree remove --force` included, which is a delete — and the
    // `GIT_CONFIG_*` family injects config the same way. The disposable-tree
    // commands were given this treatment first; these run against the user's
    // own repository, so they need it more, not less.
    env: { ...sanitizedGitEnv(), GIT_TERMINAL_PROMPT: '0' },
  };
}

/**
 * The launch directory, judged once per directory this process runs git from.
 *
 * Every wrapper below runs git with NO `cwd`, so each one discovers its
 * repository from `process.cwd()` — and in the nested geometry `mountRootFor`
 * documents, that directory is a review worktree inside the OUTER review's
 * read-write mount, where the reviewed code can rewrite the `.git` pointer git
 * follows. What the individual commands then do through it is not a short list:
 * `fetch` loads the plant's transport config, `diff` refreshes the index and
 * honours `diff.<driver>.command`, `show <base>:<path>` hands back the plant's
 * content as this review's own rules, `remote get-url` names where a submission
 * goes. Gating those command by command is how this class kept re-opening, so
 * the question is asked HERE, at the four functions every one of them goes
 * through.
 *
 * A `-C <tree>` argument does not change the answer's relevance: that scopes
 * the command to another tree, and THAT tree's pointer is the subject of
 * `untrustedGitfile`, which its callers ask separately. This one is only ever
 * about where the process stands.
 *
 * Only the NEGATIVE is memoized, and only where repeating it costs nothing:
 * outside a review temp dir `untrustedRepositoryFrom` returns on its first line
 * — a string scan, no spawn — so caching that keeps `gitProbe`, called per
 * thread by `comment-status`, off a per-call syscall and an ordinary checkout
 * never pays for this gate at all.
 *
 * Inside a review temp dir the question is RE-ASKED on every call. That is not
 * the TOCTOU residual this design documents and does not close, which is about a
 * pointer rewritten between a check and its own use: here the OUTER review's
 * containerized build/test phase holds the directory read-write for the length
 * of a whole command, so it rewrites the pointer BETWEEN calls, and a verdict
 * memoized for the process served the first clean answer to every later wrapper
 * — `status` refreshing the plant's index and running its clean filter, `show
 * <base>:<path>` handing the plant's content back as this review's own rules.
 * `fetch-pr` asks twice for the same reason; this asks every time, and the
 * spawn it costs exists only in the one geometry where the gate speaks.
 */
let trustedLaunchDir: string | null = null;

/** Why this process must not run git from where it stands, or null. */
function launchDirRefusal(): string | null {
  const cwd = process.cwd();
  if (trustedLaunchDir === cwd) return null;
  const refusal = untrustedRepositoryFrom(cwd);
  if (refusal === null) {
    if (mountRootFor(cwd) === null) trustedLaunchDir = cwd;
    return null;
  }
  return refusal;
}

function assertTrustedLaunchDir(): void {
  const refusal = launchDirRefusal();
  if (refusal !== null) {
    throw new Error(
      `refusing to run git from this directory: ${refusal}. ` +
        `The command would resolve through that pointer and act on whatever ` +
        `repository it names. Run the review from a checkout outside the ` +
        `review temp dir.`,
    );
  }
}

/** Run `git` with args. Returns stdout, trimmed and CRLF-normalised. */
export function git(...args: string[]): string {
  assertTrustedLaunchDir();
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
  return gitWithInputRaw(input, args).replace(/\r\n/g, '\n').trim();
}

/**
 * `gitWithInput` with the output UNTOUCHED — no CRLF rewrite, no trim.
 *
 * For a NUL-delimited protocol the convenience form is a corruption. `git
 * check-attr --stdin -z` echoes each path back as a record key, and a path
 * may legally begin with whitespace or contain `\r\n`: the trim eats the
 * leading byte of the first record so its key no longer matches the path that
 * was asked about, and the CRLF rewrite can collide one record's key with a
 * sibling's. The caller then reads a MALFORMED identity rather than an honest
 * `UNHASHABLE` — and in one concrete direction it fails OPEN, because the
 * eaten record is the `diff` attribute, so a `diff=<driver>` path never folds
 * its driver's `binary` setting in and the config-side binary↔text flip the
 * identity exists to track goes invisible.
 */
export function gitWithInputRaw(input: Buffer, args: string[]): string {
  assertTrustedLaunchDir();
  return execFileSync('git', args, {
    ...gitOpts(),
    encoding: 'utf8',
    input,
    // The same raised ceiling `gitRaw` takes, for the same reason. The one
    // caller is `check-attr --stdin -z`, which emits roughly three records
    // per path: this repository's ~6,270 hashable source files produce about
    // 1.16 MB, over `execFileSync`'s 1 MB default. Past it the call throws
    // ENOBUFS, `renderingAttributes`' blanket catch answers an empty map, and
    // every identity becomes UNHASHABLE — which never equals itself, so every
    // path reads as changed on every round while the stateId stays stable and
    // no refusal ever prints. The whole target is silently re-reviewed for
    // ever and the unchanged-since stop becomes unreachable.
    maxBuffer: 512 * 1024 * 1024,
  });
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
  return gitProbe(...args).out;
}

/**
 * `gitOpt` with the exit status kept, because for a PREDICATE command the
 * difference matters: `merge-base --is-ancestor` and `cat-file -e` answer
 * "no" with exit 1 and "I could not tell you" with anything above it (128)
 * or with no status at all (a timeout kill, a spawn failure). Collapsing both to `null` made a transient I/O failure
 * indistinguishable from a definitive refusal, and the incremental anchor
 * ruling then reported a rebase that never happened — a reason its recovery
 * flow treats as deterministic, so the anchor was never retried.
 *
 * `status` is null when the command could not be run at all (spawn failure)
 * or was killed by a signal — which is what the 120s timeout in `gitOpts()`
 * produces: Node sends SIGTERM and `execFileSync` throws with
 * `{status: null, signal: 'SIGTERM'}`. A timeout is therefore a null status,
 * not a high one; both route to the same "surface unavailable" handling, but
 * the distinction matters to anyone reading this to predict a value.
 *
 * A launch directory this process must not resolve through lands in the same
 * `status: null` — the command genuinely could not be run — but it is the one
 * case with a reason a caller can hand to a user, so it also comes back in
 * `refusal`. Callers that REPORT rather than retry need the split: reading a
 * null `out` as git's answer made `releaseWorktree` certify a release whose
 * registration and branch both survived, and `load-rules` write an empty rules
 * file into every agent brief while printing "no review rules found".
 */
export function gitProbe(...args: string[]): {
  out: string | null;
  status: number | null;
  refusal: string | null;
} {
  const refusal = launchDirRefusal();
  if (refusal !== null) return { out: null, status: null, refusal };
  try {
    return {
      out: execFileSync('git', args, {
        ...gitOpts(),
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      })
        .replace(/\r\n/g, '\n')
        .trim(),
      status: 0,
      refusal: null,
    };
  } catch (err) {
    const status = (err as { status?: unknown }).status;
    return {
      out: null,
      status: typeof status === 'number' ? status : null,
      refusal: null,
    };
  }
}

/** True iff a ref (branch / tag / commit) exists locally. */
export function refExists(ref: string): boolean {
  return gitOpt('rev-parse', '--verify', '--quiet', ref) !== null;
}

/** What `releaseWorktree` found at the path, and what it managed to do about it. */
export interface WorktreeRelease {
  /** Something was at the path when we started. */
  existed: boolean;
  /** The path is free now — a `git worktree add` over it will succeed. */
  freed: boolean;
  /**
   * Why the path is not free, set only when `existed && !freed`. A boolean
   * cannot say both "there is still something there" and "here is why", and a
   * caller that has to hand the problem to a human needs the second half:
   * without it, cleanup either lies ("Removed …") or goes silent, and both were
   * shipped and caught in review.
   */
  reason?: string;
}

/**
 * Rule on a release attempt: what was there, what is there now, what went wrong.
 *
 * Pure, and extracted for that reason. The interesting outcome — `existed` but
 * not `freed` — needs `rmSync` to hit EPERM or EBUSY, and nothing portable
 * forces those: as root the permission lever is bypassed outright, and under
 * CI's unprivileged user it behaves differently, so a `chmod`-based test would
 * assert one thing locally and another in CI. Mocking `node:fs` does not reach
 * this module under the suite's config either. The composition is where the
 * logic lives, so it is testable here on its own.
 *
 * `reason` is never left unset when the path survived: a caller that has to tell
 * a human "this is still on disk" is useless without "and here is why", so when
 * there is no exception to quote it names the situation instead.
 */
export function worktreeReleaseResult(
  existed: boolean,
  stillThere: boolean,
  removeError?: unknown,
): WorktreeRelease {
  const freed = existed && !stillThere;
  if (!existed || freed) {
    return { existed, freed, reason: undefined };
  }
  return {
    existed,
    freed,
    reason: removeError
      ? removeError instanceof Error
        ? removeError.message
        : String(removeError)
      : 'the path is still there after `git worktree remove --force` and `rm -rf`',
  };
}

/**
 * Free a review worktree's path **and** its branch.
 *
 * Never throws — see the `rmSync` below. Reports what happened through the
 * result: `existed` (something was there), `freed` (it is gone now), and
 * `reason` when it is still there.
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
export function releaseWorktree(worktreePath: string): WorktreeRelease {
  // An ANCESTOR symlink first, because the leaf guard below cannot see one:
  // `lstatSync` dereferences every component except the last, so a link at
  // `.qwen/tmp` makes every path under it lstat as an ordinary directory while
  // `git worktree remove --force` and the `rmSync` fallback both land in
  // whatever checkout it points at. `runCleanup` refuses its whole sweep for
  // this reason; `cleanStale` releases with no guard of its own, so the
  // refusal belongs at this choke point where every caller inherits it.
  // `dirname`, because the LEAF is the branch below: a link AT the path is
  // unlinked rather than refused, which is what clears it out of the next
  // `worktree add`'s way.
  const redirected = redirectedAncestor(dirname(resolve(worktreePath)));
  if (redirected !== null) {
    // `existed`/`stillThere` both true: the contract's `reason` is only carried
    // when something is still there, and a refusal is exactly that — the
    // caller must log it and must not report the path as swept.
    return worktreeReleaseResult(
      true,
      true,
      new Error(
        `refusing to release through a symlink: ${redirected} is a symlink, ` +
          `so the removal would land wherever it points`,
      ),
    );
  }
  // A symlink at the path must never reach the removal below: `existsSync`
  // follows a LIVE link and `git worktree remove --force` resolves it —
  // together they delete whichever registered worktree the link points at
  // (the user's own, another review's live tree) while reporting this path
  // as swept. `lstatSync` sees the link itself, and `rmSync` unlinks it
  // rather than following it. A DANGLING link `existsSync` cannot see at
  // all still wedges the next `worktree add`, and the same unlink clears
  // it. The guard cleanup's family sweep applies to every path it releases
  // lives here at the choke point, so no release path can lose it.
  try {
    if (lstatSync(worktreePath).isSymbolicLink()) {
      let removeError: unknown;
      try {
        rmSync(worktreePath, { force: true });
      } catch (e) {
        removeError = e;
      }
      // prune still runs: a registration whose tree once stood at this
      // path must not wedge the next `worktree add` or hold the branch
      // checked out.
      const pruned = gitProbe('worktree', 'prune');
      let stillThere = false;
      try {
        lstatSync(worktreePath);
        stillThere = true;
      } catch {
        // The link is gone — freed.
      }
      return worktreeReleaseResult(
        true,
        stillThere || pruned.refusal !== null,
        removeError ?? refusalError(pruned.refusal),
      );
    }
  } catch {
    // Nothing at the path: the `existsSync` below answers that case.
  }
  const existed = existsSync(worktreePath);
  let removeError: unknown;
  // `status === null` is "the command could not be run at all"; git answers a
  // path it does not know with 128. So a null is never "nothing to remove" —
  // and reading it that way let the `rmSync` below delete the DIRECTORY while
  // the registration under `<repo>/.git/worktrees/` and the branch both
  // survived, reporting `freed: true` over a path the next `worktree add`
  // still refuses with "missing but already registered": the exact wedge this
  // function's docstring exists to prevent, reported as fixed.
  const removed = existed
    ? gitProbe('worktree', 'remove', worktreePath, '--force')
    : null;
  if (existed) {
    // `worktree remove` only clears a tree git still tracks. A directory left at
    // the path after metadata loss or a partial cleanup is reported "not a
    // working tree" and left in place — and a non-empty one then blocks the next
    // `worktree add` with `already exists`. So remove whatever remains. `rmSync`
    // unlinks a symlink rather than following it, so a tampered leftover cannot
    // redirect the delete.
    //
    // Not allowed to throw, like every other failure here: `force` suppresses
    // ENOENT but not EPERM or EBUSY, and this runs on the cleanup path, where an
    // exception masks the error that got us there. But the reason must not be
    // lost either — a caller that has to tell a human "this path is still there"
    // is useless without "and here is why". So: caught, and carried out in the
    // result.
    try {
      rmSync(worktreePath, { recursive: true, force: true });
    } catch (e) {
      removeError = e;
    }
  }
  const pruned = gitProbe('worktree', 'prune');
  const refusal = removed?.refusal ?? pruned.refusal;
  const stillThere = existsSync(worktreePath);
  // A path that IS gone but a release that did not happen: git never ran, so
  // the registration and the branch survive. `stillThere` is how the result
  // says "not freed", and the reason must be set or cleanup prints `Failed to
  // remove worktree <path>: undefined`.
  return worktreeReleaseResult(
    existed,
    stillThere || (existed && refusal !== null),
    removeError ?? refusalError(refusal),
  );
}

/** The `reason` for a release git was refused, or undefined when it was not. */
function refusalError(refusal: string | null): Error | undefined {
  if (refusal === null) return undefined;
  return new Error(
    `git could not run from this directory — ${refusal}. The directory is ` +
      `cleared but this worktree's registration and branch were not, so the ` +
      `next \`git worktree add\` over it will still fail. Run \`qwen review ` +
      `cleanup\` from a checkout outside the review temp dir.`,
  );
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
  assertTrustedLaunchDir();
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
