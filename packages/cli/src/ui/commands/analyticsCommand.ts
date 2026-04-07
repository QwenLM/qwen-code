/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { SlashCommand, SlashCommandActionReturn } from './types.js';
import { CommandKind } from './types.js';
import { MessageType, type HistoryItemText } from '../types.js';
import { t } from '../../i18n/index.js';

/**
 * Format a duration in seconds to a human-readable string.
 */
function formatDuration(seconds: number): string {
  if (seconds < 60) {
    return `${seconds}s`;
  }
  if (seconds < 3600) {
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    return `${minutes}m ${remainingSeconds}s`;
  }
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return `${hours}h ${minutes}m`;
}

/**
 * Format mode statistics for display.
 */
function formatModeStats(stats: {
  modeName: string;
  totalTimeSeconds: number;
  sessionCount: number;
  averageSessionTime: number;
  lastUsed: Date;
  toolCallCount: number;
  messagesExchanged: number;
  filesModified: number;
}): string {
  const lines = [
    `**${stats.modeName}**`,
    `- Total time: ${formatDuration(stats.totalTimeSeconds)}`,
    `- Sessions: ${stats.sessionCount}`,
    `- Avg session: ${formatDuration(Math.round(stats.averageSessionTime))}`,
    `- Last used: ${stats.lastUsed.toLocaleString()}`,
    `- Tool calls: ${stats.toolCallCount}`,
    `- Messages: ${stats.messagesExchanged}`,
    `- Files modified: ${stats.filesModified}`,
  ];
  return lines.join('\n');
}

/**
 * Format the productivity report for display.
 */
function formatProductivityReport(report: {
  totalTime: number;
  mostUsedMode: string;
  modeDistribution: Record<string, number>;
  suggestions: string[];
}): string {
  const lines = [
    '**Mode Analytics Report**',
    '',
    `**Total time:** ${formatDuration(report.totalTime)}`,
    `**Most used mode:** ${report.mostUsedMode}`,
    '',
    '**Mode Distribution:**',
  ];

  // Sort distribution by percentage
  const sorted = Object.entries(report.modeDistribution)
    .sort(([, a], [, b]) => b - a);

  for (const [mode, percent] of sorted) {
    const bar = '#'.repeat(Math.round(percent / 5));
    lines.push(`  ${mode}: ${percent.toFixed(1)}% ${bar}`);
  }

  if (report.suggestions.length > 0) {
    lines.push('');
    lines.push('**Suggestions:**');
    for (const suggestion of report.suggestions) {
      lines.push(`- ${suggestion}`);
    }
  }

  return lines.join('\n');
}

export const analyticsCommand: SlashCommand = {
  name: 'analytics',
  altNames: ['mode-stats'],
  get description() {
    return t('show mode usage analytics and statistics');
  },
  kind: CommandKind.BUILT_IN,
  action: async (context, args): Promise<SlashCommandActionReturn | void> => {
    const config = context.services.config;
    if (!config) {
      return {
        type: 'message',
        messageType: 'error',
        content: 'Config not available',
      };
    }

    const modeManager = config.getModeManager();
    const analytics = modeManager.getAnalytics();
    const trimmedArgs = args.trim();

    // No args — show summary
    if (!trimmedArgs) {
      const allStats = analytics.getAllStats();
      const report = analytics.getProductivityReport();

      let content = '**Mode Analytics Summary**\n\n';
      content += `**Total sessions:** ${analytics.getSessionCount()}\n`;
      content += `**Total time:** ${formatDuration(report.totalTime)}\n`;
      content += `**Most used mode:** ${report.mostUsedMode}\n\n`;

      if (allStats.length > 0) {
        content += '**Mode Breakdown:**\n\n';
        for (const stat of allStats) {
          content += formatModeStats(stat) + '\n\n';
        }
      } else {
        content += 'No mode usage data yet.\n\n';
      }

      if (report.suggestions.length > 0) {
        content += '**Suggestions:**\n\n';
        for (const suggestion of report.suggestions) {
          content += `- ${suggestion}\n`;
        }
      }

      const historyItem: Omit<HistoryItemText, 'id'> = {
        type: MessageType.TEXT,
        text: content,
      };
      context.ui.addItem(historyItem, Date.now());
      return;
    }

    // /analytics report — full productivity report
    if (trimmedArgs === 'report') {
      const report = analytics.getProductivityReport();
      const historyItem: Omit<HistoryItemText, 'id'> = {
        type: MessageType.TEXT,
        text: formatProductivityReport(report),
      };
      context.ui.addItem(historyItem, Date.now());
      return;
    }

    // /analytics mode <name> — stats for specific mode
    if (trimmedArgs.startsWith('mode ')) {
      const modeName = trimmedArgs.replace(/^mode\s+/, '').trim();
      const stats = analytics.getModeStats(modeName);

      if (!stats) {
        const historyItem: Omit<HistoryItemText, 'id'> = {
          type: MessageType.TEXT,
          text: `No data for mode: \`${modeName}\``,
        };
        context.ui.addItem(historyItem, Date.now());
        return;
      }

      const historyItem: Omit<HistoryItemText, 'id'> = {
        type: MessageType.TEXT,
        text: formatModeStats(stats),
      };
      context.ui.addItem(historyItem, Date.now());
      return;
    }

    // /analytics clear — clear all data
    if (trimmedArgs === 'clear' || trimmedArgs === 'reset') {
      analytics.clear();
      const historyItem: Omit<HistoryItemText, 'id'> = {
        type: MessageType.TEXT,
        text: 'Analytics data cleared.',
      };
      context.ui.addItem(historyItem, Date.now());
      return;
    }

    // /analytics save <path>
    if (trimmedArgs.startsWith('save ')) {
      const filePath = trimmedArgs.replace(/^save\s+/, '').trim();
      try {
        await analytics.save(filePath);
        const historyItem: Omit<HistoryItemText, 'id'> = {
          type: MessageType.TEXT,
          text: `Analytics saved to \`${filePath}\``,
        };
        context.ui.addItem(historyItem, Date.now());
      } catch (error) {
        const errorMessage = error instanceof Error
          ? error.message
          : 'Unknown error';
        const historyItem: Omit<HistoryItemText, 'id'> = {
          type: MessageType.TEXT,
          text: `Failed to save analytics: ${errorMessage}`,
        };
        context.ui.addItem(historyItem, Date.now());
      }
      return;
    }

    // /analytics load <path>
    if (trimmedArgs.startsWith('load ')) {
      const filePath = trimmedArgs.replace(/^load\s+/, '').trim();
      try {
        await analytics.load(filePath);
        const historyItem: Omit<HistoryItemText, 'id'> = {
          type: MessageType.TEXT,
          text: `Analytics loaded from \`${filePath}\` (${analytics.getSessionCount()} sessions)`,
        };
        context.ui.addItem(historyItem, Date.now());
      } catch (error) {
        const errorMessage = error instanceof Error
          ? error.message
          : 'Unknown error';
        const historyItem: Omit<HistoryItemText, 'id'> = {
          type: MessageType.TEXT,
          text: `Failed to load analytics: ${errorMessage}`,
        };
        context.ui.addItem(historyItem, Date.now());
      }
      return;
    }

    // Unknown subcommand
    const historyItem: Omit<HistoryItemText, 'id'> = {
      type: MessageType.TEXT,
      text: `Unknown analytics subcommand: \`${trimmedArgs}\`\n\n` +
        'Usage:\n' +
        '- `/analytics` — Show summary\n' +
        '- `/analytics report` — Full productivity report\n' +
        '- `/analytics mode <name>` — Stats for specific mode\n' +
        '- `/analytics save <path>` — Save to file\n' +
        '- `/analytics load <path>` — Load from file\n' +
        '- `/analytics clear` — Clear all data',
    };
    context.ui.addItem(historyItem, Date.now());
  },
};
