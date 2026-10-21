/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// `qwen autofix-pr ci-log`: save the tail of each failed job's log to a file
// the fix agent reads, instead of a log large enough to be cut down to a
// preview in the shell tool's output.

import type { CommandModule } from 'yargs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeStdoutLine } from '../../utils/stdioHelpers.js';
import { ensureAuthenticated, gh, setGhHost } from '../review/lib/gh.js';
import {
  assertOwnedBySession,
  autofixPrPaths,
  repoRoot,
  requireState,
} from './state.js';

/**
 * Keep the last `limit` lines of every job. `gh run view --log-failed`
 * prints `<job>\t<step>\t<line>`; the failure is almost always at the end.
 */
export function tailPerJob(
  log: string,
  limit: number,
): { text: string; jobs: string[] } {
  const byJob = new Map<string, string[]>();
  for (const line of log.split('\n')) {
    if (line === '') continue;
    const job = line.slice(0, Math.max(line.indexOf('\t'), 0));
    const lines = byJob.get(job) ?? [];
    lines.push(line);
    byJob.set(job, lines);
  }
  const parts: string[] = [];
  for (const [job, lines] of byJob) {
    const dropped = lines.length - limit;
    if (dropped > 0) parts.push(`${job}\t… ${dropped} earlier lines omitted`);
    parts.push(...lines.slice(-limit));
  }
  return { text: `${parts.join('\n')}\n`, jobs: [...byJob.keys()] };
}

export function runCiLog(prNumber: number, runId: number, limit: number): void {
  // `slice(-0)` and `slice(NaN)` both keep the whole log.
  if (!Number.isInteger(limit) || limit < 1) {
    throw new TypeError(`--lines must be a positive integer, got ${limit}`);
  }
  const root = repoRoot();
  const paths = autofixPrPaths(root, prNumber);
  const state = requireState(paths.statePath, prNumber);
  assertOwnedBySession(state);
  setGhHost(state.host);
  ensureAuthenticated();
  const log = gh(
    'run',
    'view',
    String(runId),
    '-R',
    `${state.owner}/${state.repo}`,
    '--log-failed',
  );
  const { text, jobs } = tailPerJob(log, limit);
  const path = join(
    root,
    '.qwen',
    'tmp',
    `autofix-pr-${prNumber}-ci-${runId}.log`,
  );
  writeFileSync(path, text);
  writeStdoutLine(JSON.stringify({ path, jobs }));
}

export const ciLogCommand: CommandModule = {
  command: 'ci-log <pr> <run-id>',
  describe:
    "Save the tail of a GitHub Actions run's failed job logs to a file and print its path",
  builder: (yargs) =>
    yargs
      .positional('pr', {
        type: 'number',
        demandOption: true,
        describe: 'PR number prepared with `qwen autofix-pr prepare`',
      })
      .positional('run-id', {
        type: 'number',
        demandOption: true,
        describe: 'Workflow run id (the `runId` of a `ci_failed` event)',
      })
      .option('lines', {
        type: 'number',
        default: 200,
        describe: 'Lines to keep from the end of each failed job',
      }),
  handler: (argv) => {
    runCiLog(Number(argv['pr']), Number(argv['run-id']), Number(argv['lines']));
  },
};
