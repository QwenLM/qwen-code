/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { MessageType } from '../types.js';
import { formatDuration } from '../utils/formatters.js';
import {
  type CommandContext,
  type SlashCommand,
  type MessageActionReturn,
  type OpenDialogActionReturn,
  CommandKind,
} from './types.js';
import { t } from '../../i18n/index.js';
import { calculateCost } from '../../utils/costCalculator.js';

export const statsCommand: SlashCommand = {
  name: 'stats',
  altNames: ['usage'],
  get description() {
    return t('Show usage statistics dashboard.');
  },
  kind: CommandKind.BUILT_IN,
  supportedModes: ['interactive', 'non_interactive', 'acp'] as const,
  action: (
    context: CommandContext,
  ): OpenDialogActionReturn | MessageActionReturn | void => {
    if (context.executionMode !== 'interactive') {
      const now = new Date();
      const { sessionStartTime, promptCount, metrics } = context.session.stats;
      const wallDuration = sessionStartTime
        ? now.getTime() - sessionStartTime.getTime()
        : 0;
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
          t('Session duration: {{duration}}', {
            duration: formatDuration(wallDuration),
          }),
          t('Prompts: {{count}}', { count: String(promptCount) }),
          t('API requests: {{count}}', { count: String(totalRequests) }),
          t('Tokens — prompt: {{prompt}}, output: {{output}}', {
            prompt: String(totalPromptTokens),
            output: String(totalCandidateTokens),
          }),
          t('Tool calls: {{total}} ({{success}} ok, {{fail}} fail)', {
            total: String(metrics.tools.totalCalls),
            success: String(metrics.tools.totalSuccess),
            fail: String(metrics.tools.totalFail),
          }),
          t('Files: +{{added}} / -{{removed}} lines', {
            added: String(metrics.files.totalLinesAdded),
            removed: String(metrics.files.totalLinesRemoved),
          }),
        ].join('\n'),
      };
    }

    return { type: 'dialog', dialog: 'stats' };
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
              `${modelName}: ${t('prompt')}=${modelMetrics.tokens.prompt}, ${t('output')}=${modelMetrics.tokens.candidates}, ${t('cached')}=${modelMetrics.tokens.cached}`,
            );
            const cost = calculateCost({
              inputTokens: modelMetrics.tokens.prompt,
              outputTokens:
                modelMetrics.tokens.candidates + modelMetrics.tokens.thoughts,
              pricing: pricing?.[modelName],
            });
            if (cost != null) {
              lines.push(
                `  ${t('Estimated cost: ${{cost}}', { cost: cost.toFixed(4) })}`,
              );
            }
          }
          if (lines.length === 0) {
            lines.push(t('No model usage data yet.'));
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
                  t('Tool calls: {{total}} ({{success}} ok, {{fail}} fail)', {
                    total: String(tools.totalCalls),
                    success: String(tools.totalSuccess),
                    fail: String(tools.totalFail),
                  }),
                  ...toolNames.map((name) => `  ${name}`),
                ].join('\n')
              : t('No tool usage data yet.');
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
