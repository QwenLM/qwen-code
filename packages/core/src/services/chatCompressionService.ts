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
import { getCompressionPrompt } from '../core/prompts.js';
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
  // In tool-heavy conversations, non-functionResponse user messages are rare.
  // Track positions after tool call completions (functionResponse) as fallback
  // split points, ensuring all function calls in the compressed portion have
  // matching responses.
  let lastToolCompletionSplitPoint = 0;
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
    // After a functionResponse, all preceding function calls are properly
    // paired, making the next position (i+1) a safe place to split.
    if (
      content.role === 'user' &&
      content.parts?.some((part) => !!part.functionResponse)
    ) {
      lastToolCompletionSplitPoint = i + 1;
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
  // Also safe to compress everything if the last message completes a tool call
  // sequence (all function calls have matching responses).
  if (
    lastContent?.role === 'user' &&
    lastContent?.parts?.some((part) => !!part.functionResponse)
  ) {
    return contents.length;
  }

  // Use the split point that provides the most content to compress.
  // In tool-heavy conversations with few user queries, lastSplitPoint may be
  // near the beginning of the history while lastToolCompletionSplitPoint
  // provides much better coverage.
  return Math.max(lastSplitPoint, lastToolCompletionSplitPoint);
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

    // Guard: if historyToCompress is too small relative to the total history,
    // skip compression. This prevents futile API calls where the model receives
    // almost no context and generates a useless "summary" that inflates tokens.
    const compressCharCount = historyToCompress.reduce(
      (sum, c) => sum + JSON.stringify(c).length,
      0,
    );
    const totalCharCount = curatedHistory.reduce(
      (sum, c) => sum + JSON.stringify(c).length,
      0,
    );
    if (totalCharCount > 0 && compressCharCount / totalCharCount < 0.05) {
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
    const isSummaryEmpty = !summary || summary.trim().length === 0;
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

    let newTokenCount = originalTokenCount;
    let extraHistory: Content[] = [];
    let canCalculateNewTokenCount = false;

    if (!isSummaryEmpty) {
      extraHistory = [
        {
          role: 'user',
          parts: [{ text: summary }],
        },
        {
          role: 'model',
          parts: [{ text: 'Got it. Thanks for the additional context!' }],
        },
        ...historyToKeep,
      ];

      // Best-effort token math using *only* model-reported token counts.
      //
      // Note: compressionInputTokenCount includes the compression prompt and
      // the extra "reason in your scratchpad" instruction(approx. 1000 tokens), and
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
        newHistory: extraHistory,
        info: {
          originalTokenCount,
          newTokenCount,
          compressionStatus: CompressionStatus.COMPRESSED,
        },
      };
    }
  }
}
