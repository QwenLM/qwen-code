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
import { checkEvents, fetchPrData } from './snapshot.js';
import {
  assertOwnedBySession,
  assertPositiveInteger,
  autofixPrPaths,
  checkAttemptKey,
  repoRoot,
  requireState,
  withWatchLock,
  writeState,
  type AutofixPrPaths,
} from './state.js';

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

export function runRerun(prNumber: number, runId: number): RerunOutcome {
  assertPositiveInteger(runId, 'run id');
  const paths = autofixPrPaths(repoRoot(), prNumber);
  return withWatchLock(paths, prNumber, () =>
    rerunLocked(paths, prNumber, runId),
  );
}

function rerunLocked(
  paths: AutofixPrPaths,
  prNumber: number,
  runId: number,
): RerunOutcome {
  const state = requireState(paths.statePath, prNumber);
  assertOwnedBySession(state);
  setGhHost(state.host);
  ensureAuthenticated();
  const { pr } = fetchPrData(state);
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
  // rerun`: a commit status or another app may link any URL, and a run id
  // read from it would re-run some unrelated run here.
  const runUrl = `https://${state.host}/${state.owner}/${state.repo}/actions/runs/${runId}/`;
  const failed = checkEvents(pr).failed.filter(
    ({ event, actions }) =>
      actions &&
      event.runId === runId &&
      (event.url ?? '').toLowerCase().startsWith(runUrl.toLowerCase()),
  );
  if (failed.length === 0) {
    throw new Error(
      `run ${runId} is no failed GitHub Actions run of ${state.owner}/${state.repo} on PR #${prNumber}'s head ${pr.headRefOid.slice(0, 12)}.`,
    );
  }
  const checks = failed.map(({ event }) => event.check);
  // Keyed by the check's identity, not its name: two workflows may each
  // have a failed job of the same name, and each has its own re-run.
  const rerunKeys = failed.map(
    ({ identity }) => `${identity}@${pr.headRefOid}`,
  );
  const already = new Set(state.rerunChecks ?? []);
  const repeated = checks.filter((_, index) => already.has(rerunKeys[index]));
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
      deferredRuns: [...new Set([...(state.deferredRuns ?? []), runId])],
    });
    return {
      rerun: false,
      runId,
      checks,
      deferred: true,
      reason: `run ${runId} is still in progress; the gate reports its failures again once it has ended`,
    };
  }
  // `--failed` re-runs every failed job of the run, so every failed check
  // of it spends its re-run. Not retried: a re-run that reached GitHub
  // before a transport error would be asked for twice.
  ghWithInput(
    '',
    'run',
    'rerun',
    String(runId),
    '--failed',
    '-R',
    `${state.owner}/${state.repo}`,
  );
  const attempts = failed.map(({ event, attempt }) =>
    checkAttemptKey(event.check, pr.headRefOid, attempt),
  );
  writeState(paths.statePath, {
    ...state,
    rerunChecks: [...already, ...rerunKeys],
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
      }),
  handler: (argv) => {
    writeStdoutLine(
      JSON.stringify(runRerun(Number(argv['pr']), Number(argv['runId']))),
    );
  },
};
