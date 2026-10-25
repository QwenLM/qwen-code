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
import {
  assertPositiveInteger,
  autofixPrPaths,
  currentSessionId,
  MAX_PUSHES,
  readGateCursor,
  readState,
  repoRoot,
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
  /** The last round's prepared snapshot, or null before the first. */
  lastRound: string | null;
  /** The gate saw the PR merged or closed; the watch was not cleaned up. */
  stopped: 'merged' | 'closed' | null;
  /** The scheduled task `schedule` recorded; null for `--once`. */
  watch: AutofixPrWatchOptions | null;
  needsHuman: NeedsHumanItem[];
  worktreePath: string;
  worktreeExists: boolean;
}

export interface StatusOutcome {
  watches: WatchStatus[];
  /** State files that could not be read, with the reason. */
  unreadable?: Array<{ pr: number; error: string }>;
}

const STATE_FILE_RE = /^autofix-pr-(\d+)-state\.json$/;

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
  const outcome: StatusOutcome = { watches: [] };
  for (const pr of numbers) {
    const paths = autofixPrPaths(root, pr);
    try {
      const state = readState(paths.statePath);
      if (!state) continue;
      const cursor = existsSync(paths.gatePath)
        ? readGateCursor(paths.gatePath)
        : null;
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
        lastCheck: cursor ? modifiedAt(paths.gatePath) : null,
        lastRound: modifiedAt(paths.snapshotPath),
        stopped: cursor?.stopped ?? null,
        watch: state.watch ?? null,
        needsHuman: state.needsHuman ?? [],
        // The recorded path goes stale when the clone moves; this one does not.
        worktreePath: paths.worktreePath,
        worktreeExists: existsSync(paths.worktreePath),
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
