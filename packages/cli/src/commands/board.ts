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
  blockBoardTask,
  updateBoardTask,
  createAsk,
  listAsks,
  getAsk,
  answerAsk,
  declineAsk,
  raiseDecision,
  listDecisions,
  resolveDecision,
  getBoardSection,
  pruneCollection,
  joinBoard,
  leaveBoard,
  listParticipants,
  type DecisionKind,
} from '@qwen-code/qwen-code-core';
import {
  resolveBoardName,
  resolveParticipantName,
  isInteractiveInvocation,
} from './board/context.js';
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
  process.stdout.write(`${argv.json ? JSON.stringify(value) : human}\n`);
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
    process.stderr.write(
      `${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exitCode = 1;
  }
}

/**
 * yargs `type: 'number'` delivers NaN for non-numeric input without failing,
 * and arithmetic on NaN silently produces wrong behaviour (a NaN prune cutoff
 * deletes everything, a NaN wait deadline never fires). Reject it here so the
 * handler fails with one clear line instead of acting on a poisoned number.
 */
function finiteNumber(value: unknown, flag: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${flag} must be a finite number`);
  }
  return value;
}

/**
 * Narrow a snapshot to one participant. Decisions are deliberately kept: they
 * are the human's, and a participant that hides them cannot tell the user what
 * is blocking the board.
 */
function mine(snap: BoardSnapshot, who: string): BoardSnapshot {
  return {
    ...snap,
    tasks: snap.tasks.filter((t) => t.owner === who),
    asks: snap.asks.filter((a) => a.to === who || a.from === who),
  };
}

async function snapshot(name: string): Promise<BoardSnapshot> {
  const [tasks, asks, decisions, participants] = await Promise.all([
    listBoardTasks(name),
    listAsks(name),
    listDecisions(name),
    listParticipants(name),
  ]);
  return {
    board: name,
    tasks,
    asks,
    decisions,
    participantCount: participants.length,
  };
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
        command: 'who',
        describe: 'List participants currently on the board',
        builder: (y: Argv) =>
          y.option('all', {
            type: 'boolean',
            describe: 'Include records whose process is gone',
          }),
        handler: (argv) =>
          run(async () => {
            const a = argv as CommonArgs & { all?: boolean };
            const people = await listParticipants(board(a), {
              includeStale: a.all,
            });
            emit(
              a,
              people,
              people.length === 0
                ? '(nobody has joined)'
                : people
                    .map((p) => `${p.name}  ${p.kind}  ${p.cwd}`)
                    .join('\n'),
            );
          }),
      })

      .command({
        command: 'join',
        describe: 'Claim a name on the board so peers can address you',
        builder: (y: Argv) =>
          y
            .option('kind', {
              choices: ['interactive', 'daemon', 'spawned', 'foreign'] as const,
              default: 'interactive' as const,
            })
            .option('pid', { type: 'number', hidden: true }),
        handler: (argv) =>
          run(async () => {
            const a = argv as CommonArgs & {
              kind: 'interactive' | 'daemon' | 'spawned' | 'foreign';
              pid?: number;
            };
            const rec = await joinBoard({
              board: board(a),
              name: participant(a),
              kind: a.kind,
              pid: a.pid,
            });
            emit(
              a,
              rec,
              rec.name === participant(a)
                ? `Joined as ${rec.name}.`
                : `Joined as ${rec.name} — "${participant(a)}" was taken.`,
            );
          }),
      })

      .command({
        command: 'leave',
        describe: 'Release your name on the board',
        handler: (argv) =>
          run(async () => {
            const a = argv as CommonArgs;
            const gone = await leaveBoard(board(a), participant(a));
            emit(a, { left: gone }, gone ? 'Left the board.' : 'Not on it.');
          }),
      })

      .command({
        command: 'prune',
        describe: 'Remove settled items older than a cutoff',
        builder: (y: Argv) =>
          y.option('older-than', {
            type: 'number',
            default: 7,
            describe:
              'Days. Only answered, declined, resolved or completed items',
          }),
        handler: (argv) =>
          run(async () => {
            const a = argv as CommonArgs & { olderThan: number };
            const name = board(a);
            const cutoff =
              Math.max(0, finiteNumber(a.olderThan, '--older-than')) *
              86_400_000;
            // Manual by design: nothing here runs on a timer, because deleting
            // a record another participant may be mid-read on is a concurrency
            // problem worth not having.
            const [asks, decisions, tasks] = await Promise.all([
              pruneCollection(
                name,
                'asks',
                /^a-\d+\.json$/,
                (r) => {
                  const rec = r as { state?: string; expiresAt?: number };
                  if (rec.state !== 'open') return true;
                  // `timeout` is computed, never stored: an open ask past its
                  // expiresAt is settled on disk even though state stays 'open'.
                  return (
                    typeof rec.expiresAt === 'number' &&
                    Number.isFinite(rec.expiresAt) &&
                    rec.expiresAt < Date.now()
                  );
                },
                cutoff,
              ),
              pruneCollection(
                name,
                'decisions',
                /^d-\d+\.json$/,
                (r) => (r as { state?: string }).state !== 'open',
                cutoff,
              ),
              pruneCollection(
                name,
                'tasks',
                /^t-\d+\.json$/,
                (r) => (r as { status?: string }).status === 'completed',
                cutoff,
              ),
            ]);
            const total = asks.length + decisions.length + tasks.length;
            emit(
              a,
              { asks, decisions, tasks },
              `Removed ${total} settled item${total === 1 ? '' : 's'}.`,
            );
          }),
      })

      .command({
        command: 'protocol',
        describe:
          'Print instructions to paste into an agent that is not Qwen Code',
        handler: (argv) =>
          run(async () => {
            const a = argv as CommonArgs;
            const name = board(a);
            const who = participant(a);
            // `--with` sets QWEN_BOARD in a pane's environment, but a foreign
            // agent never reads it. Nothing we control can inject into that
            // agent's prompt, so the honest answer is to make the text trivial
            // to hand over rather than pretend the env var is enough.
            process.stdout.write(
              `${getBoardSection({ board: name, as: who }).trim()}\n`,
            );
          }),
      })

      .command({
        command: 'show',
        describe: 'Print the board once',
        builder: (y: Argv) =>
          y.option('mine', {
            type: 'boolean',
            describe: 'Only what is addressed to or owned by this participant',
          }),
        handler: (argv) =>
          run(async () => {
            const a = argv as CommonArgs & { mine?: boolean };
            const name = board(a);
            // Filter before emitting, not just before rendering: --json is the
            // branch a foreign agent uses, so filtering only the human view
            // made the flag a no-op for its actual caller.
            const full = await snapshot(name);
            const snap = a.mine ? mine(full, participant(a)) : full;
            emit(a, snap, renderBoard(snap));
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
              finiteNumber(
                (argv as { interval: number }).interval,
                '--interval',
              ),
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
        command: 'block <id>',
        describe:
          'Record that <id> cannot start until --on <blocker> completes',
        builder: (y: Argv) =>
          y
            .positional('id', { type: 'string', demandOption: true })
            .option('on', { type: 'string', demandOption: true }),
        handler: (argv) =>
          run(async () => {
            const a = argv as CommonArgs & { id: string; on: string };
            await blockBoardTask(board(a), a.id, a.on);
            emit(a, { id: a.id, blockedBy: a.on }, `${a.id} waits on ${a.on}`);
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
              ...(a.ttl !== undefined
                ? { ttlMs: finiteNumber(a.ttl, '--ttl') * 60_000 }
                : {}),
            });
            if (!a.wait) {
              emit(a, ask, `${ask.id} → ${ask.to}`);
              return;
            }
            // Bounded on purpose: a foreign agent running this is blocking its
            // own turn, so an unbounded wait would hang it.
            const deadline =
              Date.now() + finiteNumber(a.timeout, '--timeout') * 1000;
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
                process.stderr.write(
                  `${ask.id} still open after ${a.timeout}s\n`,
                );
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
            .option('force', {
              type: 'boolean',
              describe:
                'Resolve from a non-interactive shell. Documented, and it is ' +
                'how an agent would bypass the guard — use it only in scripts ' +
                'you wrote',
            })
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
              force?: boolean;
            };
            // The one command on this surface that is not for agents.
            if (!a.force && !isInteractiveInvocation()) {
              process.stderr.write(
                `Refusing to resolve ${a.id} from a non-interactive shell.\n` +
                  `A decision needs a person: approval, acceptance and ` +
                  `adjudication are exactly what no agent has the standing to ` +
                  `settle. Run this from your terminal, or pass --force if you ` +
                  `are scripting it yourself.\n`,
              );
              process.exitCode = 1;
              return;
            }
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
