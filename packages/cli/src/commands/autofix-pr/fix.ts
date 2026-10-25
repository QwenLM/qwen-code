/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// `qwen autofix-pr fix-start` and `fix-end`: the attempt of a fix agent the
// session runs in the background (Section 6.14). The session opens it as it
// launches the agent, refreshes the marker's time while the attempt lives,
// and the round that goes on when the agent ends claims it. While the marker
// is fresh, the helpers that would act on the worktree or the PR refuse and
// the gate stays quiet.

import { lstatSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { CommandModule } from 'yargs';
import { atomicWriteFileSync } from '@qwen-code/qwen-code-core/utils/atomicFileWrite.js';
import { writeStdoutLine } from '../../utils/stdioHelpers.js';
import {
  assertWatching,
  autofixPrPaths,
  isRegularFile,
  NO_FOLLOW,
  repoRoot,
  requireState,
  TASK_OPTION,
  taskArg,
  withWatchLock,
  type AutofixPrPaths,
} from './state.js';

export interface AutofixPrFixAttempt {
  version: 1;
  attempt: string;
  /** The watch's task when the attempt started. */
  task: string;
  /** The head the attempt started from. */
  head: string;
  startedAt: string;
}

/** The session refreshes the marker every 30 seconds. */
export const FIX_FRESH_MS = 90_000;
/** The session stops the agent at 30 minutes and waits 10 for the claim: a
 * marker kept fresh for longer is no attempt of the session's. */
export const FIX_MAX_AGE_MS = 45 * 60_000;
/** How far ahead of this clock another's may run. */
const CLOCK_SKEW_MS = 60_000;
/** How old a round's snapshot may be when its fix starts. */
export const FIX_SNAPSHOT_MAX_AGE_MS = 30 * 60_000;

// The session makes the id: `randomBytes(6)`, in hex.
const ATTEMPT_RE = /^[0-9a-f]{12}$/;

function assertAttemptId(attempt: string): void {
  if (!ATTEMPT_RE.test(attempt)) {
    throw new TypeError(
      `--attempt must be the id the session opened the attempt with, got ${JSON.stringify(attempt)}`,
    );
  }
}

function isFixAttempt(value: unknown): value is AutofixPrFixAttempt {
  const v = value as Partial<AutofixPrFixAttempt> | null;
  return (
    typeof v === 'object' &&
    v !== null &&
    v.version === 1 &&
    typeof v.attempt === 'string' &&
    ATTEMPT_RE.test(v.attempt) &&
    typeof v.task === 'string' &&
    typeof v.head === 'string' &&
    typeof v.startedAt === 'string' &&
    Number.isFinite(Date.parse(v.startedAt))
  );
}

/**
 * The marker as it is on disk: absent (null), or present with its attempt —
 * null when it is not one, which is never fresh — and its modification time.
 */
export function readFixMarker(
  paths: AutofixPrPaths,
): { attempt: AutofixPrFixAttempt | null; mtimeMs: number } | null {
  const stat = lstatSync(paths.fixPath, { throwIfNoEntry: false });
  if (!stat) return null;
  if (!stat.isFile()) return { attempt: null, mtimeMs: stat.mtimeMs };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(paths.fixPath, 'utf8'));
  } catch {
    parsed = null;
  }
  return {
    attempt: isFixAttempt(parsed) ? parsed : null,
    mtimeMs: stat.mtimeMs,
  };
}

/**
 * The attempt whose agent is working in the worktree: a marker the session
 * refreshed just now, of an attempt that started neither ahead of this
 * clock nor longer ago than any attempt lives. Anything else is a marker
 * its session left behind when it ended.
 */
export function fixInFlight(
  paths: AutofixPrPaths,
  now = Date.now(),
): AutofixPrFixAttempt | null {
  const marker = readFixMarker(paths);
  if (!marker?.attempt) return null;
  const started = Date.parse(marker.attempt.startedAt);
  const fresh =
    marker.mtimeMs <= now + CLOCK_SKEW_MS &&
    now - marker.mtimeMs <= FIX_FRESH_MS &&
    started <= now + CLOCK_SKEW_MS &&
    now - started < FIX_MAX_AGE_MS;
  return fresh ? marker.attempt : null;
}

/** Refuses while a fix agent works in the PR's worktree. */
export function assertNoFixInFlight(
  paths: AutofixPrPaths,
  prNumber: number,
  now = Date.now(),
): void {
  const attempt = fixInFlight(paths, now);
  if (!attempt) return;
  throw new Error(
    `a fix agent is working in PR #${prNumber}'s worktree (attempt ` +
      `${attempt.attempt}, started ${attempt.startedAt}); its round goes on ` +
      `when it ends. In the session that runs it, /autofix-pr stop ` +
      `${prNumber} stops it; it ends by itself within 40 minutes.`,
  );
}

/**
 * Removes a marker its session left behind, and says when that attempt
 * started (null when the marker named none). A fresh marker is kept.
 */
export function clearAbandonedFix(
  paths: AutofixPrPaths,
  now = Date.now(),
): { startedAt: string | null } | null {
  const marker = readFixMarker(paths);
  if (!marker || fixInFlight(paths, now)) return null;
  // Recursive: a directory planted under the name is no attempt either.
  rmSync(paths.fixPath, { force: true, recursive: true });
  // Its round's snapshot goes with it: no later attempt starts from that.
  if (isRegularFile(paths.snapshotPath)) rmSync(paths.snapshotPath);
  return { startedAt: marker.attempt?.startedAt ?? null };
}

/** Where the round writes its brief: beside the state file. */
export function briefPath(paths: AutofixPrPaths, prNumber: number): string {
  return join(dirname(paths.statePath), `autofix-pr-${prNumber}-brief.md`);
}

/** Where a claimed attempt's snapshot goes: no later attempt takes it. */
export function fixSnapshotPath(
  paths: AutofixPrPaths,
  prNumber: number,
): string {
  return join(
    dirname(paths.statePath),
    `autofix-pr-${prNumber}-fix-snapshot.json`,
  );
}

/**
 * Refuses unless the round prepared a snapshot to fix, at the watch's head
 * and recently, that no attempt claimed yet: an attempt is that round's,
 * not any agent's the session starts at the worktree.
 */
function assertRoundToFix(
  paths: AutofixPrPaths,
  prNumber: number,
  head: string,
): void {
  const stat = lstatSync(paths.snapshotPath, { throwIfNoEntry: false });
  let snapshot: { action?: unknown; headSha?: unknown } | null = null;
  if (stat?.isFile()) {
    try {
      snapshot = JSON.parse(readFileSync(paths.snapshotPath, 'utf8'));
    } catch {
      snapshot = null;
    }
  }
  if (
    !stat ||
    snapshot?.action !== 'fix' ||
    snapshot.headSha !== head ||
    Date.now() - stat.mtimeMs > FIX_SNAPSHOT_MAX_AGE_MS
  ) {
    throw new Error(
      `no round of PR #${prNumber} has a fix to start: a fix runs in the ` +
        `background only after the round's snapshot (action "fix" at the ` +
        `watch's head, within ${FIX_SNAPSHOT_MAX_AGE_MS / 60_000} minutes).`,
    );
  }
}

export interface FixStartArgs {
  pr: number;
  attempt: string;
}

export function runFixStart(args: FixStartArgs): AutofixPrFixAttempt & {
  marker: string;
} {
  assertAttemptId(args.attempt);
  const paths = autofixPrPaths(repoRoot(), args.pr);
  return withWatchLock(paths, args.pr, () => {
    const state = requireState(paths.statePath, args.pr);
    assertWatching(state);
    const task = state.watch?.task;
    if (!task) {
      throw new Error(
        `PR #${args.pr} has no scheduled task: a fix runs in the background only in a watch.`,
      );
    }
    const running = fixInFlight(paths);
    if (running) {
      throw new Error(
        `attempt ${running.attempt} of PR #${args.pr}'s fix is still in flight (started ${running.startedAt}).`,
      );
    }
    // Only a round's sync (or a take-over, or cleanup) removes one its
    // session left behind, and the round then discards what it made.
    if (readFixMarker(paths)) {
      throw new Error(
        `an earlier attempt of PR #${args.pr}'s fix was left behind; the round's sync removes it first.`,
      );
    }
    assertRoundToFix(paths, args.pr, state.lastKnownHeadSha);
    const attempt: AutofixPrFixAttempt = {
      version: 1,
      attempt: args.attempt,
      task,
      head: state.lastKnownHeadSha,
      startedAt: new Date().toISOString(),
    };
    atomicWriteFileSync(
      paths.fixPath,
      `${JSON.stringify(attempt, null, 2)}\n`,
      NO_FOLLOW,
    );
    return { ...attempt, marker: paths.fixPath };
  });
}

export interface FixEndArgs {
  pr: number;
  attempt: string;
  task?: string;
}

export interface FixEndResult {
  attempt: string;
  head: string;
  startedAt: string;
  /** The snapshot of the round the attempt belongs to. */
  snapshot: string;
  brief: string;
}

export function runFixEnd(args: FixEndArgs): FixEndResult {
  assertAttemptId(args.attempt);
  const paths = autofixPrPaths(repoRoot(), args.pr);
  return withWatchLock(paths, args.pr, () => {
    const state = requireState(paths.statePath, args.pr);
    assertWatching(state, args.task);
    const marker = readFixMarker(paths);
    if (marker?.attempt?.attempt !== args.attempt) {
      throw new Error(
        `attempt ${args.attempt} of PR #${args.pr}'s fix is not in flight: ` +
          `it was abandoned, or a later round discarded it.`,
      );
    }
    rmSync(paths.fixPath, { force: true });
    // The round's snapshot, claimed: no later attempt starts from it. Its
    // `--no-reply` and instructions are the session's to say, from what
    // `schedule` printed it, not this file's.
    const snapshot = fixSnapshotPath(paths, args.pr);
    if (isRegularFile(paths.snapshotPath)) {
      renameSync(paths.snapshotPath, snapshot);
    }
    return {
      attempt: marker.attempt.attempt,
      head: marker.attempt.head,
      startedAt: marker.attempt.startedAt,
      snapshot,
      brief: briefPath(paths, args.pr),
    };
  });
}

const ATTEMPT_OPTION = {
  type: 'string',
  demandOption: true,
  requiresArg: true,
  describe: 'The id the session opened the attempt with',
} as const;

export const fixStartCommand: CommandModule = {
  command: 'fix-start <pr>',
  describe:
    'Open the attempt of a background fix agent (run by the session as it launches the agent)',
  builder: (yargs) =>
    yargs
      .positional('pr', {
        type: 'number',
        demandOption: true,
        describe: 'PR number',
      })
      .option('attempt', ATTEMPT_OPTION),
  handler: (argv) => {
    writeStdoutLine(
      JSON.stringify(
        runFixStart({
          pr: Number(argv['pr']),
          attempt: String(argv['attempt']),
        }),
      ),
    );
  },
};

export const fixEndCommand: CommandModule = {
  command: 'fix-end <pr>',
  describe:
    "Claim a background fix's attempt once its agent ended, and print what the rest of the round needs",
  builder: (yargs) =>
    yargs
      .positional('pr', {
        type: 'number',
        demandOption: true,
        describe: 'PR number',
      })
      .option('attempt', ATTEMPT_OPTION)
      .option('task', TASK_OPTION),
  handler: (argv) => {
    writeStdoutLine(
      JSON.stringify(
        runFixEnd({
          pr: Number(argv['pr']),
          attempt: String(argv['attempt']),
          task: taskArg(argv),
        }),
      ),
    );
  },
};
