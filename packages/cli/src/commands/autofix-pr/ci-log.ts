/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// `qwen autofix-pr ci-log`: save the tail of each failed job's log to a file
// the fix agent reads, instead of a log large enough to be cut down to a
// preview in the shell tool's output.

import type { CommandModule } from 'yargs';
import { atomicWriteFileSync } from '@qwen-code/qwen-code-core/utils/atomicFileWrite.js';
import { join } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { writeStdoutLine } from '../../utils/stdioHelpers.js';
import { ensureAuthenticated, gh, setGhHost } from '../review/lib/gh.js';
import {
  assertWatching,
  NO_FOLLOW,
  TASK_OPTION,
  taskArg,
  assertPositiveInteger,
  autofixPrPaths,
  resolveWatchRoot,
  requireState,
} from './state.js';
import { assertNoFixInFlight } from './fix.js';

const FAILED_JOB_CONCLUSIONS = new Set(['failure', 'timed_out']);

/**
 * The lines the log file keeps of one job's log: its last `limit` lines up
 * to its last `##[error]` line, each prefixed with the job's name. A job's
 * log runs on through the post-job cleanup steps; the failure is at the end
 * of the step that failed.
 */
export function tailJob(name: string, log: string, limit: number): string[] {
  const parts: string[] = [];
  let lines = log.split('\n').filter((line) => line !== '');
  const lastError = lines.findLastIndex((line) => line.includes('##[error]'));
  const later = lastError === -1 ? 0 : lines.length - lastError - 1;
  if (later > 0) lines = lines.slice(0, lastError + 1);
  const dropped = lines.length - limit;
  if (dropped > 0) parts.push(`${name}\t… ${dropped} earlier lines omitted`);
  // One push per line: spreading a long tail into `push` overflows the
  // argument limit (about 110k lines).
  for (const line of lines.slice(-limit)) parts.push(`${name}\t${line}`);
  if (later > 0) parts.push(`${name}\t… ${later} later lines omitted`);
  return parts;
}

/**
 * One job's log. `gh run view --log-failed` (and `--job`) refuses any run
 * still in progress, while `snapshot` reports a failed job as soon as it
 * fails; the REST endpoint serves a finished job's log either way.
 */
function jobLog(repo: string, jobId: number): string {
  const path = `repos/${repo}/actions/jobs/${jobId}/logs`;
  let log: string;
  try {
    // Newer gh refuses to print a response with terminal escape sequences
    // without this flag; older gh has neither the check nor the flag.
    log = gh('api', '--allow-escape-sequences', path);
  } catch (err) {
    if (
      !String((err as { stderr?: unknown }).stderr).includes('unknown flag')
    ) {
      throw err;
    }
    log = gh('api', path);
  }
  return stripVTControlCharacters(log);
}

/** How long `ci-log` spends downloading, inside the shell tool's ten
 * minutes: the jobs left after it are listed, their logs not read. */
const CI_LOG_BUDGET_MS = 8 * 60_000;

export function runCiLog(
  prNumber: number,
  runId: number,
  limit: number,
  task?: string,
): void {
  // `slice(-0)` and `slice(NaN)` both keep the whole log.
  assertPositiveInteger(limit, '--lines');
  assertPositiveInteger(runId, 'run id');
  const root = resolveWatchRoot(prNumber);
  const paths = autofixPrPaths(root, prNumber);
  const state = requireState(paths.statePath, prNumber);
  assertWatching(state, task);
  assertNoFixInFlight(paths, prNumber);
  setGhHost(state.host);
  ensureAuthenticated();
  // From the start: listing the jobs of a large run takes its time too.
  const deadline = Date.now() + CI_LOG_BUDGET_MS;
  const repo = `${state.owner}/${state.repo}`;
  // Only finished failures: a job still running may yet pass, and its log is
  // not complete.
  const failed = gh(
    'api',
    '--paginate',
    // Pages of 30, gh's own: GitHub answers a page of 100 jobs of a large
    // re-run run with a 502 after ten seconds, every time.
    `repos/${repo}/actions/runs/${runId}/jobs?per_page=30`,
    '--jq',
    '.jobs[] | select(.status == "completed") | {id, name, conclusion}',
  )
    .split('\n')
    .filter((line) => line !== '')
    .map(
      (line) =>
        JSON.parse(line) as { id: number; name: string; conclusion: string },
    )
    .filter((job) => FAILED_JOB_CONCLUSIONS.has(job.conclusion));
  if (failed.length === 0) {
    // An empty file would read as "the log says nothing".
    throw new Error(
      `run ${runId} has no finished job that failed or timed out: its failed jobs are still running, or it failed before any job started.`,
    );
  }
  // Each log is cut to the lines kept as soon as it arrives: a run's many
  // large logs are not all held at once.
  const parts: string[] = [];
  for (const job of failed) {
    let log: string;
    if (Date.now() > deadline) {
      log = 'log unavailable: ci-log ran out of time; the jobs above were read';
    } else {
      // One log that cannot be read must not cost the others.
      try {
        log = jobLog(repo, job.id);
      } catch (err) {
        const reason = String(
          (err as { stderr?: unknown }).stderr || (err as Error).message,
        )
          .trim()
          .split('\n')[0];
        log = `log unavailable: ${reason}`;
      }
    }
    for (const line of tailJob(job.name, log, limit)) parts.push(line);
  }
  const text = `${parts.join('\n')}\n`;
  const jobs = failed.map((job) => job.name);
  const path = join(
    root,
    '.qwen',
    'tmp',
    `autofix-pr-${prNumber}-ci-${runId}.log`,
  );
  atomicWriteFileSync(path, text, NO_FOLLOW);
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
      })
      .option('task', TASK_OPTION),
  handler: (argv) => {
    runCiLog(
      Number(argv['pr']),
      Number(argv['run-id']),
      Number(argv['lines']),
      taskArg(argv),
    );
  },
};
