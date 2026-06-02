/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { HistoryItemCompression } from '../types.js';
import { MessageType } from '../types.js';
import type { SlashCommand } from './types.js';
import { CommandKind } from './types.js';
import { t } from '../../i18n/index.js';

// Cap user-supplied compression instructions. The compression side-query has
// no input-truncation retry today, so an unbounded instruction string would
// inflate the side-query prompt and risk a PTL the compaction path can't
// recover from. 2000 chars is generous for human-typed focus directives
// without exposing that failure mode.
const MAX_COMPRESS_INSTRUCTIONS_CHARS = 2000;

export const compressCommand: SlashCommand = {
  name: 'compress',
  altNames: ['summarize'],
  get description() {
    return t('Compresses the context by replacing it with a summary.');
  },
  kind: CommandKind.BUILT_IN,
  supportedModes: ['interactive', 'non_interactive', 'acp'] as const,
  action: async (context) => {
    const { ui } = context;
    const executionMode = context.executionMode ?? 'interactive';
    const abortSignal = context.abortSignal;

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
    const wasTruncated = rawArgs.length > MAX_COMPRESS_INSTRUCTIONS_CHARS;
    const customInstructions = rawArgs
      ? rawArgs.slice(0, MAX_COMPRESS_INSTRUCTIONS_CHARS)
      : undefined;
    // Surface the silent cap so a user pasting an over-long focus directive
    // knows their instructions were clipped mid-text rather than silently
    // changing the summary's behaviour.
    const truncationNotice = wasTruncated
      ? t('Compression instructions were truncated to {{max}} characters.', {
          max: String(MAX_COMPRESS_INSTRUCTIONS_CHARS),
        })
      : undefined;

    const doCompress = async () => {
      const promptId = `compress-${Date.now()}`;
      return await geminiClient.tryCompressChat(
        promptId,
        true,
        abortSignal,
        customInstructions,
      );
    };

    if (executionMode === 'acp') {
      const messages = async function* () {
        try {
          if (truncationNotice) {
            yield {
              messageType: 'info' as const,
              content: truncationNotice,
            };
          }
          yield {
            messageType: 'info' as const,
            content: 'Compressing context...',
          };
          const compressed = await doCompress();
          if (!compressed) {
            yield {
              messageType: 'error' as const,
              content: t('Failed to compress chat history.'),
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
        if (truncationNotice) {
          ui.addItem(
            { type: MessageType.INFO, text: truncationNotice },
            Date.now(),
          );
        }
        ui.setPendingItem(pendingMessage);
      }

      const compressed = await doCompress();

      if (abortSignal?.aborted) {
        return;
      }

      if (!compressed) {
        if (executionMode === 'interactive') {
          ui.addItem(
            {
              type: MessageType.ERROR,
              text: t('Failed to compress chat history.'),
            },
            Date.now(),
          );
          return;
        }

        return {
          type: 'message',
          messageType: 'error',
          content: t('Failed to compress chat history.'),
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
        content: `${truncationNotice ? `${truncationNotice} ` : ''}Context compressed (${compressed.originalTokenCount} -> ${compressed.newTokenCount}).`,
      };
    } catch (e) {
      // If cancelled via ESC, don't show error — cancelSlashCommand already handled UI
      if (abortSignal?.aborted) {
        return;
      }
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
