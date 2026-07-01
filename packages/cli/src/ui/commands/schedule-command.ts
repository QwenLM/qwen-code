/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  deleteScheduledTask,
  humanReadableCron,
  isTaskEnabled,
  listScheduledTasks,
  readState,
  readTask,
  sanitizeTaskId,
  type FireContext,
  type ScheduledTask,
  type TaskRuntimeState,
} from '@qwen-code/qwen-code-core';

import type { SlashCommand, SlashCommandActionReturn } from './types.js';
import { CommandKind } from './types.js';
import { t } from '../../i18n/index.js';

function scheduleLabel(task: ScheduledTask): string {
  if (task.schedule.cron) return humanReadableCron(task.schedule.cron);
  if (task.schedule.fireAt) return `once at ${task.schedule.fireAt}`;
  return 'manual (run only)';
}

function whenLabel(ms: number | null): string {
  return ms ? new Date(ms).toLocaleString() : 'never';
}

function renderTask(task: ScheduledTask, state: TaskRuntimeState): string {
  const status = isTaskEnabled(task, state) ? '●' : '○ paused';
  return [
    `[${task.id}] ${status}  ${scheduleLabel(task)}`,
    `    ${task.description || '(no description)'}`,
    `    cwd: ${task.cwd}  ·  last run: ${whenLabel(state.lastFiredAt)}`,
  ].join('\n');
}

async function renderList(): Promise<string> {
  const tasks = await listScheduledTasks();
  if (tasks.length === 0) {
    return 'No scheduled tasks yet.';
  }
  const blocks: string[] = [];
  for (const task of tasks) {
    blocks.push(renderTask(task, await readState(task.id)));
  }
  return blocks.join('\n\n');
}

function generateRunId(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let id = '';
  for (let i = 0; i < 8; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return id;
}

function nlCreateReturn(request: string): SlashCommandActionReturn {
  return {
    type: 'submit_prompt',
    content:
      `Create a durable scheduled task (routine) from this request: "${request}".\n\n` +
      'Use the schedule_create tool. Steps:\n' +
      '- Infer a sensible schedule: a 5-field cron for recurring requests, or a one-shot ' +
      'fireAt (ISO 8601) for "once/at/in N ..." requests. Prefer off-:00/:30 minutes for ' +
      'approximate times.\n' +
      '- Write a fully self-contained prompt: the task runs headless with NO memory of this ' +
      'conversation, so restate the repo/cwd, goal, and success criteria.\n' +
      '- Default cwd to the current working directory unless the user names another.\n' +
      '- Pick a name (kebab-case) and a one-line description.\n' +
      'Confirm the resolved schedule and details when you create it. Afterwards, remind the ' +
      'user to run `qwen schedule daemon` if it is not already running.',
  };
}

const createCommand: SlashCommand = {
  name: 'create',
  altNames: ['new', 'add'],
  kind: CommandKind.BUILT_IN,
  get description() {
    return t('Create a scheduled task from a natural-language description');
  },
  action: (_context, args): SlashCommandActionReturn => {
    const request = args.trim();
    if (!request) {
      return {
        type: 'message',
        messageType: 'error',
        content:
          'Usage: /schedule create <description>, e.g. `/schedule create review new PRs at 9am on weekdays`',
      };
    }
    return nlCreateReturn(request);
  },
};

const listCommand: SlashCommand = {
  name: 'list',
  kind: CommandKind.BUILT_IN,
  get description() {
    return t('List all scheduled tasks');
  },
  action: async (): Promise<SlashCommandActionReturn> => ({
    type: 'message',
    messageType: 'info',
    content: await renderList(),
  }),
};

const deleteCommand: SlashCommand = {
  name: 'delete',
  altNames: ['remove', 'rm'],
  kind: CommandKind.BUILT_IN,
  get description() {
    return t('Delete a scheduled task by id');
  },
  action: async (_context, args): Promise<SlashCommandActionReturn> => {
    const id = sanitizeTaskId(args.trim());
    if (!id) {
      return {
        type: 'message',
        messageType: 'error',
        content: 'Usage: /schedule delete <task-id>',
      };
    }
    const removed = await deleteScheduledTask(id);
    return {
      type: 'message',
      messageType: removed ? 'info' : 'error',
      content: removed
        ? `Deleted scheduled task "${id}".`
        : `No scheduled task named "${id}".`,
    };
  },
};

const runCommand: SlashCommand = {
  name: 'run',
  kind: CommandKind.BUILT_IN,
  get description() {
    return t('Run a scheduled task once now');
  },
  action: async (_context, args): Promise<SlashCommandActionReturn> => {
    const id = sanitizeTaskId(args.trim());
    if (!id) {
      return {
        type: 'message',
        messageType: 'error',
        content: 'Usage: /schedule run <task-id>',
      };
    }
    const task = await readTask(id);
    if (!task) {
      return {
        type: 'message',
        messageType: 'error',
        content: `No scheduled task named "${id}".`,
      };
    }
    const runId = generateRunId();
    const ctx: FireContext = { task, firedAtMs: Date.now(), runId };
    // Fire-and-forget: the child runs in the background and writes its own
    // run record. Imported lazily so the scheduler stack stays off the hot
    // path for sessions that never touch /schedule.
    void import('../../schedule/run-scheduled-task.js')
      .then(({ runScheduledTask }) => runScheduledTask(ctx))
      .catch(() => {});
    return {
      type: 'message',
      messageType: 'info',
      content: `Started run ${runId} for "${id}" (cwd: ${task.cwd}). Check its runs/ dir for output.`,
    };
  },
};

export const scheduleCommand: SlashCommand = {
  name: 'schedule',
  altNames: ['routines'],
  kind: CommandKind.BUILT_IN,
  get description() {
    return t('Create and manage local scheduled tasks (routines)');
  },
  subCommands: [createCommand, listCommand, runCommand, deleteCommand],
  action: async (_context, args): Promise<SlashCommandActionReturn> => {
    // A bare `/schedule` shows usage; `/schedule <free text>` that isn't a
    // subcommand is treated as a natural-language create request.
    const request = args.trim();
    if (request) {
      return nlCreateReturn(request);
    }
    const usage = [
      'Scheduled tasks (routines) run in the background via `qwen schedule daemon`.',
      '',
      'Subcommands:',
      '  /schedule <description>   Create a task from natural language',
      '  /schedule create <desc>   Same, explicit',
      '  /schedule list            List tasks',
      '  /schedule run <id>        Run a task once now',
      '  /schedule delete <id>     Delete a task',
      '',
      'Current tasks:',
      await renderList(),
    ].join('\n');
    return { type: 'message', messageType: 'info', content: usage };
  },
};
