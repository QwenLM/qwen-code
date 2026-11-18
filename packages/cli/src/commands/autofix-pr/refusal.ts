/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// How a helper says no. A refusal carries a code — what happened — and the
// step the skill takes next, so the skill acts on a field instead of on the
// wording of a message. A helper that refuses prints, as the last line on
// stderr, one JSON object:
//
//   {"refused":"busy","next":"retry","message":"another autofix-pr helper…"}
//
// and exits 1. Any other failure (git or gh failing, a file that cannot be
// read) is a refusal too, with the code `failed`.

import { stripVTControlCharacters } from 'node:util';
import type { ArgumentsCamelCase, CommandModule } from 'yargs';
import { writeStderrLine } from '../../utils/stdioHelpers.js';

export const REFUSAL_CODES = [
  /** Another helper of the PR holds the lock: this one did nothing. */
  'busy',
  /** `snapshot` spent a round's eight minutes asking GitHub about bot
   * threads it did not know yet, and kept the answers. */
  'partial',
  /** The PR was merged or closed. */
  'pr_closed',
  /** The PR has no watch in this clone. */
  'not_prepared',
  /** `stop` ended the watch, keeping its worktree. */
  'watch_stopped',
  /** The `--task` given no longer drives the watch. */
  'task_replaced',
  /** Another session owns the watch. */
  'watched_elsewhere',
  /** A fix agent is working in the worktree. */
  'fix_in_flight',
  /** The worktree holds uncommitted changes or another branch. */
  'worktree_dirty',
  /** `ci-log`: the run has no finished job that failed or timed out. */
  'no_failed_job',
  /** `fix-start`: this round's fix cannot run in the background. */
  'no_background_fix',
  /** `rerun`: GitHub refused the re-run, or its answer was lost. */
  'rerun_failed',
  /** `push`: git refused the push (a pre-push hook, the remote). */
  'push_failed',
  /** `reply`: the plan names something the round may not answer. */
  'plan_invalid',
  /** Anything else. */
  'failed',
] as const;

export type RefusalCode = (typeof REFUSAL_CODES)[number];

/**
 * What the skill does next (Section "Refusals" of the skill):
 * - `retry`: run the same call again — `busy` once the other helper has
 *   finished, `partial` up to three times in a round, anything else once;
 * - `stop`: Section "Stop";
 * - `end_task`: delete this task and end the round with one line;
 * - `take_over`: ask whether this session takes the watch over;
 * - `discard`: run `sync <n> --discard` in its place, and go on;
 * - `foreground`: run the fix in the foreground;
 * - `rerun`: treat the run's checks as items with outcome `rerun`;
 * - `needs_human`: the items the call was for are `needs_human`;
 * - `fix_plan`: correct the reply plan and run `reply` again;
 * - `report`: report the message; a start or a round ends there.
 */
export type RefusalNext =
  | 'retry'
  | 'stop'
  | 'end_task'
  | 'take_over'
  | 'discard'
  | 'foreground'
  | 'rerun'
  | 'needs_human'
  | 'fix_plan'
  | 'report';

/** The helpers a round runs with `--task`: a refusal that says the task no
 * longer drives the watch ends that task. */
const ROUND_COMMANDS = new Set([
  'sync',
  'snapshot',
  'ci-log',
  'push',
  'reply',
  'rerun',
]);

export function nextStep(command: string, code: RefusalCode): RefusalNext {
  switch (code) {
    case 'busy':
    case 'partial':
      return 'retry';
    case 'pr_closed':
      // A start has no watch to stop yet.
      return command === 'prepare' ? 'report' : 'stop';
    case 'watched_elsewhere':
      if (command === 'prepare') return 'take_over';
      return ROUND_COMMANDS.has(command) ? 'end_task' : 'report';
    case 'not_prepared':
    case 'watch_stopped':
    case 'task_replaced':
      return ROUND_COMMANDS.has(command) ? 'end_task' : 'report';
    case 'worktree_dirty':
      if (command === 'sync') return 'discard';
      return command === 'push' ? 'needs_human' : 'report';
    case 'no_failed_job':
      return 'rerun';
    case 'no_background_fix':
      return 'foreground';
    case 'rerun_failed':
    case 'push_failed':
      return 'needs_human';
    case 'plan_invalid':
      return 'fix_plan';
    case 'fix_in_flight':
      return 'report';
    case 'failed':
      // Whatever stopped a push or a re-run, nothing was pushed or re-run
      // for sure: its items need a person. A reply that failed is still
      // owed, and its second run skips what the first one posted.
      if (command === 'push' || command === 'rerun') return 'needs_human';
      return command === 'reply' ? 'retry' : 'report';
    default: {
      const unknown: never = code;
      return unknown;
    }
  }
}

export class AutofixPrRefusal extends Error {
  constructor(
    readonly code: RefusalCode,
    message: string,
  ) {
    super(message);
    this.name = 'AutofixPrRefusal';
  }
}

export interface RefusalLine {
  refused: RefusalCode;
  next: RefusalNext;
  message: string;
}

/** The longest message a refusal line carries, as JSON: the tool keeps the
 * last 16 KiB of a helper's stderr, and the line must fit whole. */
export const MAX_REFUSAL_MESSAGE = 8000;

// What a message drops of the text it quotes — a pre-push hook's output is
// the PR's: after escape sequences, whole, the class of the daemon's
// `LOG_LINE_UNSAFE_RE` (C0 and C1 controls, `\r`, bidi overrides,
// invisible formatters) but the tab and the newline, which a message keeps.
/* eslint-disable no-control-regex */
const UNSAFE =
  /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]/g;
/* eslint-enable no-control-regex */

export function refusalOf(command: string, error: unknown): RefusalLine {
  const code = error instanceof AutofixPrRefusal ? error.code : 'failed';
  const whole = stripVTControlCharacters(
    error instanceof Error ? error.message : String(error ?? 'unknown error'),
  ).replace(UNSAFE, '');
  // What failed comes first, and what git or gh said last: both are kept.
  let message = whole;
  for (
    let half = MAX_REFUSAL_MESSAGE / 2;
    JSON.stringify(message).length > MAX_REFUSAL_MESSAGE && half >= 1;
    half = Math.floor(half / 2)
  ) {
    message = `${whole.slice(0, half)} … ${whole.slice(-half)}`;
  }
  return { refused: code, next: nextStep(command, code), message };
}

/**
 * The helper `command` as yargs runs it, its refusals printed as one JSON
 * line on stderr instead of thrown: a thrown error reaches the CLI's
 * "unexpected critical error" handler, which prints its stack.
 */
export function withRefusals(command: CommandModule): CommandModule {
  const name = String(command.command).split(' ')[0];
  return {
    ...command,
    handler: async (argv: ArgumentsCamelCase) => {
      try {
        await command.handler(argv);
      } catch (error) {
        // A defect rather than a refusal keeps where it happened: its
        // frames go first, so the coded line stays the last.
        if (!(error instanceof AutofixPrRefusal) && error instanceof Error) {
          const frames = (error.stack ?? '')
            .split('\n')
            .filter((line) => /^\s+at /.test(line));
          if (frames.length > 0) writeStderrLine(frames.join('\n'));
        }
        writeStderrLine(JSON.stringify(refusalOf(name, error)));
        process.exitCode = 1;
      }
    },
  };
}
