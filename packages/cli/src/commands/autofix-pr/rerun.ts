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
  writeState,
} from './state.js';

export interface RerunOutcome {
  rerun: boolean;
  runId: number;
  checks: string[];
  action?: 'resync';
  reason?: string;
}

export function runRerun(prNumber: number, runId: number): RerunOutcome {
  assertPositiveInteger(runId, 'run id');
  const paths = autofixPrPaths(repoRoot(), prNumber);
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
  const failed = checkEvents(pr).failed.filter(
    ({ event }) => event.runId === runId,
  );
  if (failed.length === 0) {
    throw new Error(
      `run ${runId} has no failed check on PR #${prNumber}'s head ${pr.headRefOid.slice(0, 12)}.`,
    );
  }
  const checks = failed.map(({ event }) => event.check);
  const rerunKeys = checks.map((check) => `${check}@${pr.headRefOid}`);
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
