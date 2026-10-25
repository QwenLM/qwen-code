/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// `qwen autofix-pr schedule`: record a watch's scheduled task in its state
// file and print the task's `cron`, `gate` and `prompt`, so the skill creates
// the task from them as they are, and a later session starts the same task
// again (`/autofix-pr resume`) instead of rebuilding it from the user's
// arguments.

import { existsSync, readFileSync } from 'node:fs';
import type { CommandModule } from 'yargs';
import { writeStdoutLine } from '../../utils/stdioHelpers.js';
import {
  assertOwnedBySession,
  autofixPrPaths,
  repoRoot,
  requireState,
  WATCH_INTERVALS,
  withWatchLock,
  writeState,
  type AutofixPrState,
  type AutofixPrWatchOptions,
} from './state.js';

/** The interval a watch uses when the user gives none (Section 10). */
export const DEFAULT_EVERY = 2;

/** Longest instructions a task's prompt carries. */
export const MAX_INSTRUCTIONS_CHARS = 2000;

// The session id goes into the gate command as it is.
const SESSION_ID_RE = /^[A-Za-z0-9._-]+$/;

export interface ScheduledTask {
  cron: string;
  recurring: true;
  gate: string;
  prompt: string;
}

/**
 * The task a watch runs: the gate names the session that owns the watch, so
 * a task left behind by another session stops at its next fire.
 */
export function scheduledTask(
  state: AutofixPrState,
  watch: AutofixPrWatchOptions,
): ScheduledTask {
  if (!SESSION_ID_RE.test(state.sessionId)) {
    throw new Error(
      state.sessionId === ''
        ? `PR #${state.prNumber} was prepared outside a Qwen Code session; a watch needs one (use --once).`
        : `the session id ${JSON.stringify(state.sessionId)} cannot be named in a command as it is.`,
    );
  }
  const repo = `${state.owner}/${state.repo}`;
  return {
    cron: watch.every === 60 ? '0 * * * *' : `*/${watch.every} * * * *`,
    recurring: true,
    gate:
      `"\${QWEN_CODE_CLI:-qwen}" autofix-pr snapshot ${state.prNumber} --gate ` +
      `--repo ${repo} --host ${state.host} --session ${state.sessionId}`,
    prompt:
      `Run /autofix-pr tick ${repo}#${state.prNumber}` +
      (watch.reply ? '' : ' --no-reply') +
      (watch.instructions ? ` -- ${watch.instructions}` : ''),
  };
}

/** The user's instructions on one line: a task's prompt is one. */
export function readInstructions(path: string): string {
  if (!existsSync(path)) {
    throw new Error(`no instructions file at ${path}`);
  }
  const text = readFileSync(path, 'utf8').replace(/\s+/g, ' ').trim();
  if (text.length > MAX_INSTRUCTIONS_CHARS) {
    throw new Error(
      `the instructions are ${text.length} characters; a watch takes at most ${MAX_INSTRUCTIONS_CHARS}.`,
    );
  }
  return text;
}

export interface ScheduleArgs {
  pr: number;
  every?: number;
  noReply?: boolean;
  /** Read the instructions from the watch's instructions file. */
  instructions?: boolean;
  /** Print the task recorded already, for a session that took the watch over. */
  again?: boolean;
}

export function runSchedule(
  args: ScheduleArgs,
): ScheduledTask & AutofixPrWatchOptions {
  const paths = autofixPrPaths(repoRoot(), args.pr);
  if (
    args.again &&
    (args.every !== undefined || args.noReply || args.instructions)
  ) {
    throw new TypeError(
      '--again prints the task recorded already; it takes no other option.',
    );
  }
  const every = args.every ?? DEFAULT_EVERY;
  if (!WATCH_INTERVALS.includes(every)) {
    throw new TypeError(
      `--every must be one of ${WATCH_INTERVALS.join(', ')} minutes, got ${every}`,
    );
  }
  return withWatchLock(paths, args.pr, () => {
    const state = requireState(paths.statePath, args.pr);
    assertOwnedBySession(state);
    let watch: AutofixPrWatchOptions;
    if (args.again) {
      if (!state.watch) {
        throw new Error(
          `PR #${args.pr} has no scheduled task recorded; start the watch again with /autofix-pr ${args.pr}.`,
        );
      }
      watch = state.watch;
    } else {
      watch = {
        every,
        reply: !args.noReply,
        instructions: args.instructions
          ? readInstructions(paths.instructionsPath)
          : '',
      };
    }
    // Checked before anything is recorded: a task that cannot be made is
    // not one to start again.
    const task = scheduledTask(state, watch);
    if (!args.again) writeState(paths.statePath, { ...state, watch });
    return { ...task, ...watch };
  });
}

export const scheduleCommand: CommandModule = {
  command: 'schedule <pr>',
  describe:
    "Record a watch's scheduled task and print its cron, gate and prompt for cron_create",
  builder: (yargs) =>
    yargs
      .positional('pr', {
        type: 'number',
        demandOption: true,
        describe: 'PR number',
      })
      .option('every', {
        type: 'number',
        describe: `Minutes between checks (${WATCH_INTERVALS.join(', ')}; default ${DEFAULT_EVERY})`,
      })
      .option('reply', {
        type: 'boolean',
        default: true,
        describe:
          'Rounds post their replies; --no-reply records what they handled without posting',
      })
      .option('instructions', {
        type: 'boolean',
        default: false,
        describe:
          "Take the user's instructions for every round from .qwen/tmp/autofix-pr-<pr>-instructions.txt",
      })
      .option('again', {
        type: 'boolean',
        default: false,
        describe: 'Print the task recorded already (after a take-over)',
      }),
  handler: (argv) => {
    writeStdoutLine(
      JSON.stringify(
        runSchedule({
          pr: Number(argv['pr']),
          every:
            argv['every'] === undefined ? undefined : Number(argv['every']),
          noReply: argv['reply'] === false,
          instructions: Boolean(argv['instructions']),
          again: Boolean(argv['again']),
        }),
      ),
    );
  },
};
