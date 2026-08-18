/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `qwen board` — the command surface over a shared work board.
 *
 * This is the contract, not a convenience wrapper. Nothing can push into a
 * process it did not launch and whose stdin it does not hold, so a foreign
 * agent can never be a delivery target — but it can run a command. Fetching is
 * therefore the one verb available to every participant, and a capability
 * reachable only through Qwen's in-process tools does not exist for anything
 * else.
 *
 * The verbs are flat rather than nested under a noun (`board claim t-3`, not
 * `board task claim t-3`) because the id prefix already carries the noun:
 * `t-` task, `a-` ask, `d-` decision. Two levels instead of three matters for
 * a surface an agent types on every turn.
 */

import type { CommandModule, Argv } from 'yargs';
import {
  createBoardTask,
  listBoardTasks,
  claimBoardTask,
  updateBoardTask,
  createAsk,
  listAsks,
  getAsk,
  answerAsk,
  declineAsk,
  raiseDecision,
  listDecisions,
  resolveDecision,
  type DecisionKind,
} from '@qwen-code/qwen-code-core';
import { resolveBoardName, resolveParticipantName } from './board/context.js';
import { renderBoard, type BoardSnapshot } from './board/render.js';

interface CommonArgs {
  board?: string;
  as?: string;
  json?: boolean;
}

function board(argv: CommonArgs): string {
  return resolveBoardName({ board: argv.board });
}

function participant(argv: CommonArgs): string {
  return resolveParticipantName({ as: argv.as });
}

function emit(argv: CommonArgs, value: unknown, human: string): void {
  if (argv.json) {
    console.log(JSON.stringify(value));
  } else {
    console.log(human);
  }
}

/**
 * Board commands run outside a session and must never take the process down on
 * a foreseeable condition — a missing board, a settled item, a claimed task.
 * A non-zero exit with one line on stderr lets a caller branch; a stack trace
 * would land in the middle of an agent's turn.
 */
async function run(fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}

async function snapshot(name: string): Promise<BoardSnapshot> {
  const [tasks, asks, decisions] = await Promise.all([
    listBoardTasks(name),
    listAsks(name),
    listDecisions(name),
  ]);
  return { board: name, tasks, asks, decisions };
}

export const boardCommand: CommandModule = {
  command: 'board',
  describe: 'Share work with other agents through a board',
  builder: (yargs: Argv) =>
    yargs
      .option('board', {
        type: 'string',
        describe: 'Board name (default: derived from the project directory)',
      })
      .option('as', {
        type: 'string',
        describe: 'Participant name to act as',
      })
      .option('json', { type: 'boolean', describe: 'Emit JSON' })

      .command({
        command: 'show',
        describe: 'Print the board once',
        handler: (argv) =>
          run(async () => {
            const name = board(argv as CommonArgs);
            const snap = await snapshot(name);
            emit(argv as CommonArgs, snap, renderBoard(snap));
          }),
      })

      .command({
        command: 'watch',
        describe: 'Follow the board until interrupted',
        builder: (y: Argv) =>
          y.option('interval', {
            type: 'number',
            default: 2000,
            describe: 'Poll interval in ms',
          }),
        handler: (argv) =>
          run(async () => {
            const name = board(argv as CommonArgs);
            const interval = Math.max(
              250,
              (argv as { interval: number }).interval,
            );
            let stop = false;
            process.on('SIGINT', () => {
              stop = true;
            });
            // Poll rather than watch the directory: fs.watch behaves
            // differently across platforms and network filesystems, and a
            // directory this small is not the bottleneck.
            while (!stop) {
              const snap = await snapshot(name);
              process.stdout.write('\x1b[2J\x1b[H');
              process.stdout.write(renderBoard(snap) + '\n');
              await new Promise((r) => setTimeout(r, interval));
            }
          }),
      })

      .command({
        command: 'task <subject>',
        describe: 'Create a task',
        builder: (y: Argv) =>
          y
            .positional('subject', { type: 'string', demandOption: true })
            .option('owner', {
              type: 'string',
              describe:
                'Name an expected owner — a proposal, not an assignment',
            }),
        handler: (argv) =>
          run(async () => {
            const a = argv as CommonArgs & { subject: string; owner?: string };
            const task = await createBoardTask({
              board: board(a),
              subject: a.subject,
              owner: a.owner,
            });
            emit(a, task, `${task.id}  ${task.subject}`);
          }),
      })

      .command({
        command: 'claim <id>',
        describe: 'Take ownership of a task',
        builder: (y: Argv) =>
          y.positional('id', { type: 'string', demandOption: true }),
        handler: (argv) =>
          run(async () => {
            const a = argv as CommonArgs & { id: string };
            const task = await claimBoardTask(board(a), a.id, participant(a));
            emit(a, task, `${task.id} claimed by ${task.owner}`);
          }),
      })

      .command({
        command: 'done <id>',
        describe: 'Mark a task completed',
        builder: (y: Argv) =>
          y
            .positional('id', { type: 'string', demandOption: true })
            .option('note', { type: 'string' }),
        handler: (argv) =>
          run(async () => {
            const a = argv as CommonArgs & { id: string; note?: string };
            const task = await updateBoardTask(board(a), a.id, {
              status: 'completed',
              note: a.note,
              by: participant(a),
            });
            emit(a, task, `${task.id} done`);
          }),
      })

      .command({
        command: 'ask <to> <question>',
        describe: 'Ask a participant a question',
        builder: (y: Argv) =>
          y
            .positional('to', { type: 'string', demandOption: true })
            .positional('question', { type: 'string', demandOption: true })
            .option('about', { type: 'string', describe: 'Related task id' })
            .option('wait', {
              type: 'boolean',
              describe: 'Block until the ask settles',
            })
            .option('timeout', {
              type: 'number',
              default: 30,
              describe: 'Seconds to block when --wait is set',
            })
            .option('ttl', {
              type: 'number',
              describe:
                'Minutes before the ask lapses to timeout. Raise it when the ' +
                'recipient only looks between long turns',
            }),
        handler: (argv) =>
          run(async () => {
            const a = argv as CommonArgs & {
              to: string;
              question: string;
              about?: string;
              wait?: boolean;
              timeout: number;
              ttl?: number;
            };
            const name = board(a);
            const ask = await createAsk({
              board: name,
              from: participant(a),
              to: a.to,
              question: a.question,
              aboutTask: a.about,
              ...(a.ttl ? { ttlMs: a.ttl * 60_000 } : {}),
            });
            if (!a.wait) {
              emit(a, ask, `${ask.id} → ${ask.to}`);
              return;
            }
            // Bounded on purpose: a foreign agent running this is blocking its
            // own turn, so an unbounded wait would hang it.
            const deadline = Date.now() + a.timeout * 1000;
            for (;;) {
              // Read the one item rather than listing the board: this runs
              // every 500ms and a board with many asks would pay a readdir
              // plus a read per item on every tick.
              const current = await getAsk(name, ask.id);
              if (current && current.state !== 'open') {
                emit(
                  a,
                  current,
                  current.state === 'answered'
                    ? (current.answer ?? '')
                    : `${current.state}: ${current.reason ?? ''}`,
                );
                if (current.state !== 'answered') process.exitCode = 2;
                return;
              }
              if (Date.now() >= deadline) {
                console.error(`${ask.id} still open after ${a.timeout}s`);
                process.exitCode = 3;
                return;
              }
              await new Promise((r) => setTimeout(r, 500));
            }
          }),
      })

      .command({
        command: 'answer <id> <answer>',
        describe: 'Answer an ask addressed to you',
        builder: (y: Argv) =>
          y
            .positional('id', { type: 'string', demandOption: true })
            .positional('answer', { type: 'string', demandOption: true }),
        handler: (argv) =>
          run(async () => {
            const a = argv as CommonArgs & { id: string; answer: string };
            const ask = await answerAsk(board(a), a.id, a.answer);
            emit(a, ask, `${ask.id} answered`);
          }),
      })

      .command({
        command: 'decline <id> <reason>',
        describe: 'Decline an ask addressed to you',
        builder: (y: Argv) =>
          y
            .positional('id', { type: 'string', demandOption: true })
            .positional('reason', { type: 'string', demandOption: true }),
        handler: (argv) =>
          run(async () => {
            const a = argv as CommonArgs & { id: string; reason: string };
            const ask = await declineAsk(board(a), a.id, a.reason);
            emit(a, ask, `${ask.id} declined`);
          }),
      })

      .command({
        command: 'raise <question>',
        describe: 'Raise something for a human to decide',
        builder: (y: Argv) =>
          y
            .positional('question', { type: 'string', demandOption: true })
            .option('kind', {
              choices: ['approval', 'acceptance', 'adjudication'] as const,
              default: 'approval' as const,
            })
            .option('about', { type: 'string', describe: 'Related task id' }),
        handler: (argv) =>
          run(async () => {
            const a = argv as CommonArgs & {
              question: string;
              kind: DecisionKind;
              about?: string;
            };
            const decision = await raiseDecision({
              board: board(a),
              kind: a.kind,
              raisedBy: participant(a),
              question: a.question,
              about: a.about,
            });
            emit(a, decision, `${decision.id} awaiting a decision`);
          }),
      })

      .command({
        command: 'resolve <id>',
        describe: 'Resolve a decision (human only)',
        builder: (y: Argv) =>
          y
            .positional('id', { type: 'string', demandOption: true })
            .option('approve', { type: 'boolean' })
            .option('reject', { type: 'boolean' })
            .option('note', { type: 'string' })
            .check((a) => {
              if (!a['approve'] && !a['reject']) {
                throw new Error('Pass --approve or --reject.');
              }
              if (a['approve'] && a['reject']) {
                throw new Error('Pass only one of --approve or --reject.');
              }
              return true;
            }),
        handler: (argv) =>
          run(async () => {
            const a = argv as CommonArgs & {
              id: string;
              approve?: boolean;
              note?: string;
            };
            const decision = await resolveDecision(
              board(a),
              a.id,
              a.approve ? 'approved' : 'rejected',
              a.note,
            );
            emit(a, decision, `${decision.id} ${decision.state}`);
          }),
      })

      .demandCommand(1, 'You need at least one command before continuing.')
      .version(false),
  handler: () => {},
};
