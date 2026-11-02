/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// `qwen autofix-pr rerun`: re-run the failed jobs of a run the fix agent
// judged an infrastructure failure. Each check gets one re-run per head; the
// next failure of that check on the same head is treated as real.

import type { CommandModule } from 'yargs';
import { writeStdoutLine } from '../../utils/stdioHelpers.js';
import {
  ensureAuthenticated,
  ghWithInput,
  setGhHost,
} from '../review/lib/gh.js';
import {
  checkEvents,
  failedJobsOfRun,
  fetchPrData,
  rerunFrom,
} from './snapshot.js';
import {
  assertWatching,
  TASK_OPTION,
  taskArg,
  assertPositiveInteger,
  autofixPrPaths,
  checkAttemptKey,
  resolveWatchRoot,
  requireState,
  rerunFloors,
  withWatchLock,
  writeState,
  type AutofixPrPaths,
} from './state.js';
import { assertNoFixInFlight } from './fix.js';

export interface RerunOutcome {
  rerun: boolean;
  runId: number;
  checks: string[];
  action?: 'resync';
  /** The run is still going: GitHub re-runs a run only once it ended. The
   * gate reports its failures once more then. */
  deferred?: true;
  reason?: string;
}

export function runRerun(
  prNumber: number,
  runId: number,
  task?: string,
): RerunOutcome {
  assertPositiveInteger(runId, 'run id');
  const paths = autofixPrPaths(resolveWatchRoot(prNumber), prNumber);
  return withWatchLock(paths, prNumber, () =>
    rerunLocked(paths, prNumber, runId, task),
  );
}

function rerunLocked(
  paths: AutofixPrPaths,
  prNumber: number,
  runId: number,
  task: string | undefined,
): RerunOutcome {
  const state = requireState(paths.statePath, prNumber);
  assertWatching(state, task);
  assertNoFixInFlight(paths, prNumber);
  setGhHost(state.host);
  ensureAuthenticated();
  const { pr } = fetchPrData(state);
  if (pr.state !== 'OPEN') {
    throw new Error(
      `PR #${prNumber} is ${pr.state.toLowerCase()}; nothing is re-run on it.`,
    );
  }
  if (pr.headRefOid !== state.lastKnownHeadSha) {
    return {
      rerun: false,
      runId,
      checks: [],
      action: 'resync',
      reason: `the PR head moved to ${pr.headRefOid.slice(0, 12)}; its checks are not the ones that failed`,
    };
  }
  // Only a job of this repository's Actions can be re-run with `gh run
  // rerun`: a commit status or another app may link any URL. `checkEvents`
  // gives a run id to such a job only, read against the PR's own URL — the
  // repository's current name, whatever name the watch was prepared under.
  const failed = checkEvents(pr, rerunFloors(state)).failed.filter(
    ({ event, actions }) => actions && event.runId === runId,
  );
  if (failed.length === 0) {
    throw new Error(
      `run ${runId} is no failed GitHub Actions run of ${state.owner}/${state.repo} on PR #${prNumber}'s head ${pr.headRefOid.slice(0, 12)}.`,
    );
  }
  // `--failed` re-runs every failed job of the run, one a later run of its
  // check took the place of on the PR included: each spends its re-run.
  const jobs = failedJobsOfRun(pr, runId);
  const checks = [...new Set(jobs.map(({ check }) => check))];
  // Keyed by the check's identity, not its name: two workflows may each
  // have a failed job of the same name, and each has its own re-run.
  const rerunKeys = jobs.map(({ identity }) => `${identity}@${pr.headRefOid}`);
  // Spent and held re-runs alike: a later run of a check answers either.
  const already = rerunFrom(rerunFloors(state));
  // A run deferred while it was going holds its checks' re-runs apart from
  // the spent ones, under its own id: only it may spend them, and only for
  // the floor it held — a later run of a check (one a review started
  // before it ended, say) answers for it, as a re-run's would.
  const held = new Set(state.heldChecks ?? []);
  const holds = jobs.map(
    ({ floor }, index) => `${runId}:${rerunKeys[index]}@${floor}`,
  );
  const repeated = jobs
    .filter(
      (_, index) => already.has(rerunKeys[index]) && !held.has(holds[index]),
    )
    .map(({ check }) => check);
  // The holds of other runs: this one's are spent by a re-run, or given
  // back by a refusal.
  const othersHolds = (entries: string[]) =>
    entries.filter((entry) => !entry.startsWith(`${runId}:`));
  // Each with the check run the re-run's runs come after, the run's holds
  // included: a check it held that no longer fails in the run (a job
  // re-run on its own since) had its re-run all the same.
  const reran = [
    ...new Set([
      ...(state.rerunChecks ?? []),
      ...jobs.map(({ floor }, index) => `${rerunKeys[index]}@${floor}`),
      ...(state.heldChecks ?? [])
        .filter((entry) => entry.startsWith(`${runId}:`))
        .map((entry) => entry.slice(`${runId}:`.length)),
    ]),
  ];
  if (repeated.length > 0) {
    return {
      rerun: false,
      runId,
      checks,
      reason: `${repeated.join(', ')} was re-run on this head already; treat the failure as real`,
    };
  }
  if (failed.some(({ runDone }) => !runDone)) {
    writeState(paths.statePath, {
      ...state,
      heldChecks: [...new Set([...(state.heldChecks ?? []), ...holds])],
      deferredRuns: [...new Set([...(state.deferredRuns ?? []), runId])],
    });
    return {
      rerun: false,
      runId,
      checks,
      deferred: true,
      reason: `run ${runId} is still in progress; the gate reports its failures again once it has ended, and a later run of these checks counts as their re-run`,
    };
  }
  const attempts = failed.map(({ event, attempt }) =>
    checkAttemptKey(event.check, pr.headRefOid, attempt),
  );
  // The re-run is counted before GitHub is asked, so one whose answer is
  // lost is not asked for twice: at most once, never twice. The failures
  // are marked handled only once GitHub took it, so a re-run GitHub refused
  // leaves them for a human instead of hiding them.
  writeState(paths.statePath, {
    ...state,
    rerunChecks: reran,
    ...(state.heldChecks ? { heldChecks: othersHolds(state.heldChecks) } : {}),
    deferredRuns: (state.deferredRuns ?? []).filter((id) => id !== runId),
  });
  try {
    // `--failed` re-runs every failed job of the run, so every failed
    // check of it spends its re-run. Not retried, for the same reason.
    ghWithInput(
      '',
      'run',
      'rerun',
      String(runId),
      '--failed',
      '-R',
      `${state.owner}/${state.repo}`,
    );
  } catch (err) {
    const message = (err as Error).message;
    // A refusal (4xx: no permission, a run too old) re-ran nothing, so the
    // budget is given back; anything else may have reached GitHub.
    // gh words a 403 as "run <id> cannot be rerun; <reason>" (a token
    // without `actions: write`, a run too old), other 4xx as "HTTP 4xx".
    const refused = /\bHTTP 4\d\d\b|\bcannot be rerun\b/.test(message);
    // One a deferral held is given back as well.
    if (refused) {
      writeState(paths.statePath, {
        ...state,
        ...(state.heldChecks
          ? { heldChecks: othersHolds(state.heldChecks) }
          : {}),
      });
    }
    throw new Error(
      `GitHub did not re-run run ${runId}${refused ? '' : ' (or its answer was lost; the re-run is counted)'}: ${message.trim().split('\n').slice(-3).join(' ')} — answer its failures as needing a human.`,
    );
  }
  writeState(paths.statePath, {
    ...state,
    rerunChecks: reran,
    ...(state.heldChecks ? { heldChecks: othersHolds(state.heldChecks) } : {}),
    handledChecks: [...(state.handledChecks ?? []), ...attempts],
    deferredRuns: (state.deferredRuns ?? []).filter((id) => id !== runId),
  });
  return { rerun: true, runId, checks };
}

export const rerunCommand: CommandModule = {
  command: 'rerun <pr> <run-id>',
  describe:
    "Re-run a run's failed jobs once per check and head, for a failure judged to be infrastructure",
  builder: (yargs) =>
    yargs
      .positional('pr', {
        type: 'number',
        demandOption: true,
        describe: 'PR number',
      })
      .positional('run-id', {
        type: 'number',
        demandOption: true,
        describe: 'Actions run id (`runId` of a ci_failed event)',
      })
      .option('task', TASK_OPTION),
  handler: (argv) => {
    writeStdoutLine(
      JSON.stringify(
        runRerun(Number(argv['pr']), Number(argv['runId']), taskArg(argv)),
      ),
    );
  },
};
