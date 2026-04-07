/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { SlashCommand, SlashCommandActionReturn } from './types.js';
import { CommandKind } from './types.js';
import { MessageType, type HistoryItemText } from '../types.js';
import { t } from '../../i18n/index.js';
import { ParallelTaskRunner } from '@qwen-code/qwen-code-core';
import type { ParallelGroupRuntime } from '@qwen-code/qwen-code-core';

/**
 * Format parallel task progress for display.
 */
function formatTaskProgress(group: ParallelGroupRuntime): string {
  const lines: string[] = [];

  const statusIcon =
    group.status === 'running'
      ? '⏳'
      : group.status === 'completed'
        ? '✅'
        : group.status === 'failed'
          ? '❌'
          : '⏹️';

  lines.push(`${statusIcon} **${group.config.description}**`);
  lines.push('');

  for (const task of group.tasks) {
    const icon =
      task.status === 'running'
        ? '🔄'
        : task.status === 'completed'
          ? '✅'
          : task.status === 'failed'
            ? '❌'
            : task.status === 'cancelled'
              ? '⏹️'
              : '⏳';

    const taskIcon = task.config.icon ?? '📋';
    lines.push(
      `${icon} ${taskIcon} **${task.config.taskName}** — ${task.status}`,
    );

    if (task.toolCallCount > 0) {
      lines.push(`   Tool calls: ${task.toolCallCount}`);
    }
    if (task.error) {
      lines.push(`   Error: ${task.error}`);
    }
  }

  return lines.join('\n');
}

export const parallelCommand: SlashCommand = {
  name: 'parallel',
  altNames: ['par', 'split'],
  get description() {
    return t(
      'execute tasks in parallel (frontend + backend, etc.)',
    );
  },
  kind: CommandKind.BUILT_IN,
  action: async (context, args): Promise<SlashCommandActionReturn> => {
    const config = context.services.config;
    if (!config) {
      return {
        type: 'message',
        messageType: 'error',
        content: 'Config not available',
      };
    }

    const trimmedArgs = args.trim();

    // No args — show help
    if (!trimmedArgs) {
      const historyItem: Omit<HistoryItemText, 'id'> = {
        type: MessageType.TEXT,
        text: `**Parallel Task Execution**

Run multiple tasks simultaneously for faster development.

**Usage:**

\`/parallel split <description>\` — Split feature into frontend + backend
\`/parallel status\` — Show running parallel tasks
\`/parallel cancel <group-id>\` — Cancel a running group
\`/parallel run <task-config>\` — Run custom parallel tasks

**Example:**

\`/parallel split "User authentication with OAuth"\`

This will:
- 🎨 Frontend: Implement UI components, state management, API integration
- ⚙️ Backend: Implement API endpoints, business logic, database models

Both tasks run **simultaneously** with isolated contexts.`,
      };
      context.ui.addItem(historyItem, Date.now());
      return;
    }

    // /parallel status
    if (trimmedArgs.startsWith('status')) {
      const modeManager = config.getModeManager();
      const runner = new ParallelTaskRunner(config);
      const activeGroups = runner.getActiveGroups();

      if (activeGroups.size === 0) {
        const historyItem: Omit<HistoryItemText, 'id'> = {
          type: MessageType.TEXT,
          text: 'No active parallel tasks.',
        };
        context.ui.addItem(historyItem, Date.now());
        return;
      }

      const lines: string[] = ['**Active Parallel Groups:**', ''];
      for (const [groupId, group] of activeGroups) {
        lines.push(formatTaskProgress(group));
        lines.push(`\`Group ID: ${groupId}\``);
        lines.push('');
      }

      const historyItem: Omit<HistoryItemText, 'id'> = {
        type: MessageType.TEXT,
        text: lines.join('\n'),
      };
      context.ui.addItem(historyItem, Date.now());
      return;
    }

    // /parallel cancel <group-id>
    if (trimmedArgs.startsWith('cancel')) {
      const groupId = trimmedArgs.replace(/^cancel\s*/, '').trim();
      if (!groupId) {
        const historyItem: Omit<HistoryItemText, 'id'> = {
          type: MessageType.TEXT,
          text: 'Usage: `/parallel cancel <group-id>`',
        };
        context.ui.addItem(historyItem, Date.now());
        return;
      }

      const runner = new ParallelTaskRunner(config);
      try {
        runner.cancelGroup(groupId);
        const historyItem: Omit<HistoryItemText, 'id'> = {
          type: MessageType.TEXT,
          text: `✅ Cancelled group \`${groupId}\``,
        };
        context.ui.addItem(historyItem, Date.now());
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : 'Unknown error';
        const historyItem: Omit<HistoryItemText, 'id'> = {
          type: MessageType.TEXT,
          text: `❌ **Error:** ${errorMessage}`,
        };
        context.ui.addItem(historyItem, Date.now());
      }
      return;
    }

    // /parallel split <description> — the main use case
    if (trimmedArgs.startsWith('split')) {
      const description = trimmedArgs.replace(/^split\s*/, '').trim();
      if (!description) {
        const historyItem: Omit<HistoryItemText, 'id'> = {
          type: MessageType.TEXT,
          text: 'Usage: `/parallel split <feature description>`\n\nExample: `/parallel split "User authentication with OAuth"`',
        };
        context.ui.addItem(historyItem, Date.now());
        return;
      }

      // Show starting message
      const startItem: Omit<HistoryItemText, 'id'> = {
        type: MessageType.TEXT,
        text: `🚀 **Splitting feature into parallel tasks:**\n\n${description}\n\n- 🎨 **Frontend** — UI components, state, API integration\n- ⚙️ **Backend** — API endpoints, business logic, database\n\nBoth tasks are now running simultaneously...`,
      };
      context.ui.addItem(startItem, Date.now());

      // Execute in parallel
      try {
        const runner = new ParallelTaskRunner(config);
        const group = await runner.splitFeatureImplementation(description);

        // Show results
        const summary = ParallelTaskRunner.generateSummary(group);
        const historyItem: Omit<HistoryItemText, 'id'> = {
          type: MessageType.TEXT,
          text: summary,
        };
        context.ui.addItem(historyItem, Date.now());
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : 'Unknown error';
        const historyItem: Omit<HistoryItemText, 'id'> = {
          type: MessageType.TEXT,
          text: `❌ **Parallel execution failed:** ${errorMessage}`,
        };
        context.ui.addItem(historyItem, Date.now());
      }
      return;
    }

    // /parallel run — custom configuration (JSON)
    if (trimmedArgs.startsWith('run')) {
      const runArgs = trimmedArgs.replace(/^run\s*/, '').trim();
      if (!runArgs) {
        const historyItem: Omit<HistoryItemText, 'id'> = {
          type: MessageType.TEXT,
          text: `Usage: \`/parallel run <JSON config>\`

Example:
\`/parallel run {"tasks": [{"taskId": "docs", "taskName": "Documentation", "subagent": "general-purpose", "prompt": "Write docs"}, {"taskId": "tests", "taskName": "Tests", "subagent": "general-purpose", "prompt": "Write tests"}]}\`

Required fields per task:
- \`taskId\`: Unique identifier
- \`taskName\`: Display name
- \`subagent\`: Sub-agent to use
- \`prompt\`: Task instructions

Optional: \`mode\`, \`icon\`, \`color\`, \`maxTimeMinutes\`, \`maxTurns\``,
        };
        context.ui.addItem(historyItem, Date.now());
        return;
      }

      try {
        const groupConfig = JSON.parse(runArgs);
        groupConfig.groupId = groupConfig.groupId || `custom-${Date.now()}`;
        groupConfig.description =
          groupConfig.description || 'Custom parallel tasks';
        groupConfig.waitForAll = groupConfig.waitForAll ?? true;

        const runner = new ParallelTaskRunner(config);
        const group = await runner.startGroup(groupConfig);

        const summary = ParallelTaskRunner.generateSummary(group);
        const historyItem: Omit<HistoryItemText, 'id'> = {
          type: MessageType.TEXT,
          text: summary,
        };
        context.ui.addItem(historyItem, Date.now());
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : 'Unknown error';
        const historyItem: Omit<HistoryItemText, 'id'> = {
          type: MessageType.TEXT,
          text: `❌ **Error:** ${errorMessage}`,
        };
        context.ui.addItem(historyItem, Date.now());
      }
      return;
    }

    // Unknown subcommand
    const historyItem: Omit<HistoryItemText, 'id'> = {
      type: MessageType.TEXT,
      text: `Unknown command: \`/parallel ${trimmedArgs}\`

Available subcommands:
- \`split <description>\` — Split feature into frontend + backend
- \`status\` — Show running parallel tasks
- \`cancel <group-id>\` — Cancel a running group
- \`run <JSON>\` — Run custom parallel tasks

Use \`/parallel\` alone for help.`,
    };
    context.ui.addItem(historyItem, Date.now());
  },
};
