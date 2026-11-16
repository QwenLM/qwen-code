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

import { randomBytes } from 'node:crypto';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import type { CommandModule } from 'yargs';
import { writeStdoutLine } from '../../utils/stdioHelpers.js';
import {
  assertWatching,
  autofixPrPaths,
  MAX_INSTRUCTIONS_CHARS,
  resolveWatchRoot,
  requireState,
  WATCH_INTERVALS,
  withWatchLock,
  writeState,
  type AutofixPrState,
  type AutofixPrWatchOptions,
} from './state.js';
import { assertNoFixInFlight } from './fix.js';

/** The interval a watch uses when the user gives none (Section 10). */
export const DEFAULT_EVERY = 2;

// The session id goes into the gate command as it is, and as a value: it
// must not read as an option.
const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export interface ScheduledTask {
  cron: string;
  recurring: true;
  gate: string;
  prompt: string;
  /** A daemon session's watch must outlive the idle reclaim of its session:
   * see `scheduledTask`'s `daemon` argument. */
  durable?: true;
  sessionMode?: 'current';
}

/** `qwen serve` marks every child it spawns, and reclaims an idle session. */
function inDaemonSession(): boolean {
  return process.env['QWEN_CODE_SERVE'] === '1';
}

/**
 * The task a watch runs: the gate names the session that owns the watch, so
 * a task left behind by another session stops at its next fire.
 *
 * `daemon` makes it durable and bound to this conversation. A daemon reclaims
 * a session nobody watches after the idle timeout, taking the in-memory
 * scheduler of a session-only task with it and stopping the watch with no
 * report; a bound durable one keeps the session resident and the Web Shell's
 * scheduled-tasks page lists it. A terminal session has nothing to survive,
 * so it keeps the session-only task.
 */
export function scheduledTask(
  state: AutofixPrState,
  watch: AutofixPrWatchOptions,
  daemon = false,
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
      `--repo ${repo} --host ${state.host} --session ${state.sessionId}` +
      (watch.task ? ` --task ${watch.task}` : ''),
    // The round checks with its first helper that its task still drives
    // the watch: a fire queued before a later schedule is not acted on.
    prompt:
      `Run /autofix-pr tick ${repo}#${state.prNumber}` +
      (watch.task ? ` --task ${watch.task}` : '') +
      (watch.reply ? '' : ' --no-reply') +
      (watch.instructions ? ` -- ${watch.instructions}` : ''),
    ...(daemon
      ? { durable: true as const, sessionMode: 'current' as const }
      : {}),
  };
}

/** The user's instructions on one line: a task's prompt is one. */
export function readInstructions(path: string): string {
  if (!existsSync(path)) {
    throw new Error(`no instructions file at ${path}`);
  }
  // A FIFO planted under the name would block, with the watch's lock held.
  if (!lstatSync(path).isFile()) {
    throw new Error(`${path} is not a regular file`);
  }
  // Format characters (bidi controls, zero-width ones) would make the
  // prompt say other than it shows.
  const text = readFileSync(path, 'utf8')
    .replace(/\p{Cf}/gu, '')
    .replace(/[\s\p{Cc}]+/gu, ' ')
    .trim();
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
  /** Schedule the task recorded already again, for a session that took the
   * watch over: its options, under a new task id. */
  again?: boolean;
}

export function runSchedule(
  args: ScheduleArgs,
): ScheduledTask & AutofixPrWatchOptions {
  const paths = autofixPrPaths(resolveWatchRoot(args.pr), args.pr);
  if (
    args.again &&
    (args.every !== undefined || args.noReply || args.instructions)
  ) {
    throw new TypeError(
      '--again schedules the task recorded already; it takes no other option.',
    );
  }
  const every = args.every ?? DEFAULT_EVERY;
  if (!WATCH_INTERVALS.includes(every)) {
    throw new TypeError(
      `--every must be one of ${WATCH_INTERVALS.join(', ')} minutes, got ${every}`,
    );
  }
  // Read before the lock is taken.
  const instructions = args.instructions
    ? readInstructions(paths.instructionsPath)
    : '';
  return withWatchLock(paths, args.pr, () => {
    const state = requireState(paths.statePath, args.pr);
    // A watch `cleanup` ended is started again by a start, not here.
    assertWatching(state);
    assertNoFixInFlight(paths, args.pr);
    if (state.inPlace) {
      throw new Error(
        `PR #${args.pr} is an in-place watch: its rounds run only when you ask (/autofix-pr ${args.pr} --in-place); there is no scheduled task.`,
      );
    }
    // Running someone else's code with the user's credentials in reach is
    // confirmed for one round at a time (`--once`), never for a watch; a
    // state that does not say the author can push is no permission either.
    if (state.authorCanPush !== true) {
      throw new Error(
        `PR #${args.pr}'s author cannot push to the repository; only --once is available for it.`,
      );
    }
    let options: Omit<AutofixPrWatchOptions, 'task'>;
    if (args.again) {
      if (!state.watch) {
        throw new Error(
          `PR #${args.pr} has no scheduled task recorded; start the watch again with /autofix-pr ${args.pr}.`,
        );
      }
      // Field by field: nothing else the file holds reaches the task.
      options = {
        every: state.watch.every,
        reply: state.watch.reply,
        instructions: state.watch.instructions,
      };
    } else {
      options = {
        every,
        reply: !args.noReply,
        instructions,
      };
    }
    // A new id each time: the task made from this output is the watch's
    // only one, and any other's gate answers stop.
    const watch: AutofixPrWatchOptions = {
      ...options,
      task: randomBytes(6).toString('hex'),
    };
    // Checked before anything is recorded: a task that cannot be made is
    // not one to start again.
    const task = scheduledTask(state, watch, inDaemonSession());
    writeState(paths.statePath, { ...state, watch });
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
        requiresArg: true,
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
        describe:
          'Schedule the task recorded already again, under a new id (after a take-over)',
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
