/**
 * /schedule slash command — manage scheduled tasks from interactive TUI.
 */

import type {
  SlashCommand,
  CommandContext,
  MessageActionReturn,
} from './types.js';
import { CommandKind } from './types.js';
import {
  listScheduleTasks,
  formatScheduleTaskSummary,
  deleteScheduleTask,
  updateScheduleTask,
  readScheduleTask,
  getScheduleRunRecords,
  type ScheduleTask,
} from '@qwen-code/qwen-code-core';

function taskToMessage(task: ScheduleTask): string {
  return formatScheduleTaskSummary(task);
}

export const scheduleCommand: SlashCommand = {
  name: 'schedule',
  description: 'Manage scheduled tasks and the always-on daemon',
  kind: CommandKind.BUILT_IN,
  argumentHint:
    '[list|daemon status|daemon start|daemon stop|delete <id>|update <id> <field> <value>|run <id>|logs <id>]',
  supportedModes: ['interactive', 'non_interactive'],
  action: async (
    context: CommandContext,
    actionArgs: string,
  ): Promise<MessageActionReturn> => {
    const args = (context.invocation?.args?.trim() || actionArgs.trim()).trim();

    // /schedule list
    if (args === 'list' || args === '') {
      const tasks = await listScheduleTasks();
      if (tasks.length === 0) {
        return {
          type: 'message',
          messageType: 'info',
          content:
            'No scheduled tasks. Use `/schedule create` (coming soon) or `qwen schedule create --name ... --cron ... --prompt ...` from the shell.',
        };
      }
      return {
        type: 'message',
        messageType: 'info',
        content: tasks.map(taskToMessage).join('\n\n'),
      };
    }

    // /schedule daemon status
    if (args === 'daemon status') {
      const pidFile = await tryReadPidStatus();
      return {
        type: 'message',
        messageType: 'info',
        content: pidFile,
      };
    }

    // /schedule daemon start
    if (args === 'daemon start') {
      return {
        type: 'message',
        messageType: 'info',
        content:
          'Start the daemon from the shell: `qwen schedule daemon start`',
      };
    }

    // /schedule daemon stop
    if (args === 'daemon stop') {
      return {
        type: 'message',
        messageType: 'info',
        content: 'Stop the daemon from the shell: `qwen schedule daemon stop`',
      };
    }

    // /schedule delete <id>
    if (args.startsWith('delete ')) {
      const taskId = args.slice('delete '.length).trim();
      if (!taskId) {
        return {
          type: 'message',
          messageType: 'error',
          content: 'Usage: /schedule delete <taskId>',
        };
      }
      const ok = await deleteScheduleTask(taskId);
      if (ok) {
        const { isDaemonRunning, sendDaemonCommand } = await import(
          '../../schedule/run-schedule-daemon.js'
        );
        if (await isDaemonRunning()) {
          try {
            await sendDaemonCommand('unload', taskId);
          } catch {
            // best-effort
          }
        }
      }
      return {
        type: 'message',
        messageType: ok ? 'info' : 'error',
        content: ok ? `Task ${taskId} deleted.` : `Task ${taskId} not found.`,
      };
    }

    // /schedule update <id> <field> <value>
    if (args.startsWith('update ')) {
      const rest = args.slice('update '.length).trim();
      const parts = rest.split(/\s+/);
      if (parts.length < 3) {
        return {
          type: 'message',
          messageType: 'error',
          content: 'Usage: /schedule update <taskId> <field> <value>',
        };
      }
      const taskId = parts[0];
      const field = parts[1];
      const value = parts.slice(2).join(' ');

      const updates: Record<string, unknown> = {};
      if (field === 'name') updates['name'] = value;
      else if (field === 'cron') updates['cron'] = value;
      else if (field === 'prompt') updates['prompt'] = value;
      else if (field === 'cwd') updates['cwd'] = value;
      else if (field === 'description') updates['description'] = value;
      else if (field === 'model') updates['model'] = value;
      else if (field === 'approvalMode') updates['approvalMode'] = value;
      else if (field === 'enable') updates['enabled'] = value === 'true';
      else if (field === 'disable') updates['enabled'] = value !== 'true';
      else if (field === 'sandbox') updates['sandbox'] = value === 'true';
      else {
        return {
          type: 'message',
          messageType: 'error',
          content: `Unknown field: ${field}. Valid fields: name, cron, prompt, cwd, description, model, approvalMode, enable, disable, sandbox`,
        };
      }

      try {
        const task = await updateScheduleTask(taskId, updates);
        if (!task) {
          return {
            type: 'message',
            messageType: 'error',
            content: `Task ${taskId} not found.`,
          };
        }

        // Signal running daemon to reload the task
        const { isDaemonRunning, sendDaemonCommand } = await import(
          '../../schedule/run-schedule-daemon.js'
        );
        if (await isDaemonRunning()) {
          try {
            await sendDaemonCommand('reload', taskId);
          } catch {
            // best-effort
          }
        }

        return {
          type: 'message',
          messageType: 'info',
          content: `Task ${taskId} updated.\n${formatScheduleTaskSummary(task)}`,
        };
      } catch (err) {
        return {
          type: 'message',
          messageType: 'error',
          content: `Error updating task: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    }

    // /schedule logs <id>
    if (args.startsWith('logs ')) {
      const taskId = args.slice('logs '.length).trim();
      if (!taskId) {
        return {
          type: 'message',
          messageType: 'error',
          content: 'Usage: /schedule logs <taskId>',
        };
      }
      const task = await readScheduleTask(taskId);
      if (!task) {
        return {
          type: 'message',
          messageType: 'error',
          content: `Task ${taskId} not found.`,
        };
      }
      const records = await getScheduleRunRecords(taskId);
      if (records.length === 0) {
        return {
          type: 'message',
          messageType: 'info',
          content: `No runs recorded for task ${taskId} (${task.definition.name}).`,
        };
      }
      const lines = records.map(
        (r) =>
          `  [${r.startedAt}] exit=${r.exitCode ?? '?'}  ${r.outputSummary.slice(0, 80)}`,
      );
      return {
        type: 'message',
        messageType: 'info',
        content: `Run history for ${taskId} (${task.definition.name}):\n${lines.join('\n')}\n${records.length} run(s) total.`,
      };
    }

    // /schedule run <id> — not supported interactively, point to CLI
    if (args.startsWith('run ')) {
      return {
        type: 'message',
        messageType: 'info',
        content: 'Run a task from the shell: `qwen schedule run <taskId>`',
      };
    }

    return {
      type: 'message',
      messageType: 'info',
      content: '/schedule [list|daemon status|delete <id>|logs <id>]',
    };
  },
};

async function tryReadPidStatus(): Promise<string> {
  const { readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { homedir } = await import('node:os');
  try {
    const pidFile = join(homedir(), '.qwen', 'schedule-daemon.pid');
    const raw = readFileSync(pidFile, 'utf-8');
    const pid = Number(raw.trim());
    if (!Number.isInteger(pid) || pid <= 0) {
      return 'Schedule daemon is not running.';
    }
    try {
      process.kill(pid, 0);
      return `Schedule daemon is running (PID ${pid}).`;
    } catch {
      return 'Schedule daemon is not running.';
    }
  } catch {
    return 'Schedule daemon is not running.';
  }
}
