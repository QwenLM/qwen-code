/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Content } from '@google/genai';
import type { Config } from '../config/config.js';
import type { GeminiChat } from '../core/geminiChat.js';
import { type ChatCompressionInfo, CompressionStatus } from '../core/turn.js';
import { uiTelemetryService } from '../telemetry/uiTelemetry.js';
import { DEFAULT_TOKEN_LIMIT } from '../core/tokenLimits.js';
import {
  getCompressionPrompt,
  getIncrementalCompressionPrompt,
} from '../core/prompts.js';
import { getResponseText } from '../utils/partUtils.js';
import { logChatCompression } from '../telemetry/loggers.js';
import { makeChatCompressionEvent } from '../telemetry/types.js';
import type { PermissionMode } from '../hooks/types.js';
import { SessionStartSource, PreCompactTrigger } from '../hooks/types.js';

/**
 * Threshold for compression token count as a fraction of the model's token limit.
 * If the chat history exceeds this threshold, it will be compressed.
 */
export const COMPRESSION_TOKEN_THRESHOLD = 0.7;

/**
 * The fraction of the latest chat history to keep. A value of 0.3
 * means that only the last 30% of the chat history will be kept after compression.
 */
export const COMPRESSION_PRESERVE_THRESHOLD = 0.3;

/**
 * Number of most-recent messages that are protected from compression.
 * These tail messages are never compressed, preserving immediate context.
 */
export const INCREMENTAL_PROTECTED_TAIL = 10;

/**
 * Maximum number of messages to compress in a single incremental chunk.
 */
export const INCREMENTAL_MAX_CHUNK_SIZE = 20;

/**
 * Prefix that marks a message as already compressed.
 * Messages starting with this prefix are skipped during incremental compression.
 */
export const COMPRESSED_CONTEXT_PREFIX = '[COMPRESSED_CONTEXT]';

/**
 * Extracts the text content from a Content object.
 * Returns the concatenated text of all text parts, or null if none exist.
 */
export function extractContentText(content: Content): string | null {
  if (!content.parts || content.parts.length === 0) {
    return null;
  }
  const texts = content.parts
    .filter((part) => part.text !== undefined)
    .map((part) => part.text);
  if (texts.length === 0) {
    return null;
  }
  return texts.join('');
}

/**
 * Returns true if a Content message is an already-compressed summary.
 */
export function isCompressedMessage(content: Content): boolean {
  const text = extractContentText(content);
  return text !== null && text.startsWith(COMPRESSED_CONTEXT_PREFIX);
}

/**
 * Returns the index of the oldest item to keep when compressing. May return
 * contents.length which indicates that everything should be compressed.
 *
 * Exported for testing purposes.
 */
export function findCompressSplitPoint(
  contents: Content[],
  fraction: number,
): number {
  if (fraction <= 0 || fraction >= 1) {
    throw new Error('Fraction must be between 0 and 1');
  }

  const charCounts = contents.map((content) => JSON.stringify(content).length);
  const totalCharCount = charCounts.reduce((a, b) => a + b, 0);
  const targetCharCount = totalCharCount * fraction;

  let lastSplitPoint = 0; // 0 is always valid (compress nothing)
  let cumulativeCharCount = 0;
  for (let i = 0; i < contents.length; i++) {
    const content = contents[i];
    if (
      content.role === 'user' &&
      !content.parts?.some((part) => !!part.functionResponse)
    ) {
      if (cumulativeCharCount >= targetCharCount) {
        return i;
      }
      lastSplitPoint = i;
    }
    cumulativeCharCount += charCounts[i];
  }

  // We found no split points after targetCharCount.
  // Check if it's safe to compress everything.
  const lastContent = contents[contents.length - 1];
  if (
    lastContent?.role === 'model' &&
    !lastContent?.parts?.some((part) => part.functionCall)
  ) {
    return contents.length;
  }

  // Can't compress everything so just compress at last splitpoint.
  return lastSplitPoint;
}

export class ChatCompressionService {
  async compress(
    chat: GeminiChat,
    promptId: string,
    force: boolean,
    model: string,
    config: Config,
    hasFailedCompressionAttempt: boolean,
    signal?: AbortSignal,
  ): Promise<{ newHistory: Content[] | null; info: ChatCompressionInfo }> {
    const curatedHistory = chat.getHistory(true);
    const threshold =
      config.getChatCompression()?.contextPercentageThreshold ??
      COMPRESSION_TOKEN_THRESHOLD;

    // Regardless of `force`, don't do anything if the history is empty.
    if (
      curatedHistory.length === 0 ||
      threshold <= 0 ||
      (hasFailedCompressionAttempt && !force)
    ) {
      return {
        newHistory: null,
        info: {
          originalTokenCount: 0,
          newTokenCount: 0,
          compressionStatus: CompressionStatus.NOOP,
        },
      };
    }

    const originalTokenCount = uiTelemetryService.getLastPromptTokenCount();

    // Don't compress if not forced and we are under the limit.
    if (!force) {
      const contextLimit =
        config.getContentGeneratorConfig()?.contextWindowSize ??
        DEFAULT_TOKEN_LIMIT;
      if (originalTokenCount < threshold * contextLimit) {
        return {
          newHistory: null,
          info: {
            originalTokenCount,
            newTokenCount: originalTokenCount,
            compressionStatus: CompressionStatus.NOOP,
          },
        };
      }
    }

    // Fire PreCompact hook before compression begins
    const hookSystem = config.getHookSystem();
    if (hookSystem) {
      const trigger = force ? PreCompactTrigger.Manual : PreCompactTrigger.Auto;
      try {
        await hookSystem.firePreCompactEvent(trigger, '', signal);
      } catch (err) {
        config.getDebugLogger().warn(`PreCompact hook failed: ${err}`);
      }
    }

    // Try incremental compression first
    const incrementalResult = await this.compressIncremental(
      curatedHistory,
      model,
      config,
      promptId,
      signal,
    );

    if (incrementalResult.compressed) {
      // Incremental compression succeeded — use the new history
      return this.finalizeCompression(
        incrementalResult.newHistory,
        originalTokenCount,
        incrementalResult.compressionInputTokenCount,
        incrementalResult.compressionOutputTokenCount,
        model,
        config,
        signal,
      );
    }

    // Fallback: not enough messages for incremental compression,
    // use the original full-history compression approach.
    return this.compressFull(
      curatedHistory,
      originalTokenCount,
      model,
      config,
      promptId,
      signal,
    );
  }

  /**
   * Incremental compression: protects the most recent messages and compresses
   * the oldest uncompressed chunk. Each call compresses one chunk, making the
   * operation idempotent and safe to call repeatedly.
   */
  private async compressIncremental(
    history: Content[],
    model: string,
    config: Config,
    promptId: string,
    _signal?: AbortSignal,
  ): Promise<{
    newHistory: Content[];
    compressed: boolean;
    compressionInputTokenCount?: number;
    compressionOutputTokenCount?: number;
  }> {
    const protectedTailMessages = INCREMENTAL_PROTECTED_TAIL;
    const maxChunkSize = INCREMENTAL_MAX_CHUNK_SIZE;

    // Not enough messages to use incremental compression —
    // need at least protected tail + 2 compressible messages.
    if (history.length <= protectedTailMessages + 2) {
      return { newHistory: history, compressed: false };
    }

    // Find the boundary: everything before this index is a candidate for compression
    const compressibleEnd = history.length - protectedTailMessages;

    // Skip already-compressed messages at the start
    let chunkStart = 0;
    while (chunkStart < compressibleEnd) {
      if (isCompressedMessage(history[chunkStart])) {
        chunkStart++;
      } else {
        break;
      }
    }

    // Nothing left to compress in the compressible region
    if (chunkStart >= compressibleEnd) {
      return { newHistory: history, compressed: false };
    }

    const chunkEnd = Math.min(chunkStart + maxChunkSize, compressibleEnd);
    const chunk = history.slice(chunkStart, chunkEnd);

    // Compress the chunk via model
    const summaryResponse = await config.getContentGenerator().generateContent(
      {
        model,
        contents: [
          ...chunk,
          {
            role: 'user',
            parts: [
              {
                text: 'Compress the conversation chunk above into a dense summary following the output format.',
              },
            ],
          },
        ],
        config: {
          systemInstruction: getIncrementalCompressionPrompt(),
        },
      },
      promptId,
    );

    const summary = getResponseText(summaryResponse) ?? '';
    if (!summary || summary.trim().length === 0) {
      return { newHistory: history, compressed: false };
    }

    // Ensure the summary has the compressed context prefix
    const prefixedSummary = summary.startsWith(COMPRESSED_CONTEXT_PREFIX)
      ? summary
      : `${COMPRESSED_CONTEXT_PREFIX}\n${summary}`;

    const usageMetadata = summaryResponse.usageMetadata;
    const inputTokenCount = usageMetadata?.promptTokenCount;
    let outputTokenCount = usageMetadata?.candidatesTokenCount;
    if (
      outputTokenCount === undefined &&
      typeof usageMetadata?.totalTokenCount === 'number' &&
      typeof inputTokenCount === 'number'
    ) {
      outputTokenCount = Math.max(
        0,
        usageMetadata.totalTokenCount - inputTokenCount,
      );
    }

    // Rebuild history: [already compressed] + [new summary] + [remaining uncompressed] + [protected tail]
    const summaryMessage: Content = {
      role: 'user',
      parts: [{ text: prefixedSummary }],
    };
    const summaryAck: Content = {
      role: 'model',
      parts: [{ text: 'Understood. Incremental context loaded.' }],
    };

    const newHistory: Content[] = [
      ...history.slice(0, chunkStart),
      summaryMessage,
      summaryAck,
      ...history.slice(chunkEnd),
    ];

    return {
      newHistory,
      compressed: true,
      compressionInputTokenCount: inputTokenCount,
      compressionOutputTokenCount: outputTokenCount,
    };
  }

  /**
   * Original full-history compression using getCompressionPrompt().
   * Used as a fallback when history is too short for incremental compression.
   */
  private async compressFull(
    curatedHistory: Content[],
    originalTokenCount: number,
    model: string,
    config: Config,
    promptId: string,
    signal?: AbortSignal,
  ): Promise<{ newHistory: Content[] | null; info: ChatCompressionInfo }> {
    const splitPoint = findCompressSplitPoint(
      curatedHistory,
      1 - COMPRESSION_PRESERVE_THRESHOLD,
    );

    const historyToCompress = curatedHistory.slice(0, splitPoint);
    const historyToKeep = curatedHistory.slice(splitPoint);

    if (historyToCompress.length === 0) {
      return {
        newHistory: null,
        info: {
          originalTokenCount,
          newTokenCount: originalTokenCount,
          compressionStatus: CompressionStatus.NOOP,
        },
      };
    }

    const summaryResponse = await config.getContentGenerator().generateContent(
      {
        model,
        contents: [
          ...historyToCompress,
          {
            role: 'user',
            parts: [
              {
                text: 'First, reason in your scratchpad. Then, generate the <state_snapshot>.',
              },
            ],
          },
        ],
        config: {
          systemInstruction: getCompressionPrompt(),
        },
      },
      promptId,
    );

    const summary = getResponseText(summaryResponse) ?? '';

    // Prefix full compression summaries so they are also recognized as compressed
    const prefixedSummary =
      summary && summary.trim().length > 0
        ? summary.startsWith(COMPRESSED_CONTEXT_PREFIX)
          ? summary
          : `${COMPRESSED_CONTEXT_PREFIX}\n${summary}`
        : summary;

    const compressionUsageMetadata = summaryResponse.usageMetadata;
    const compressionInputTokenCount =
      compressionUsageMetadata?.promptTokenCount;
    let compressionOutputTokenCount =
      compressionUsageMetadata?.candidatesTokenCount;
    if (
      compressionOutputTokenCount === undefined &&
      typeof compressionUsageMetadata?.totalTokenCount === 'number' &&
      typeof compressionInputTokenCount === 'number'
    ) {
      compressionOutputTokenCount = Math.max(
        0,
        compressionUsageMetadata.totalTokenCount - compressionInputTokenCount,
      );
    }

    const isSummaryEmpty =
      !prefixedSummary || prefixedSummary.trim().length === 0;

    let extraHistory: Content[] = [];
    if (!isSummaryEmpty) {
      extraHistory = [
        {
          role: 'user',
          parts: [{ text: prefixedSummary }],
        },
        {
          role: 'model',
          parts: [{ text: 'Got it. Thanks for the additional context!' }],
        },
        ...historyToKeep,
      ];
    }

    return this.finalizeCompression(
      isSummaryEmpty ? null : extraHistory,
      originalTokenCount,
      compressionInputTokenCount,
      compressionOutputTokenCount,
      model,
      config,
      signal,
      isSummaryEmpty,
    );
  }

  /**
   * Shared finalization logic for both incremental and full compression.
   * Handles token math, telemetry, hook firing, and status determination.
   */
  private async finalizeCompression(
    newHistory: Content[] | null,
    originalTokenCount: number,
    compressionInputTokenCount: number | undefined,
    compressionOutputTokenCount: number | undefined,
    model: string,
    config: Config,
    signal?: AbortSignal,
    isSummaryEmpty: boolean = false,
  ): Promise<{ newHistory: Content[] | null; info: ChatCompressionInfo }> {
    let newTokenCount = originalTokenCount;
    let canCalculateNewTokenCount = false;

    if (!isSummaryEmpty && newHistory) {
      // Best-effort token math using *only* model-reported token counts.
      //
      // Note: compressionInputTokenCount includes the compression prompt and
      // the extra instruction (approx. 1000 tokens), and
      // compressionOutputTokenCount may include non-persisted tokens (thoughts).
      // We accept these inaccuracies to avoid local token estimation.
      if (
        typeof compressionInputTokenCount === 'number' &&
        compressionInputTokenCount > 0 &&
        typeof compressionOutputTokenCount === 'number' &&
        compressionOutputTokenCount > 0
      ) {
        canCalculateNewTokenCount = true;
        newTokenCount = Math.max(
          0,
          originalTokenCount -
            (compressionInputTokenCount - 1000) +
            compressionOutputTokenCount,
        );
      }
    }

    logChatCompression(
      config,
      makeChatCompressionEvent({
        tokens_before: originalTokenCount,
        tokens_after: newTokenCount,
        compression_input_token_count: compressionInputTokenCount,
        compression_output_token_count: compressionOutputTokenCount,
      }),
    );

    if (isSummaryEmpty) {
      return {
        newHistory: null,
        info: {
          originalTokenCount,
          newTokenCount: originalTokenCount,
          compressionStatus: CompressionStatus.COMPRESSION_FAILED_EMPTY_SUMMARY,
        },
      };
    } else if (!canCalculateNewTokenCount) {
      return {
        newHistory: null,
        info: {
          originalTokenCount,
          newTokenCount: originalTokenCount,
          compressionStatus:
            CompressionStatus.COMPRESSION_FAILED_TOKEN_COUNT_ERROR,
        },
      };
    } else if (newTokenCount > originalTokenCount) {
      return {
        newHistory: null,
        info: {
          originalTokenCount,
          newTokenCount,
          compressionStatus:
            CompressionStatus.COMPRESSION_FAILED_INFLATED_TOKEN_COUNT,
        },
      };
    } else {
      uiTelemetryService.setLastPromptTokenCount(newTokenCount);

      // Fire SessionStart event after successful compression
      try {
        const permissionMode = String(
          config.getApprovalMode(),
        ) as PermissionMode;
        await config
          .getHookSystem()
          ?.fireSessionStartEvent(
            SessionStartSource.Compact,
            model ?? '',
            permissionMode,
            undefined,
            signal,
          );
      } catch (err) {
        config.getDebugLogger().warn(`SessionStart hook failed: ${err}`);
      }

      return {
        newHistory,
        info: {
          originalTokenCount,
          newTokenCount,
          compressionStatus: CompressionStatus.COMPRESSED,
        },
      };
    }
  }
}
