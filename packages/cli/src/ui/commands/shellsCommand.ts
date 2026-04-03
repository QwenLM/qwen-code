/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  type CommandContext,
  type SlashCommand,
  CommandKind,
} from './types.js';
import { MessageType } from '../types.js';
import {
  ShellProcessRegistry,
  type ShellProcess,
} from '@qwen-code/qwen-code-core';
import { t } from '../../i18n/index.js';

export const shellsCommand: SlashCommand = {
  name: 'shells',
  altNames: ['processes', 'bg'],
  get description() {
    return t('List and manage background shell processes. Usage: /shells');
  },
  kind: CommandKind.BUILT_IN,
  action: (context: CommandContext) => {
    let registry: ShellProcessRegistry;
    try {
      registry = ShellProcessRegistry.getInstance();
    } catch {
      context.ui.addItem(
        {
          type: MessageType.INFO,
          text: t('Background shell management is not currently available.'),
        },
        Date.now(),
      );
      return;
    }

    const processes = registry.listProcesses();

    if (processes.length === 0) {
      context.ui.addItem(
        {
          type: MessageType.INFO,
          text: t(
            'No background shell processes are currently running.\n\nStart a background process by asking Qwen to run a command like "npm run dev" or "tail -f logs".',
          ),
        },
        Date.now(),
      );
      return;
    }

    // Create a formatted table as text
    const stats = registry.getStats();
    const header = `Background Shell Processes (${stats.running} running, ${stats.completed} completed, ${stats.killed} killed)`;

    // Table header
    const colId = 'ID'.padEnd(10);
    const colStatus = 'Status'.padEnd(12);
    const colCommand = 'Command'.padEnd(35);
    const colTime = 'Runtime'.padEnd(12);
    const colPid = 'PID'.padEnd(10);

    const tableHeader = `│ ${colId} │ ${colStatus} │ ${colCommand} │ ${colTime} │ ${colPid} │`;
    const border = `├${'─'.repeat(12)}┼${'─'.repeat(14)}┼${'─'.repeat(37)}┼${'─'.repeat(14)}┼${'─'.repeat(12)}┤`;

    const rows = processes.map((proc: ShellProcess) => {
      const id = proc.id.padEnd(10);
      const status = proc.status.padEnd(12);
      const command =
        proc.command.length > 33
          ? proc.command.substring(0, 30) + '...'
          : proc.command.padEnd(35);
      const runtime = (registry.formatRuntime(proc.id) ?? 'N/A').padEnd(12);
      const pid = (proc.pid?.toString() ?? 'N/A').padEnd(10);

      return `│ ${id} │ ${status} │ ${command} │ ${runtime} │ ${pid} │`;
    });

    const table = [
      `┌${'─'.repeat(12)}┬${'─'.repeat(14)}┬${'─'.repeat(37)}┬${'─'.repeat(14)}┬${'─'.repeat(12)}┐`,
      tableHeader,
      border,
      ...rows,
      `└${'─'.repeat(12)}┴${'─'.repeat(14)}┴${'─'.repeat(37)}┴${'─'.repeat(14)}┴${'─'.repeat(12)}┘`,
    ].join('\n');

    const help =
      '\n\nCommands:\n  • /shell-output <id> [lines] - View output from a shell\n  • /kill-shell <id> - Kill a background shell\n  • Ask Qwen: "Show me shell_1 logs" or "Stop shell_2"';

    context.ui.addItem(
      {
        type: MessageType.INFO,
        text: `${header}\n\n${table}${help}`,
      },
      Date.now(),
    );
  },
  subCommands: [
    {
      name: 'output',
      get description() {
        return t(
          'View output from a specific shell. Usage: /shells output <id> [lines]',
        );
      },
      kind: CommandKind.BUILT_IN,
      action: (context: CommandContext, args?: string) => {
        let registry: ShellProcessRegistry;
        try {
          registry = ShellProcessRegistry.getInstance();
        } catch {
          context.ui.addItem(
            {
              type: MessageType.ERROR,
              text: t('Background shell management is not available.'),
            },
            Date.now(),
          );
          return;
        }

        const parts = args?.trim().split(/\s+/) || [];
        const shellId = parts[0];
        const lines = parseInt(parts[1] || '50', 10);

        if (!shellId) {
          context.ui.addItem(
            {
              type: MessageType.ERROR,
              text: t(
                'Usage: /shells output <shell_id> [num_lines]\nExample: /shells output shell_1 100',
              ),
            },
            Date.now(),
          );
          return;
        }

        const process = registry.getProcess(shellId);

        if (!process) {
          context.ui.addItem(
            {
              type: MessageType.ERROR,
              text: t(
                `Shell '${shellId}' not found. Use /shells to list all shells.`,
              ),
            },
            Date.now(),
          );
          return;
        }

        const output = registry.getRecentOutput(shellId, lines);
        const runtime = registry.formatRuntime(shellId);

        const header = `Shell: ${shellId}\nCommand: ${process.command}\nStatus: ${process.status}\nRuntime: ${runtime ?? 'N/A'}\n\n--- Last ${lines} lines ---`;

        context.ui.addItem(
          {
            type: MessageType.INFO,
            text: `${header}\n${output || '(No output yet)'}`,
          },
          Date.now(),
        );
      },
    },
    {
      name: 'kill',
      get description() {
        return t('Kill a background shell. Usage: /shells kill <id>');
      },
      kind: CommandKind.BUILT_IN,
      action: async (context: CommandContext, args?: string) => {
        const shellId = args?.trim();

        if (!shellId) {
          context.ui.addItem(
            {
              type: MessageType.ERROR,
              text: t(
                'Usage: /shells kill <shell_id>\nExample: /shells kill shell_1',
              ),
            },
            Date.now(),
          );
          return;
        }

        let registry: ShellProcessRegistry;
        try {
          registry = ShellProcessRegistry.getInstance();
        } catch {
          context.ui.addItem(
            {
              type: MessageType.ERROR,
              text: t('Background shell management is not available.'),
            },
            Date.now(),
          );
          return;
        }

        const process = registry.getProcess(shellId);

        if (!process) {
          context.ui.addItem(
            {
              type: MessageType.ERROR,
              text: t(
                `Shell '${shellId}' not found. Use /shells to list all shells.`,
              ),
            },
            Date.now(),
          );
          return;
        }

        if (process.status !== 'running') {
          context.ui.addItem(
            {
              type: MessageType.INFO,
              text: t(`Shell '${shellId}' is already ${process.status}.`),
            },
            Date.now(),
          );
          return;
        }

        const success = await registry.killProcess(shellId);
        const runtime = registry.formatRuntime(shellId);

        if (success) {
          context.ui.addItem(
            {
              type: MessageType.SUCCESS,
              text: t(
                `✓ Shell '${shellId}' killed successfully. (Ran for ${runtime})`,
              ),
            },
            Date.now(),
          );
        } else {
          context.ui.addItem(
            {
              type: MessageType.ERROR,
              text: t(
                `✗ Failed to kill shell '${shellId}'. It may have already exited.`,
              ),
            },
            Date.now(),
          );
        }
      },
    },
    {
      name: 'stats',
      get description() {
        return t('Show shell process statistics');
      },
      kind: CommandKind.BUILT_IN,
      action: (context: CommandContext) => {
        let registry: ShellProcessRegistry;
        try {
          registry = ShellProcessRegistry.getInstance();
        } catch {
          context.ui.addItem(
            {
              type: MessageType.INFO,
              text: t('Background shell management is not available.'),
            },
            Date.now(),
          );
          return;
        }

        const stats = registry.getStats();

        context.ui.addItem(
          {
            type: MessageType.INFO,
            text: t(
              `Shell Process Statistics:\n` +
                `  Total: ${stats.total}\n` +
                `  Running: ${stats.running}\n` +
                `  Completed: ${stats.completed}\n` +
                `  Killed: ${stats.killed}\n` +
                `  Failed: ${stats.failed}`,
            ),
          },
          Date.now(),
        );
      },
    },
  ],
};
