/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Argv, CommandModule } from 'yargs';
import {
  answerAsk,
  claimBoardTask,
  completeBoardTask,
  createAsk,
  createBoardTask,
  declineAsk,
  getAsk,
  listAsks,
  listBoardTasks,
  pruneAsks,
  pruneBoardTasks,
} from '@qwen-code/qwen-code-core/board';
import { sanitizeTerminalText } from '../ui/utils/textUtils.js';
import { requireActorName, requireBoardName } from './board/context.js';
import { oneLine, renderBoard, type BoardSnapshot } from './board/render.js';

interface CommonArgs {
  board?: string;
  as?: string;
  json?: boolean;
}

async function emit(
  argv: CommonArgs,
  value: unknown,
  human: string,
): Promise<void> {
  // Sanitize without flattening: the `show` panel and `ask --wait` answers
  // are genuinely multi-line, and `sanitizeTerminalText` keeps LF/TAB while
  // neutralizing dangerous control sequences.
  const text = `${argv.json ? JSON.stringify(value) : sanitizeTerminalText(human)}\n`;
  // `parseArguments` calls `process.exit` as soon as this handler resolves. A
  // write to a pipe is asynchronous, so resolving before stdout has drained
  // truncates output larger than the pipe buffer while still exiting 0.
  //
  // A reader that closes early (`... | head`) reports that twice: once to the
  // write callback and once as a stream `error` event. The listener keeps the
  // second one from surfacing as an uncaught exception, and the callback
  // decides the outcome — a closed reader ends the pipeline normally, while
  // any other write failure still has to reach the caller.
  if (process.stdout.listenerCount('error') === 0) {
    process.stdout.on('error', () => {});
  }
  await new Promise<void>((resolve, reject) => {
    process.stdout.write(text, (err) => {
      if (err && (err as NodeJS.ErrnoException).code !== 'EPIPE') reject(err);
      else resolve();
    });
  });
}

async function run(fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    process.stderr.write(
      `${oneLine(err instanceof Error ? err.message : String(err))}\n`,
    );
    process.exitCode = 1;
  }
}

function finiteNumber(value: unknown, flag: string, minimum: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum) {
    throw new Error(`${flag} must be a finite number >= ${minimum}.`);
  }
  return value;
}

async function snapshot(board: string, actor?: string): Promise<BoardSnapshot> {
  const [tasks, asks] = await Promise.all([
    listBoardTasks(board),
    listAsks(board),
  ]);
  return {
    board,
    tasks: actor ? tasks.filter((task) => task.owner === actor) : tasks,
    asks: actor
      ? asks.filter((ask) => ask.from === actor || ask.to === actor)
      : asks,
  };
}

export const boardCommand: CommandModule = {
  command: 'board',
  describe: 'Share work with other agents through a board',
  builder: (yargs: Argv) =>
    yargs
      .option('board', {
        type: 'string',
        describe: 'Board name',
      })
      .option('as', {
        type: 'string',
        describe: 'Declared actor name',
      })
      .option('json', { type: 'boolean', describe: 'Emit JSON' })

      .command({
        command: 'show',
        describe: 'Print the board once',
        handler: (argv) =>
          run(async () => {
            const a = argv as CommonArgs;
            const board = requireBoardName(a.board);
            const actor =
              a.as === undefined ? undefined : requireActorName(a.as);
            const state = await snapshot(board, actor);
            await emit(a, state, renderBoard(state));
          }),
      })

      .command({
        command: 'task <subject>',
        describe: 'Create a task',
        builder: (y: Argv) =>
          y
            .positional('subject', { type: 'string', demandOption: true })
            .option('owner', { type: 'string' }),
        handler: (argv) =>
          run(async () => {
            const a = argv as CommonArgs & { subject: string; owner?: string };
            const task = await createBoardTask({
              board: requireBoardName(a.board),
              createdBy: requireActorName(a.as),
              subject: a.subject,
              owner: a.owner,
            });
            await emit(a, task, `${task.id} ${task.subject}`);
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
            const task = await claimBoardTask(
              requireBoardName(a.board),
              a.id,
              requireActorName(a.as),
            );
            await emit(a, task, `${task.id} claimed by ${task.owner}`);
          }),
      })

      .command({
        command: 'done <id>',
        describe: 'Complete a task you own',
        builder: (y: Argv) =>
          y
            .positional('id', { type: 'string', demandOption: true })
            .option('note', { type: 'string' }),
        handler: (argv) =>
          run(async () => {
            const a = argv as CommonArgs & { id: string; note?: string };
            const task = await completeBoardTask(
              requireBoardName(a.board),
              a.id,
              requireActorName(a.as),
              a.note,
            );
            await emit(a, task, `${task.id} completed`);
          }),
      })

      .command({
        command: 'ask <to> <question>',
        describe: 'Ask another actor a question',
        builder: (y: Argv) =>
          y
            .positional('to', { type: 'string', demandOption: true })
            .positional('question', { type: 'string', demandOption: true })
            .option('about', { type: 'string' })
            .option('wait', { type: 'boolean' })
            .option('timeout', { type: 'number', default: 30 })
            .option('ttl', { type: 'number', default: 900 }),
        handler: (argv) =>
          run(async () => {
            const a = argv as CommonArgs & {
              to: string;
              question: string;
              about?: string;
              wait?: boolean;
              timeout: number;
              ttl: number;
            };
            const board = requireBoardName(a.board);
            // Validate the local wait before creating the ask: a rejected
            // `--timeout` must not leave an orphaned open ask on the board.
            const waitMs = a.wait
              ? finiteNumber(a.timeout * 1000, '--timeout', 0)
              : 0;
            const ask = await createAsk({
              board,
              from: requireActorName(a.as),
              to: a.to,
              question: a.question,
              aboutTask: a.about,
              ttlMs: finiteNumber(a.ttl, '--ttl', 0.001) * 1000,
            });
            if (!a.wait) {
              await emit(a, ask, `${ask.id} -> ${ask.to}`);
              return;
            }

            const deadline = Date.now() + waitMs;
            for (;;) {
              const current = await getAsk(board, ask.id);
              if (!current) throw new Error(`Ask "${ask.id}" not found.`);
              if (current.state !== 'open') {
                await emit(
                  a,
                  current,
                  current.state === 'answered'
                    ? (current.answer ?? '')
                    : current.state,
                );
                if (current.state === 'declined') process.exitCode = 2;
                if (current.state === 'timeout') process.exitCode = 3;
                return;
              }
              if (Date.now() >= deadline) {
                process.stderr.write(`${ask.id} is still open.\n`);
                process.exitCode = 4;
                return;
              }
              await new Promise((resolve) => setTimeout(resolve, 250));
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
            const ask = await answerAsk(
              requireBoardName(a.board),
              a.id,
              requireActorName(a.as),
              a.answer,
            );
            await emit(a, ask, `${ask.id} answered`);
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
            const ask = await declineAsk(
              requireBoardName(a.board),
              a.id,
              requireActorName(a.as),
              a.reason,
            );
            await emit(a, ask, `${ask.id} declined`);
          }),
      })

      .command({
        command: 'prune',
        describe: 'Remove settled items older than a cutoff',
        builder: (y: Argv) =>
          y.option('older-than', { type: 'number', default: 7 }),
        handler: (argv) =>
          run(async () => {
            const a = argv as CommonArgs & { olderThan: number };
            requireActorName(a.as);
            const board = requireBoardName(a.board);
            const cutoff =
              finiteNumber(a.olderThan, '--older-than', 0) * 86_400_000;
            const [asks, tasks] = await Promise.all([
              pruneAsks(board, cutoff),
              pruneBoardTasks(board, cutoff),
            ]);
            const removed = { asks, tasks };
            const total = asks.length + tasks.length;
            await emit(a, removed, `Removed ${total} settled items.`);
          }),
      })

      .demandCommand(1, 'You need at least one board command.')
      .version(false),
  handler: () => {},
};
