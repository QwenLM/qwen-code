/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// `qwen autofix-pr status`: what each watch of this clone recorded, read from
// its files alone — no lock and no GitHub call — so `/autofix-pr status` and
// `/autofix-pr resume` see every watch, whichever session owns it.

import { existsSync, lstatSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { CommandModule } from 'yargs';
import { writeStdoutLine } from '../../utils/stdioHelpers.js';
import { unsavedWork } from './cleanup.js';
import { DEFAULT_EVERY } from './schedule.js';
import {
  assertPositiveInteger,
  autofixPrPaths,
  currentSessionId,
  MAX_PUSHES,
  readGateCursor,
  readState,
  repoRoot,
  sameRepository,
  type AutofixPrGateCursor,
  type AutofixPrWatchOptions,
  type NeedsHumanItem,
} from './state.js';

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
  thisSession: boolean;
  /** The last gate run that read the PR, or null before the first. */
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
  needsHuman: NeedsHumanItem[];
  worktreePath: string;
  worktreeExists: boolean;
  /** What the worktree (or its branch) holds that the PR does not, as
   * `cleanup` judges it without asking the remote, or null. A round that
   * starts on it discards it. */
  worktreeWork: string | null;
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

/** The gate cursor of this watch's repository, or null. The cursor outlives
 * a watch (`cleanup` keeps it), so it may be another repository's PR of the
 * same number; one that cannot be read says nothing about the watch. */
function cursorOf(
  path: string,
  state: { host: string; owner: string; repo: string },
): AutofixPrGateCursor | null {
  try {
    const cursor = isPlainFile(path) ? readGateCursor(path) : null;
    return cursor && sameRepository(cursor, state) ? cursor : null;
  } catch {
    return null;
  }
}

/** A regular file: a FIFO planted under that name would block the read. */
function isPlainFile(path: string): boolean {
  try {
    return lstatSync(path).isFile();
  } catch {
    return false;
  }
}

function modifiedAt(path: string): string | null {
  try {
    return statSync(path).mtime.toISOString();
  } catch {
    return null;
  }
}

export function runStatus(args: { pr?: number }): StatusOutcome {
  if (args.pr !== undefined) assertPositiveInteger(args.pr, 'PR number');
  const root = repoRoot();
  const tmp = join(root, '.qwen', 'tmp');
  const numbers = (existsSync(tmp) ? readdirSync(tmp) : [])
    .map((name) => STATE_FILE_RE.exec(name)?.[1])
    .filter((n): n is string => n !== undefined)
    .map(Number)
    .filter((n) => Number.isSafeInteger(n) && n > 0)
    .filter((n) => args.pr === undefined || n === args.pr)
    .sort((a, b) => a - b);
  const session = currentSessionId();
  const now = Date.now();
  const outcome: StatusOutcome = {
    now: new Date(now).toISOString(),
    watches: [],
  };
  for (const pr of numbers) {
    const paths = autofixPrPaths(root, pr);
    try {
      if (!isPlainFile(paths.statePath)) {
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
      const lastCheck = cursor ? modifiedAt(paths.gatePath) : null;
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
        thisSession: state.sessionId === session,
        // The gate touches its cursor on every run that read the PR.
        lastCheck,
        checkedRecently:
          lastCheck !== null &&
          now - Date.parse(lastCheck) < 2 * every * 60_000,
        lastRound: modifiedAt(paths.snapshotPath),
        stopped: cursor?.stopped ?? null,
        watch: state.watch ?? null,
        needsHuman: state.needsHuman ?? [],
        // The recorded path goes stale when the clone moves; this one does not.
        worktreePath: paths.worktreePath,
        worktreeExists: existsSync(paths.worktreePath),
        worktreeWork: unsavedWork(paths, [
          state.lastKnownHeadSha,
          ...state.pushedShas,
        ]),
      });
    } catch (err) {
      (outcome.unreadable ??= []).push({
        pr,
        error: (err as Error).message,
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
    yargs.positional('pr', {
      type: 'number',
      describe: 'Only this PR',
    }),
  handler: (argv) => {
    writeStdoutLine(
      JSON.stringify(
        runStatus({
          pr: argv['pr'] === undefined ? undefined : Number(argv['pr']),
        }),
      ),
    );
  },
};
