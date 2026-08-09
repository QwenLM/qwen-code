/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import type { Argv, CommandModule } from 'yargs';
import type {
  AgentViewCoordinationDispatchAck,
  AgentViewCoordinationSnapshot,
} from '../agent-view/protocol.js';
import { writeStdoutLine } from '../utils/stdioHelpers.js';

interface DispatchArgs {
  coordinationId?: string;
  task?: string | string[];
  writer?: string;
  cwd?: string;
  json?: boolean;
}

interface DispatchCommandArgs extends DispatchArgs {
  'coordination-id'?: string;
}

interface CollectArgs {
  coordinationId: string;
  json?: boolean;
}

interface CollectCommandArgs {
  'coordination-id': string;
  json?: boolean;
}

interface ReassignArgs {
  coordinationId: string;
  taskId: string;
  task: string;
  writer?: boolean;
  json?: boolean;
}

interface ReassignCommandArgs {
  'coordination-id': string;
  'task-id': string;
  task: string;
  writer?: boolean;
  json?: boolean;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function getSupervisor() {
  const { ensureAgentViewSupervisor } = await import(
    '../agent-view/supervisor-runner.js'
  );
  return ensureAgentViewSupervisor();
}

export async function handleCoordinationDispatch(
  argv: DispatchArgs,
): Promise<void> {
  const coordinationId = argv.coordinationId ?? randomUUID();
  requireFullId(coordinationId, 'coordination ID');
  const cwd = path.resolve(argv.cwd ?? process.cwd());
  const readOnlyTasks = normalizeStringArray(argv.task).map((taskFile) => ({
    taskFile: path.resolve(taskFile),
    writeMode: 'read-only' as const,
  }));
  const tasks = [
    ...readOnlyTasks,
    ...(argv.writer
      ? [
          {
            taskFile: path.resolve(argv.writer),
            writeMode: 'isolated-writer' as const,
          },
        ]
      : []),
  ];
  if (tasks.length < 1 || tasks.length > 3) {
    throw new Error(
      'Coordination dispatch requires between one and three tasks.',
    );
  }

  let acknowledgements: AgentViewCoordinationDispatchAck[];
  try {
    acknowledgements = await (
      await getSupervisor()
    ).dispatchCoordination({ coordinationId, cwd, tasks });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `${message} Coordination ID: ${coordinationId}. Use agent-view collect to check whether a timed-out dispatch completed.`,
      { cause: error },
    );
  }
  writeCoordinationOutput(
    acknowledgements,
    argv.json === true,
    formatDispatchText,
  );
}

export async function handleCoordinationCollect(
  argv: CollectArgs,
): Promise<void> {
  requireFullId(argv.coordinationId, 'coordination ID');
  const snapshot = await (
    await getSupervisor()
  ).collectCoordination(argv.coordinationId);
  writeCoordinationOutput(snapshot, argv.json === true, formatCollectText);
}

export async function handleCoordinationReassign(
  argv: ReassignArgs,
): Promise<void> {
  requireFullId(argv.coordinationId, 'coordination ID');
  requireFullId(argv.taskId, 'task ID');
  const acknowledgement = await (
    await getSupervisor()
  ).reassignCoordination({
    coordinationId: argv.coordinationId,
    taskId: argv.taskId,
    taskFile: path.resolve(argv.task),
    writeMode: argv.writer ? 'isolated-writer' : 'read-only',
  });
  writeCoordinationOutput(acknowledgement, argv.json === true, (ack) =>
    formatDispatchText([ack]),
  );
}

export const coordinationDispatchCommand: CommandModule<
  unknown,
  DispatchCommandArgs
> = {
  command: 'dispatch',
  describe: 'Dispatch one to three managed Qwen coordination tasks',
  builder: (yargs: Argv) =>
    yargs
      .option('task', {
        type: 'string',
        array: true,
        description: 'Read-only task file (repeat for parallel investigators)',
      })
      .option('writer', {
        type: 'string',
        description: 'Task file for the single isolated writer',
      })
      .option('cwd', {
        type: 'string',
        description: 'Source workspace used for input snapshot validation',
      })
      .option('coordination-id', {
        type: 'string',
        description: 'Full UUID used to recover a timed-out dispatch',
      })
      .option('json', {
        type: 'boolean',
        default: false,
        description: 'Print the exact dispatch acknowledgement as JSON',
      })
      .check((args) => {
        const count =
          normalizeStringArray(args.task).length +
          (typeof args.writer === 'string' ? 1 : 0);
        return count >= 1 && count <= 3
          ? true
          : 'qwen agent-view dispatch requires one to three --task/--writer inputs.';
      })
      .version(false),
  handler: (args) =>
    handleCoordinationDispatch({
      ...args,
      coordinationId: args['coordination-id'],
    }),
};

export const coordinationCollectCommand: CommandModule<
  unknown,
  CollectCommandArgs
> = {
  command: 'collect <coordination-id>',
  describe: 'Collect a managed coordination by its full ID',
  builder: (yargs: Argv) =>
    yargs
      .positional('coordination-id', {
        type: 'string',
        demandOption: true,
        description: 'Full coordination UUID',
      })
      .option('json', {
        type: 'boolean',
        default: false,
        description: 'Print the exact coordination snapshot as JSON',
      })
      .version(false),
  handler: (args) =>
    handleCoordinationCollect({
      coordinationId: args['coordination-id'],
      json: args.json,
    }),
};

export const coordinationReassignCommand: CommandModule<
  unknown,
  ReassignCommandArgs
> = {
  command: 'reassign <coordination-id> <task-id>',
  describe: 'Create a replacement attempt for a handed-back or failed task',
  builder: (yargs: Argv) =>
    yargs
      .positional('coordination-id', {
        type: 'string',
        demandOption: true,
        description: 'Full coordination UUID',
      })
      .positional('task-id', {
        type: 'string',
        demandOption: true,
        description: 'Full task UUID to reassign',
      })
      .option('task', {
        type: 'string',
        demandOption: true,
        description: 'Replacement task file',
      })
      .option('writer', {
        type: 'boolean',
        default: false,
        description: 'Run the replacement as the isolated writer',
      })
      .option('json', {
        type: 'boolean',
        default: false,
        description: 'Print the exact dispatch acknowledgement as JSON',
      })
      .version(false),
  handler: (args) =>
    handleCoordinationReassign({
      coordinationId: args['coordination-id'],
      taskId: args['task-id'],
      task: args.task,
      writer: args.writer,
      json: args.json,
    }),
};

function normalizeStringArray(value: string | string[] | undefined): string[] {
  const values =
    value === undefined ? [] : Array.isArray(value) ? value : [value];
  return values.map((entry) => entry.trim()).filter(Boolean);
}

function requireFullId(value: string, label: string): void {
  if (!UUID_PATTERN.test(value)) {
    throw new Error(`${label} must be a full UUID.`);
  }
}

function writeCoordinationOutput<T>(
  value: T,
  json: boolean,
  formatText: (value: T) => string,
): void {
  writeStdoutLine(json ? JSON.stringify(value) : formatText(value));
}

function formatDispatchText(
  acknowledgements: AgentViewCoordinationDispatchAck[],
): string {
  const coordinationId = acknowledgements[0]?.coordinationId;
  return [
    ...(coordinationId ? [`coordination ${coordinationId}`] : []),
    ...acknowledgements.map(
      (ack) =>
        `task ${ack.taskId} attempt ${ack.attemptId} session ${ack.sessionId} prompt ${ack.promptId} ${ack.writeMode} ${ack.state}`,
    ),
  ].join('\n');
}

function formatCollectText(snapshot: AgentViewCoordinationSnapshot): string {
  const lines = [`coordination ${snapshot.coordinationId} ${snapshot.state}`];
  for (const session of snapshot.sessions) {
    const outcome = session.result?.outcome ?? session.state;
    lines.push(
      `task ${session.lineage.taskId} attempt ${session.lineage.attemptId} ${outcome}${session.staleReason ? ` stale=${session.staleReason}` : ''}`,
    );
    if (session.result?.summary) {
      lines.push(`  ${singleLine(session.result.summary)}`);
    }
    if (session.worktree?.path) {
      const receipt = [
        `worktree=${session.worktree.path}`,
        session.worktree.branch ? `branch=${session.worktree.branch}` : '',
        session.worktree.baseCommit
          ? `base=${session.worktree.baseCommit}`
          : '',
      ]
        .filter(Boolean)
        .join(' ');
      lines.push(`  ${receipt}`);
    }
  }
  return lines.join('\n');
}

function singleLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

export const coordinationCommandFormatting = {
  formatDispatchText,
  formatCollectText,
};
