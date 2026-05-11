/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { HistoryItemStats } from '../types.js';
import { MessageType } from '../types.js';
import { formatDuration } from '../utils/formatters.js';
import {
  type CommandContext,
  type SlashCommand,
  type MessageActionReturn,
  CommandKind,
} from './types.js';
import { t } from '../../i18n/index.js';
import { calculateCost } from '../../utils/costCalculator.js';

export const statsCommand: SlashCommand = {
  name: 'stats',
  altNames: ['usage'],
  get description() {
    return t('check session stats. Usage: /stats [model|tools]');
  },
  argumentHint: '[model|tools]',
  kind: CommandKind.BUILT_IN,
  supportedModes: ['interactive', 'non_interactive', 'acp'] as const,
  action: (context: CommandContext): MessageActionReturn | void => {
    const now = new Date();
    const { sessionStartTime } = context.session.stats;
    if (!sessionStartTime) {
      if (context.executionMode !== 'interactive') {
        return {
          type: 'message',
          messageType: 'error',
          content: t(
            'Session start time is unavailable, cannot calculate stats.',
          ),
        };
      }
      context.ui.addItem(
        {
          type: MessageType.ERROR,
          text: t('Session start time is unavailable, cannot calculate stats.'),
        },
        Date.now(),
      );
      return;
    }
    const wallDuration = now.getTime() - sessionStartTime.getTime();

    if (context.executionMode !== 'interactive') {
      const { promptCount, metrics } = context.session.stats;
      let totalPromptTokens = 0;
      let totalCandidateTokens = 0;
      let totalRequests = 0;
      for (const modelMetrics of Object.values(metrics.models)) {
        totalPromptTokens += modelMetrics.tokens.prompt;
        totalCandidateTokens += modelMetrics.tokens.candidates;
        totalRequests += modelMetrics.api.totalRequests;
      }
      return {
        type: 'message',
        messageType: 'info',
        content: [
          `Session duration: ${formatDuration(wallDuration)}`,
          `Prompts: ${promptCount}`,
          `API requests: ${totalRequests}`,
          `Tokens — prompt: ${totalPromptTokens}, output: ${totalCandidateTokens}`,
          `Tool calls: ${metrics.tools.totalCalls} (${metrics.tools.totalSuccess} ok, ${metrics.tools.totalFail} fail)`,
          `Files: +${metrics.files.totalLinesAdded} / -${metrics.files.totalLinesRemoved} lines`,
        ].join('\n'),
      };
    }

    const statsItem: HistoryItemStats = {
      type: MessageType.STATS,
      duration: formatDuration(wallDuration),
    };

    context.ui.addItem(statsItem, Date.now());
  },
  subCommands: [
    {
      name: 'model',
      get description() {
        return t('Show model-specific usage statistics.');
      },
      kind: CommandKind.BUILT_IN,
      supportedModes: ['interactive', 'non_interactive', 'acp'] as const,
      action: (context: CommandContext): MessageActionReturn | void => {
        if (context.executionMode !== 'interactive') {
          const { metrics } = context.session.stats;
          const pricing = context.services.settings.merged.modelPricing;
          const lines: string[] = [];
          for (const [modelName, modelMetrics] of Object.entries(
            metrics.models,
          )) {
            lines.push(
              `${modelName}: prompt=${modelMetrics.tokens.prompt}, output=${modelMetrics.tokens.candidates}, cached=${modelMetrics.tokens.cached}`,
            );
            const cost = calculateCost({
              inputTokens: modelMetrics.tokens.prompt,
              outputTokens:
                modelMetrics.tokens.candidates + modelMetrics.tokens.thoughts,
              pricing: pricing?.[modelName],
            });
            if (cost != null) {
              lines.push(`  Estimated cost: $${cost.toFixed(4)}`);
            }
          }
          if (lines.length === 0) {
            lines.push('No model usage data yet.');
          }
          return {
            type: 'message',
            messageType: 'info',
            content: lines.join('\n'),
          };
        }
        context.ui.addItem(
          {
            type: MessageType.MODEL_STATS,
          },
          Date.now(),
        );
      },
    },
    {
      name: 'tools',
      get description() {
        return t('Show tool-specific usage statistics.');
      },
      kind: CommandKind.BUILT_IN,
      supportedModes: ['interactive', 'non_interactive', 'acp'] as const,
      action: (context: CommandContext): MessageActionReturn | void => {
        if (context.executionMode !== 'interactive') {
          const { metrics } = context.session.stats;
          const { tools } = metrics;
          const toolNames = Object.keys(tools.byName);
          const content =
            toolNames.length > 0
              ? [
                  `Tool calls: ${tools.totalCalls} total (${tools.totalSuccess} ok, ${tools.totalFail} fail)`,
                  ...toolNames.map((name) => `  ${name}`),
                ].join('\n')
              : 'No tool usage data yet.';
          return { type: 'message', messageType: 'info', content };
        }
        context.ui.addItem(
          {
            type: MessageType.TOOL_STATS,
          },
          Date.now(),
        );
      },
    },
  ],
};
