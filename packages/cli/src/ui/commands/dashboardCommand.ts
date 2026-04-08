/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  CommandContext,
  SlashCommand,
  SlashCommandActionReturn,
} from './types.js';
import { CommandKind } from './types.js';
import { MessageType, type HistoryItemText } from '../types.js';
import { t } from '../../i18n/index.js';
import type { ParallelTaskRuntime } from '@qwen-code/qwen-code-core';
import { ParallelTaskRunner } from '@qwen-code/qwen-code-core';

/**
 * Format time since a date for display.
 */
function formatTimeSince(date: Date): string {
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHr = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHr / 24);

  if (diffSec < 60) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  if (diffHr < 24) return `${diffHr}h ago`;
  return `${diffDay}d ago`;
}

/**
 * Format a progress bar for text display.
 */
function formatProgressBar(progress: number, width: number = 25): string {
  const clampedProgress = Math.max(0, Math.min(1, progress));
  const filledWidth = Math.round(clampedProgress * width);
  const emptyWidth = width - filledWidth;

  const filled = '\u2588'.repeat(filledWidth);
  const empty = '\u2591'.repeat(emptyWidth);

  return `[${filled}${empty}] ${Math.round(clampedProgress * 100)}%`;
}

/**
 * Format current mode information.
 */
function formatCurrentMode(
  config: CommandContext['services']['config'],
): string {
  if (!config) {
    return 'No configuration available';
  }

  const currentMode = config.getCurrentMode();

  if (!currentMode) {
    return 'General (default)';
  }

  const { icon, displayName, name, description } = currentMode.config;
  return `${icon} **${displayName}** (\`${name}\`)\n${description}`;
}

/**
 * Format parallel task status.
 */
function formatTaskStatus(task: ParallelTaskRuntime): string {
  const icon = task.config.icon ?? '📋';
  const statusIndicator =
    task.status === 'running'
      ? '🔄'
      : task.status === 'completed'
        ? '✅'
        : task.status === 'failed'
          ? '❌'
          : task.status === 'cancelled'
            ? '⏹️'
            : '⏳';

  // Estimate progress based on tool calls (heuristic)
  const estimatedProgress =
    task.status === 'completed'
      ? 1
      : task.status === 'failed' || task.status === 'cancelled'
        ? 0
        : Math.min(0.9, task.toolCallCount * 0.1);

  const progressBar =
    task.status === 'running' ? ` ${formatProgressBar(estimatedProgress)}` : '';

  return `${statusIndicator} ${icon} **${task.config.taskName}** — ${task.status}${progressBar}\n   Tool calls: ${task.toolCallCount}${task.error ? `\n   Error: ${task.error}` : ''}`;
}

/**
 * Format parallel groups information.
 */
function formatParallelGroups(
  config: CommandContext['services']['config'],
): string {
  if (!config) {
    return 'No configuration available';
  }

  const runner = new ParallelTaskRunner(config);
  const activeGroups = runner.getActiveGroups();

  if (activeGroups.size === 0) {
    return 'No active parallel tasks';
  }

  const lines: string[] = [];

  for (const [groupId, group] of activeGroups) {
    const statusIcon =
      group.status === 'running'
        ? '⏳'
        : group.status === 'completed'
          ? '✅'
          : group.status === 'failed'
            ? '❌'
            : '⏹️';

    lines.push(
      `${statusIcon} **${group.config.description}** (\`Group: ${groupId}\`)`,
    );
    lines.push('');

    for (const task of group.tasks) {
      lines.push(formatTaskStatus(task));
    }
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Format session statistics.
 */
function formatSessionStats(context: CommandContext): string {
  const { stats } = context.session;
  const { metrics, sessionStartTime } = stats;

  if (!sessionStartTime) {
    return 'Session stats unavailable';
  }

  const now = new Date();
  const durationMs = now.getTime() - sessionStartTime.getTime();
  const durationSec = Math.floor(durationMs / 1000);
  const durationMin = Math.floor(durationSec / 60);
  const durationHr = Math.floor(durationMin / 60);

  let durationStr: string;
  if (durationHr > 0) {
    durationStr = `${durationHr}h ${durationMin % 60}m`;
  } else if (durationMin > 0) {
    durationStr = `${durationMin}m ${durationSec % 60}s`;
  } else {
    durationStr = `${durationSec}s`;
  }

  const lines = [
    `- **Session ID:** ${stats.sessionId}`,
    `- **Duration:** ${durationStr}`,
    `- **Tool calls:** ${metrics.tools.totalCalls} (${metrics.tools.totalSuccess} succeeded, ${metrics.tools.totalFail} failed)`,
    `- **Files changed:** +${metrics.files.totalLinesAdded} / -${metrics.files.totalLinesRemoved} lines`,
    `- **Prompts:** ${stats.promptCount}`,
  ];

  return lines.join('\n');
}

/**
 * Get recent mode switches from the mode manager.
 */
function formatRecentActivity(
  config: CommandContext['services']['config'],
): string {
  if (!config) {
    return 'No activity available';
  }

  // modeManager available via config.getModeManager()
  const currentMode = config.getCurrentMode();

  if (!currentMode) {
    return 'No mode activity recorded';
  }

  // Build a simple activity summary
  const lines = [
    `- 🔄 Currently in **${currentMode.config.displayName}** mode`,
    `- 📊 Session started ${formatTimeSince(sessionStartTime)}`,
  ];

  // Check for parallel tasks
  if (config) {
    const runner = new ParallelTaskRunner(config);
    const activeGroups = runner.getActiveGroups();
    if (activeGroups.size > 0) {
      lines.push(
        `- ⚡ ${activeGroups.size} parallel task group${activeGroups.size > 1 ? 's' : ''} active`,
      );
    }
  }

  return lines.join('\n');
}

// Track session start time for activity display
let sessionStartTime: Date = new Date();

export const dashboardCommand: SlashCommand = {
  name: 'dashboard',
  altNames: ['dash'],
  get description() {
    return t('show mode dashboard with status and statistics');
  },
  kind: CommandKind.BUILT_IN,
  action: async (
    context: CommandContext,
    args: string,
  ): Promise<SlashCommandActionReturn> => {
    const trimmedArgs = args.trim();
    // config available from context

    // Update session start time reference
    if (context.session.stats.sessionStartTime) {
      sessionStartTime = context.session.stats.sessionStartTime;
    }

    // /dashboard refresh — just refresh the display
    if (trimmedArgs === 'refresh') {
      const historyItem: Omit<HistoryItemText, 'id'> = {
        type: MessageType.TEXT,
        text: formatDashboard(context),
      };
      context.ui.addItem(historyItem, Date.now());
      return;
    }

    // /dashboard — show full dashboard
    const historyItem: Omit<HistoryItemText, 'id'> = {
      type: MessageType.TEXT,
      text: formatDashboard(context),
    };
    context.ui.addItem(historyItem, Date.now());
  },
  subCommands: [
    {
      name: 'refresh',
      get description() {
        return t('refresh the dashboard display');
      },
      kind: CommandKind.BUILT_IN,
      action: async (context: CommandContext) => {
        const historyItem: Omit<HistoryItemText, 'id'> = {
          type: MessageType.TEXT,
          text: formatDashboard(context),
        };
        context.ui.addItem(historyItem, Date.now());
      },
    },
    {
      name: 'modes',
      get description() {
        return t('show mode usage statistics');
      },
      kind: CommandKind.BUILT_IN,
      action: async (context: CommandContext) => {
        // config available from context
        if (!config) {
          const historyItem: Omit<HistoryItemText, 'id'> = {
            type: MessageType.TEXT,
            text: 'Config not available',
          };
          context.ui.addItem(historyItem, Date.now());
          return;
        }

        // modeManager available via config.getModeManager()
        const modes = modeManager.getAvailableModes();
        const currentMode = config.getCurrentMode();

        const lines = [
          '**Mode Statistics**',
          '',
          `Total modes: ${modes.length}`,
          `Current mode: ${currentMode ? currentMode.config.displayName : 'General'}`,
          '',
          '**Available Modes:**',
          ...modes.map((m) =>
            m.name === currentMode?.config.name
              ? `▸ ${m.icon} **${m.displayName}** (${m.level})`
              : `  ${m.icon} ${m.displayName} (${m.level})`,
          ),
        ];

        const historyItem: Omit<HistoryItemText, 'id'> = {
          type: MessageType.TEXT,
          text: lines.join('\n'),
        };
        context.ui.addItem(historyItem, Date.now());
      },
    },
    {
      name: 'tasks',
      get description() {
        return t('show parallel task status');
      },
      kind: CommandKind.BUILT_IN,
      action: async (context: CommandContext) => {
        // config available from context

        const lines = ['**Parallel Tasks**', '', formatParallelGroups(config)];

        const historyItem: Omit<HistoryItemText, 'id'> = {
          type: MessageType.TEXT,
          text: lines.join('\n'),
        };
        context.ui.addItem(historyItem, Date.now());
      },
    },
  ],
};

/**
 * Format the full dashboard display.
 */
function formatDashboard(context: CommandContext): string {
  // config available from context

  const sections: string[] = [];

  // Header
  sections.push('**📊 Mode Dashboard**');
  sections.push('');

  // Current Mode
  sections.push('**🎯 Current Mode**');
  sections.push(formatCurrentMode(config));
  sections.push('');

  // Parallel Tasks
  sections.push('**⚡ Parallel Tasks**');
  sections.push(formatParallelGroups(config));
  sections.push('');

  // Session Statistics
  sections.push('**📋 Session Statistics**');
  sections.push(formatSessionStats(context));
  sections.push('');

  // Recent Activity
  sections.push('**🕒 Recent Activity**');
  sections.push(formatRecentActivity(config));

  return sections.join('\n');
}
