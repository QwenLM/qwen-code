/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { HistoryItemContext } from '../types.js';
import { MessageType } from '../types.js';
import {
  type CommandContext,
  type SlashCommand,
  CommandKind,
} from './types.js';
import { t } from '../../i18n/index.js';
import { analyzeContextUsage } from '@qwen-code/qwen-code-core/utils/contextAnalysis.js';
import { getCoreSystemPrompt } from '@qwen-code/qwen-code-core/core/prompts.js';

export const contextCommand: SlashCommand = {
  name: 'context',
  altNames: ['ctx'],
  get description() {
    return t('View current conversation context usage');
  },
  kind: CommandKind.BUILT_IN,
  action: async (context: CommandContext) => {
    const { config } = context.system;

    if (!config) {
      context.ui.addItem(
        {
          type: MessageType.ERROR,
          text: t('Configuration is unavailable, cannot analyze context.'),
        },
        Date.now(),
      );
      return;
    }

    try {
      // 获取对话历史
      const chat = config.getChat();
      if (!chat) {
        context.ui.addItem(
          {
            type: MessageType.ERROR,
            text: t('Chat history is unavailable, cannot analyze context.'),
          },
          Date.now(),
        );
        return;
      }

      const history = chat.getHistory(true);
      const model = config.getModel();
      const sessionLimit = config.getSessionTokenLimit();
      const userMemory = config.getUserMemory();
      const systemPrompt = getCoreSystemPrompt(userMemory, model);
      const contentGenerator = config.getContentGenerator();

      // 分析上下文使用情况
      const contextInfo = await analyzeContextUsage(
        history,
        systemPrompt,
        model,
        contentGenerator,
        sessionLimit,
      );

      const contextItem: HistoryItemContext = {
        type: MessageType.CONTEXT,
        totalTokens: contextInfo.totalTokens,
        breakdown: contextInfo.breakdown,
        sessionLimit: contextInfo.sessionLimit,
        usagePercentage: contextInfo.usagePercentage,
        remainingTokens: contextInfo.remainingTokens,
        estimatedExchanges: contextInfo.estimatedExchanges,
      };

      context.ui.addItem(contextItem, Date.now());
    } catch (error) {
      context.ui.addItem(
        {
          type: MessageType.ERROR,
          text: t('Failed to analyze context: {error}', {
            error: error instanceof Error ? error.message : String(error),
          }),
        },
        Date.now(),
      );
    }
  },
};
