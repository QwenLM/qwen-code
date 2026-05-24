/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  type CommandContext,
  type SlashCommand,
  type MessageActionReturn,
  CommandKind,
} from './types.js';
import { MessageType } from '../types.js';
import { t } from '../../i18n/index.js';
import {
  getDailyUsage,
  getMonthlyUsage,
  getModelUsage,
} from '@qwen-code/qwen-code-core';
import { formatTokenCount } from '../utils/formatters.js';

type TokenStatsMode = 'daily' | 'monthly' | 'model';

function parseMode(args: string): TokenStatsMode {
  const trimmed = args.trim().toLowerCase();
  if (trimmed === 'monthly' || trimmed === 'month') return 'monthly';
  if (trimmed === 'model' || trimmed === 'models') return 'model';
  return 'daily';
}

function formatTextDaily(
  data: { date: string; usage: { total: { prompt: number; candidates: number; total: number }; sessionCount: number; requestCount: number } }[],
): string {
  if (data.length === 0) return t('No usage data found.');
  const lines = [t('Daily Token Usage (Last 7 Days)'), ''];
  for (const { date, usage } of data) {
    lines.push(
      `${date}: input=${formatTokenCount(usage.total.prompt)}, output=${formatTokenCount(usage.total.candidates)}, total=${formatTokenCount(usage.total.total)} (${usage.sessionCount} sessions, ${usage.requestCount} requests)`,
    );
  }
  return lines.join('\n');
}

function formatTextMonthly(
  data: { month: string; usage: { total: { prompt: number; candidates: number; total: number }; sessionCount: number; requestCount: number } }[],
): string {
  if (data.length === 0) return t('No usage data found.');
  const lines = [t('Monthly Token Usage (Last 6 Months)'), ''];
  for (const { month, usage } of data) {
    lines.push(
      `${month}: input=${formatTokenCount(usage.total.prompt)}, output=${formatTokenCount(usage.total.candidates)}, total=${formatTokenCount(usage.total.total)} (${usage.sessionCount} sessions, ${usage.requestCount} requests)`,
    );
  }
  return lines.join('\n');
}

function formatTextModel(
  data: Record<string, { tokens: { prompt: number; candidates: number; total: number }; requestCount: number }>,
): string {
  const entries = Object.entries(data).sort(
    ([, a], [, b]) => b.tokens.total - a.tokens.total,
  );
  if (entries.length === 0) return t('No model usage data found.');
  const lines = [t('Token Usage by Model (Last 3 Months)'), ''];
  for (const [model, entry] of entries) {
    lines.push(
      `${model}: input=${formatTokenCount(entry.tokens.prompt)}, output=${formatTokenCount(entry.tokens.candidates)}, total=${formatTokenCount(entry.tokens.total)} (${entry.requestCount} requests)`,
    );
  }
  return lines.join('\n');
}

export const tokenStatsCommand: SlashCommand = {
  name: 'token-stats',
  get description() {
    return t(
      'Show cross-session token usage statistics. Usage: /token-stats [daily|monthly|model]',
    );
  },
  argumentHint: '[daily|monthly|model]',
  kind: CommandKind.BUILT_IN,
  supportedModes: ['interactive', 'non_interactive', 'acp'] as const,
  action: async (
    context: CommandContext,
    args: string,
  ): Promise<MessageActionReturn | void> => {
    const mode = parseMode(args);

    try {
      if (mode === 'daily') {
        const data = await getDailyUsage(7);
        if (context.executionMode !== 'interactive') {
          return {
            type: 'message',
            messageType: 'info',
            content: formatTextDaily(data),
          };
        }
        context.ui.addItem(
          {
            type: MessageType.TOKEN_STATS,
            tokenStatsMode: 'daily',
            dailyData: data,
          },
          Date.now(),
        );
        return;
      }

      if (mode === 'monthly') {
        const data = await getMonthlyUsage(6);
        if (context.executionMode !== 'interactive') {
          return {
            type: 'message',
            messageType: 'info',
            content: formatTextMonthly(data),
          };
        }
        context.ui.addItem(
          {
            type: MessageType.TOKEN_STATS,
            tokenStatsMode: 'monthly',
            monthlyData: data,
          },
          Date.now(),
        );
        return;
      }

      // mode === 'model'
      const data = await getModelUsage(3);
      if (context.executionMode !== 'interactive') {
        return {
          type: 'message',
          messageType: 'info',
          content: formatTextModel(data),
        };
      }
      context.ui.addItem(
        {
          type: MessageType.TOKEN_STATS,
          tokenStatsMode: 'model',
          modelData: data,
        },
        Date.now(),
      );
    } catch (error) {
      const message =
        error instanceof Error ? error.message : String(error);
      if (context.executionMode !== 'interactive') {
        return {
          type: 'message',
          messageType: 'error',
          content: t('Failed to load usage data: {error}', {
            error: message,
          }),
        };
      }
      context.ui.addItem(
        {
          type: MessageType.ERROR,
          text: t('Failed to load usage data: {error}', {
            error: message,
          }),
        },
        Date.now(),
      );
    }
  },
  subCommands: [
    {
      name: 'daily',
      get description() {
        return t('Show daily token usage for the last 7 days.');
      },
      kind: CommandKind.BUILT_IN,
      supportedModes: ['interactive', 'non_interactive', 'acp'] as const,
      action: async (
        context: CommandContext,
      ): Promise<MessageActionReturn | void> => {
        const data = await getDailyUsage(7);
        if (context.executionMode !== 'interactive') {
          return {
            type: 'message',
            messageType: 'info',
            content: formatTextDaily(data),
          };
        }
        context.ui.addItem(
          {
            type: MessageType.TOKEN_STATS,
            tokenStatsMode: 'daily',
            dailyData: data,
          },
          Date.now(),
        );
      },
    },
    {
      name: 'monthly',
      get description() {
        return t('Show monthly token usage for the last 6 months.');
      },
      kind: CommandKind.BUILT_IN,
      supportedModes: ['interactive', 'non_interactive', 'acp'] as const,
      action: async (
        context: CommandContext,
      ): Promise<MessageActionReturn | void> => {
        const data = await getMonthlyUsage(6);
        if (context.executionMode !== 'interactive') {
          return {
            type: 'message',
            messageType: 'info',
            content: formatTextMonthly(data),
          };
        }
        context.ui.addItem(
          {
            type: MessageType.TOKEN_STATS,
            tokenStatsMode: 'monthly',
            monthlyData: data,
          },
          Date.now(),
        );
      },
    },
    {
      name: 'model',
      get description() {
        return t(
          'Show per-model token usage for the last 3 months.',
        );
      },
      kind: CommandKind.BUILT_IN,
      supportedModes: ['interactive', 'non_interactive', 'acp'] as const,
      action: async (
        context: CommandContext,
      ): Promise<MessageActionReturn | void> => {
        const data = await getModelUsage(3);
        if (context.executionMode !== 'interactive') {
          return {
            type: 'message',
            messageType: 'info',
            content: formatTextModel(data),
          };
        }
        context.ui.addItem(
          {
            type: MessageType.TOKEN_STATS,
            tokenStatsMode: 'model',
            modelData: data,
          },
          Date.now(),
        );
      },
    },
  ],
};
