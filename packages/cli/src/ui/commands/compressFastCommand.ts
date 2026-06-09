/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { HistoryItemCompression } from '../types.js';
import { MessageType } from '../types.js';
import type { SlashCommand } from './types.js';
import { CommandKind } from './types.js';
import { t } from '../../i18n/index.js';

export const compressFastCommand: SlashCommand = {
  name: 'compress-fast',
  get description() {
    return t(
      'Fast context compression (no AI). ' +
        '--tool-calls: strip tool outputs & thinking. ' +
        '--keep-last: keep only last reply.',
    );
  },
  kind: CommandKind.BUILT_IN,
  supportedModes: ['interactive', 'non_interactive', 'acp'] as const,
  argumentHint: '[--tool-calls|--keep-last]',
  examples: [
    '/compress-fast',
    '/compress-fast --tool-calls',
    '/compress-fast --keep-last',
  ],
  action: async (context) => {
    const { ui } = context;
    const executionMode = context.executionMode ?? 'interactive';

    if (executionMode === 'interactive' && ui.pendingItem) {
      ui.addItem(
        {
          type: MessageType.ERROR,
          text: t('Already compressing, wait for previous request to complete'),
        },
        Date.now(),
      );
      return;
    }

    const pendingMessage: HistoryItemCompression = {
      type: MessageType.COMPRESSION,
      compression: {
        isPending: true,
        originalTokenCount: null,
        newTokenCount: null,
        compressionStatus: null,
      },
    };

    const config = context.services.config;
    const geminiClient = config?.getGeminiClient();
    if (!config || !geminiClient) {
      return {
        type: 'message',
        messageType: 'error',
        content: t('Config not loaded.'),
      };
    }

    const rawArgs = context.invocation?.args?.trim() ?? '';
    const mode: 'tool-calls' | 'keep-last' = rawArgs.includes('--keep-last')
      ? 'keep-last'
      : 'tool-calls';

    const doCompress = async () => await geminiClient.tryCompressChatFast(mode);

    if (executionMode === 'acp') {
      const messages = async function* () {
        try {
          yield {
            messageType: 'info' as const,
            content: `Compressing context (fast, mode: ${mode})...`,
          };
          const compressed = await doCompress();
          if (
            !compressed ||
            compressed.originalTokenCount === compressed.newTokenCount
          ) {
            yield {
              messageType: 'info' as const,
              content: t('No compression needed.'),
            };
            return;
          }
          yield {
            messageType: 'info' as const,
            content: `Context compressed (${compressed.originalTokenCount} -> ${compressed.newTokenCount}).`,
          };
        } catch (e) {
          yield {
            messageType: 'error' as const,
            content: t('Failed to compress chat history: {{error}}', {
              error: e instanceof Error ? e.message : String(e),
            }),
          };
        }
      };

      return { type: 'stream_messages', messages: messages() };
    }

    try {
      if (executionMode === 'interactive') {
        ui.setPendingItem(pendingMessage);
      }

      const compressed = await doCompress();

      if (
        !compressed ||
        compressed.originalTokenCount === compressed.newTokenCount
      ) {
        if (executionMode === 'interactive') {
          ui.addItem(
            {
              type: MessageType.INFO,
              text: t('No compression needed.'),
            },
            Date.now(),
          );
          return;
        }

        return {
          type: 'message',
          messageType: 'info',
          content: t('No compression needed.'),
        };
      }

      if (executionMode === 'interactive') {
        ui.addItem(
          {
            type: MessageType.COMPRESSION,
            compression: {
              isPending: false,
              originalTokenCount: compressed.originalTokenCount,
              newTokenCount: compressed.newTokenCount,
              compressionStatus: compressed.compressionStatus,
            },
          } as HistoryItemCompression,
          Date.now(),
        );
        return;
      }

      return {
        type: 'message',
        messageType: 'info',
        content: `Context compressed (${compressed.originalTokenCount} -> ${compressed.newTokenCount}).`,
      };
    } catch (e) {
      if (executionMode === 'interactive') {
        ui.addItem(
          {
            type: MessageType.ERROR,
            text: t('Failed to compress chat history: {{error}}', {
              error: e instanceof Error ? e.message : String(e),
            }),
          },
          Date.now(),
        );
        return;
      }

      return {
        type: 'message',
        messageType: 'error',
        content: t('Failed to compress chat history: {{error}}', {
          error: e instanceof Error ? e.message : String(e),
        }),
      };
    } finally {
      if (executionMode === 'interactive') {
        ui.setPendingItem(null);
      }
    }
  },
};
