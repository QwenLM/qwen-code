/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// `qwen autofix-pr status`: what each watch of this clone recorded, read from
// its files alone — no lock and no GitHub call — so `/autofix-pr status` and
// `/autofix-pr resume` see every watch, whichever session owns it.

import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { CommandModule } from 'yargs';
import { writeStdoutLine } from '../../utils/stdioHelpers.js';
import { unsavedWork } from './cleanup.js';
import { untrustedGitfile, untrustedSubmodules } from './worktree.js';
import { DEFAULT_EVERY } from './schedule.js';
import {
  assertPositiveInteger,
  autofixPrPaths,
  cloneWorktreeRoots,
  currentSessionId,
  isRegularFile,
  MAX_PUSHES,
  readGateCursor,
  readState,
  sameRepository,
  trustAnchor,
  vouchedScanRoots,
  type AutofixPrGateCursor,
  type AutofixPrWatchOptions,
  type NeedsHumanItem,
} from './state.js';
import { fixInFlight, fixSnapshotPath, readFixMarker } from './fix.js';

export interface WatchStatus {
  pr: number;
  repo: string;
  host: string;
  url: string;
  headRefName: string;
  pushTarget: string;
  headSha: string;
  pushes: number;
  maxPushes: number;
  /** The session that owns the watch; '' when prepared outside one. */
  session: string;
  /** When `prepare` made the watch, or null for one from before it said. */
  preparedAt: string | null;
  thisSession: boolean;
  /** The last run of the watch's own gate (one with its session) that read
   * the PR, or null before the first. */
  lastCheck: string | null;
  /** `lastCheck` is within two of the watch's intervals: a gate, of this
   * session or another, is likely still running. */
  checkedRecently: boolean;
  /** The last round's prepared snapshot, or null before the first. */
  lastRound: string | null;
  /** The PR was merged or closed when the gate last read it, and the watch
   * was not cleaned up. As of `lastCheck`: the PR may have been reopened. */
  stopped: 'merged' | 'closed' | null;
  /** The scheduled task `schedule` recorded; null for `--once`. */
  watch: AutofixPrWatchOptions | null;
  /** A `cleanup` that kept the worktree ended the watch: when and why. */
  ended: { at: string; reason: string } | null;
  needsHuman: NeedsHumanItem[];
  worktreePath: string;
  worktreeExists: boolean;
  /** Every git directory a command in the worktree reads — its own and
   * each checked-out submodule's — is one the clone keeps, outside the
   * worktree; read from the files (Section 6.12 of the design). */
  gitTrusted: boolean;
  /** What the worktree (or its branch) holds that the PR does not, as
   * `cleanup` judges it without asking the remote, or null. A round that
   * starts on it discards it. */
  worktreeWork: string | null;
  /** The attempt of a fix agent run in the background, or null: while
   * `fresh` it has not ended — its agent works in the worktree, or has
   * ended (finished or stopped) and the round may still claim it — and the
   * round's helpers refuse; otherwise its session left it behind (Section 6.14). */
  fix: {
    attempt: string | null;
    startedAt: string | null;
    fresh: boolean;
  } | null;
}

export interface StatusOutcome {
  /** When this was read, for comparing `lastCheck` with. */
  now: string;
  watches: WatchStatus[];
  /** State files that could not be read, with the reason. */
  unreadable?: Array<{ pr: number; error: string }>;
}

// The name `autofixPrPaths` gives it: no leading zero.
const STATE_FILE_RE = /^autofix-pr-([1-9]\d*)-state\.json$/;

/** The gate cursor of this watch, or null. The cursor outlives a watch
 * (`cleanup` keeps it), so it may be another repository's PR of the same
 * number, or what the gate saw before this watch was prepared — a PR
 * closed then, and reopened since; one that cannot be read says nothing
 * about the watch. */
function cursorOf(
  path: string,
  state: { host: string; owner: string; repo: string; preparedAt?: string },
): AutofixPrGateCursor | null {
  try {
    const cursor = isRegularFile(path) ? readGateCursor(path) : null;
    if (!cursor || !sameRepository(cursor, state)) return null;
    if (
      state.preparedAt !== undefined &&
      statSync(path).mtimeMs < Date.parse(state.preparedAt)
    ) {
      return null;
    }
    return cursor;
  } catch {
    return null;
  }
}

function latest(a: string | null, b: string | null): string | null {
  if (a === null || b === null) return a ?? b;
  return Date.parse(a) >= Date.parse(b) ? a : b;
}

function fixOf(
  paths: ReturnType<typeof autofixPrPaths>,
  now: number,
): WatchStatus['fix'] {
  const marker = readFixMarker(paths);
  if (!marker) return null;
  return {
    attempt: marker.attempt?.attempt ?? null,
    startedAt: marker.attempt?.startedAt ?? null,
    fresh: fixInFlight(paths, now) !== null,
  };
}

function modifiedAt(path: string): string | null {
  try {
    return statSync(path).mtime.toISOString();
  } catch {
    return null;
  }
}

export function runStatus(args: {
  pr?: number;
  /** false skips `worktreeWork` (null), a git scan of the worktree. */
  work?: boolean;
  /** false runs no git command at all: `worktreeWork` is null and
   * `gitTrusted` false, unchecked. The daemon's listing runs on its own
   * thread, where a git command that hangs would hold every request. */
  git?: boolean;
  /** Scan only this worktree's `.qwen/tmp`, not the whole clone. By default
   * every worktree of the clone is scanned, so a watch is found whichever of
   * them holds it. */
  root?: string;
  /** Scan exactly these worktrees' `.qwen/tmp`, running no git command to
   * find them: the daemon enumerates the clone's worktrees itself, on its
   * own short timeout, and passes them here. Takes precedence over `root`. */
  roots?: string[];
  /** Whose watches are `thisSession`: by default, the session this runs in
   * (`QWEN_CODE_SESSION_ID`); null for none. */
  session?: string | null;
}): StatusOutcome {
  if (args.pr !== undefined) assertPositiveInteger(args.pr, 'PR number');
  const roots =
    args.roots ??
    (args.root !== undefined ? [args.root] : cloneWorktreeRoots());
  // Only genuine, non-nested worktrees of this clone are read: a watch
  // worktree's own `.qwen/tmp` or a foreign repository at a stale entry must
  // not forge a watch.
  const scanRoots = vouchedScanRoots(roots);
  const primary = scanRoots[0];
  // The worktree whose `.qwen/tmp` holds each PR's state. Git forbids one
  // branch in two worktrees, so a PR's watch lives in at most one; a stale
  // state file left in another loses to the one with a live worktree.
  const rootByPr = new Map<number, string>();
  for (const root of scanRoots) {
    const tmp = join(root, '.qwen', 'tmp');
    let found: number[];
    try {
      found = (existsSync(tmp) ? readdirSync(tmp) : [])
        .map((name) => STATE_FILE_RE.exec(name)?.[1])
        .filter((n): n is string => n !== undefined)
        .map(Number)
        .filter((n) => Number.isSafeInteger(n) && n > 0)
        .filter((n) => args.pr === undefined || n === args.pr);
    } catch (err) {
      // The primary root's read failure is a real diagnostic, not an empty
      // listing — surface it. A sibling worktree's `.qwen/tmp` may be a
      // regular file or inaccessible (ENOTDIR/EACCES); that root holds no
      // readable watch, and one bad sibling must not abort the listing of
      // every other worktree's watches (a 500 for the whole clone via daemon).
      if (root === primary) throw err;
      continue;
    }
    for (const pr of found) {
      const prev = rootByPr.get(pr);
      if (
        prev === undefined ||
        (!existsSync(autofixPrPaths(prev, pr).worktreePath) &&
          existsSync(autofixPrPaths(root, pr).worktreePath))
      ) {
        rootByPr.set(pr, root);
      }
    }
  }
  const numbers = [...rootByPr.keys()].sort((a, b) => a - b);
  const session =
    args.session === undefined ? currentSessionId() : args.session;
  const now = Date.now();
  const outcome: StatusOutcome = {
    now: new Date(now).toISOString(),
    watches: [],
  };
  for (const pr of numbers) {
    const root = rootByPr.get(pr)!;
    const paths = autofixPrPaths(root, pr);
    try {
      if (!isRegularFile(paths.statePath)) {
        throw new Error(`${paths.statePath} is not a regular file`);
      }
      const state = readState(paths.statePath);
      if (!state) continue;
      // Every helper finds a watch by its file's number.
      if (state.prNumber !== pr) {
        throw new Error(
          `${paths.statePath} is the state of PR #${state.prNumber}`,
        );
      }
      const cursor = cursorOf(paths.gatePath, state);
      const lastCheck = isRegularFile(paths.checkedPath)
        ? modifiedAt(paths.checkedPath)
        : null;
      const every = state.watch?.every ?? DEFAULT_EVERY;
      outcome.watches.push({
        pr,
        repo: `${state.owner}/${state.repo}`,
        host: state.host,
        url: `https://${state.host}/${state.owner}/${state.repo}/pull/${pr}`,
        headRefName: state.headRefName,
        pushTarget: state.pushTarget,
        headSha: state.lastKnownHeadSha,
        pushes: state.pushCount ?? 0,
        maxPushes: MAX_PUSHES,
        session: state.sessionId,
        preparedAt: state.preparedAt ?? null,
        thisSession: state.sessionId === session,
        lastCheck,
        checkedRecently:
          lastCheck !== null &&
          now - Date.parse(lastCheck) < 2 * every * 60_000,
        // A claimed attempt took its round's snapshot.
        lastRound: latest(
          modifiedAt(paths.snapshotPath),
          modifiedAt(fixSnapshotPath(paths, pr)),
        ),
        stopped: cursor?.stopped ?? null,
        watch: state.watch ?? null,
        ended: state.ended ?? null,
        needsHuman: state.needsHuman ?? [],
        // The recorded path goes stale when the clone moves; this one does not.
        worktreePath: paths.worktreePath,
        worktreeExists: existsSync(paths.worktreePath),
        // Trust is anchored to the genuine clone recorded for the watch, never
        // to a discovered worktree whose `.git` a round's code could rewrite.
        // Only asked when git checks run — the daemon's `git: false` listing
        // runs no git.
        gitTrusted:
          args.git !== false &&
          existsSync(paths.worktreePath) &&
          (untrustedGitfile(paths.worktreePath, trustAnchor(state)) ??
            untrustedSubmodules(paths.worktreePath, trustAnchor(state))) ===
            null,
        worktreeWork:
          args.work === false || args.git === false
            ? null
            : unsavedWork(
                paths,
                [state.lastKnownHeadSha, ...state.pushedShas],
                undefined,
                trustAnchor(state),
              ),
        fix: fixOf(paths, now),
      });
    } catch (err) {
      const message = (err as Error).message;
      (outcome.unreadable ??= []).push({
        pr,
        // Whatever went wrong, it names the file and the way out.
        error: message.includes('cleanup')
          ? message
          : `${paths.statePath}: ${message}; \`qwen autofix-pr cleanup ${pr} --force\` discards it.`,
      });
    }
  }
  return outcome;
}

export const statusCommand: CommandModule = {
  command: 'status [pr]',
  describe:
    "List this clone's watches from their files: head, pushes, owning session, last check and round, and what needs a human",
  builder: (yargs) =>
    yargs
      .positional('pr', {
        type: 'number',
        describe: 'Only this PR',
      })
      .option('work', {
        type: 'boolean',
        default: true,
        describe:
          'Say what each worktree holds that the PR does not (--no-work skips that git scan, for a quick ownership check)',
      }),
  handler: (argv) => {
    writeStdoutLine(
      JSON.stringify(
        runStatus({
          pr: argv['pr'] === undefined ? undefined : Number(argv['pr']),
          work: argv['work'] !== false,
        }),
      ),
    );
  },
};
