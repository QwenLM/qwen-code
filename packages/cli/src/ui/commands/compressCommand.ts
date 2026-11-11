/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  CompressionStatus,
  QODER_PROVIDER_ID,
  type Config,
} from '@qwen-code/core';
import { MessageType, type HistoryItemCompression } from '../types.js';
import { CommandKind, type CommandContext, type SlashCommand } from './types.js';
import {
  COMPACT_NOOP_TEXT,
  getCompressionModelRequestFailureText,
} from '../../utils/compressionFailureText.js';

export interface CompactCommandHooks {
  isResourceExhausted?(context: CommandContext): Promise<boolean>;
  onResourceExhausted?(): void;
}

export function createCompactCommand(
  hooks: CompactCommandHooks = {},
): SlashCommand {
  return {
    name: 'compact',
    altNames: ['summarize', 'compress'],
    description: 'Compresses the context by replacing it with a summary',
    kind: CommandKind.BUILT_IN,
    autoExecute: true,
    action: async (context, args) => {
    const { ui } = context;
    if (ui.pendingItem) {
      ui.addItem(
        {
          type: MessageType.ERROR,
          text: 'Already compressing, wait for previous request to complete',
        },
        Date.now(),
      );
      return;
    }

    // In TUI, agentContext IS the Config object (Config implements AgentLoopContext)
    const config = context.services.agentContext as Config | null;
    if (!config || !context.messages || !context.setMessages) {
      ui.addItem(
        {
          type: MessageType.ERROR,
          text: 'Failed to compress: conversation not available.',
        },
        Date.now(),
      );
      return;
    }

    if (!context.runManualCompress) {
      ui.addItem(
        {
          type: MessageType.ERROR,
          text: 'Failed to compress: compaction is not available in this session.',
        },
        Date.now(),
      );
      return;
    }

    // Only refuse when there are truly no messages to compress
    if (context.messages.length === 0) {
      ui.addItem(
        {
          type: MessageType.INFO,
          text: 'No messages to compact.',
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

    try {
      ui.setPendingItem(pendingMessage);

      // Shared entry: runManualCompress runs the pipeline AND applies post-compact
      // recovery attachments (files / plan / invoked skills / plan_mode /
      // mcp + agent listing delta re-announcements), persists the summary
      // message + attachment chain to the transcript, and swaps runtime
      // messages to the extended history. This mirrors the agent-loop's
      // onCompressionCompleted hook so /compact and auto-compact produce
      // identical post-compact state. The pending item is an internal command
      // lock/input-availability marker; AppContainer excludes it from visible
      // history because lifecycle events drive the progress panel.
      const customInstructions = (args ?? '').trim() || undefined;
      const result = await context.runManualCompress(customInstructions);

      if (
        result.info.compressionStatus ===
        CompressionStatus.COMPRESSION_FAILED_PRECOMPACT_BLOCKED
      ) {
        ui.addItem(
          {
            type: MessageType.ERROR,
            text:
              result.info.blockReason ??
              'Compaction was blocked by a PreCompact hook.',
          },
          Date.now(),
        );
      } else if (result.newHistory) {
        // Success path: the orchestrator's `onCompactionPersisted` callback
        // has already pushed the final `Conversation compacted …` row after
        // the JSONL write succeeded. We just sync the React messages state.
        const newHistory = result.newHistory;
        context.setMessages(() => newHistory);
      } else {
        const { compressionStatus, originalTokenCount } = result.info;
        let text: string;
        switch (compressionStatus) {
          case CompressionStatus.COMPRESSION_FAILED_INFLATED_TOKEN_COUNT:
            text = `Conversation is too short to compress (${originalTokenCount} tokens). The summary would be larger than the original.`;
            break;
          case CompressionStatus.COMPRESSION_FAILED_MODEL_REQUEST:
            text = getCompressionModelRequestFailureText(result.info);
            if (result.info.failureReason === 'quota_exhausted') {
              hooks.onResourceExhausted?.();
            }
            break;
          case CompressionStatus.COMPRESSION_FAILED_EMPTY_SUMMARY: {
            const resourceExhausted =
              (await hooks.isResourceExhausted?.(context)) === true;
            if (resourceExhausted) {
              text = getCompressionModelRequestFailureText({
                failureReason: 'quota_exhausted',
                providerSource: QODER_PROVIDER_ID,
              });
              hooks.onResourceExhausted?.();
            } else {
              text =
                'Compression failed: the model returned an empty summary. Please try again.';
            }
            break;
          }
          case CompressionStatus.COMPRESSION_FAILED_TOKEN_COUNT_ERROR:
            text = 'Compression failed due to a token counting error.';
            break;
          case CompressionStatus.NOOP:
            text = COMPACT_NOOP_TEXT;
            break;
          default:
            text = `Compression returned no result (status=${compressionStatus}).`;
            break;
        }
        ui.addItem({ type: MessageType.INFO, text }, Date.now());
      }
    } catch (e) {
      ui.addItem(
        {
          type: MessageType.ERROR,
          text: `Failed to compress chat history (${context.messages.length} messages): ${
            e instanceof Error ? e.message : String(e)
          }`,
        },
        Date.now(),
      );
    } finally {
      ui.setPendingItem(null);
    }
  },
  };
}

export const compactCommand = createCompactCommand();
