/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Content } from '@google/genai';
import type { Config } from '../config/config.js';
import type { GeminiChat } from '../core/geminiChat.js';
import { type ChatCompressionInfo, CompressionStatus } from '../core/turn.js';
import { DEFAULT_TOKEN_LIMIT } from '../core/tokenLimits.js';
import { getCompressionPrompt } from '../core/prompts.js';
import { runSideQuery } from '../utils/sideQuery.js';
import { logChatCompression } from '../telemetry/loggers.js';
import { makeChatCompressionEvent } from '../telemetry/types.js';
import type { PermissionMode } from '../hooks/types.js';
import {
  SessionStartSource,
  PreCompactTrigger,
  PostCompactTrigger,
} from '../hooks/types.js';

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
 * Minimum fraction of history (by character count) that must be compressible
 * to proceed with a compression API call. Prevents futile calls where the
 * model receives almost no context and generates a useless summary.
 */
export const MIN_COMPRESSION_FRACTION = 0.05;

/**
 * When the trailing entry is an in-flight `model+functionCall` and the regular
 * scan finds no clean split past the target fraction, the splitter falls back
 * to compressing everything except the last few entries. This constant sets
 * how many most-recent complete `(model+functionCall, user+functionResponse)`
 * tool rounds are retained as working context (the trailing in-flight call is
 * always retained on top of these).
 */
export const TOOL_ROUND_RETAIN_COUNT = 2;

export type CompactTrigger = 'manual' | 'auto';

const hasFunctionCall = (content: Content | undefined): boolean =>
  !!content?.parts?.some((part) => !!part.functionCall);

const hasFunctionResponse = (content: Content | undefined): boolean =>
  !!content?.parts?.some((part) => !!part.functionResponse);

/**
 * Walk backward from the trailing in-flight `model+functionCall` and return
 * the index after which the most-recent `retainCount` complete tool-round
 * pairs sit (plus the trailing fc itself). Used by the splitter's in-flight
 * fallback path. Stops counting at the first non-pair encountered, so the
 * retain count is best-effort: if there are fewer complete pairs than
 * requested, all of them are retained.
 */
function splitPointRetainingTrailingPairs(
  contents: Content[],
  retainCount: number,
): number {
  let pairsFound = 0;
  let i = contents.length - 2;
  while (i >= 1 && pairsFound < retainCount) {
    if (hasFunctionCall(contents[i - 1]) && hasFunctionResponse(contents[i])) {
      pairsFound += 1;
      i -= 2;
    } else {
      break;
    }
  }
  return contents.length - (2 * pairsFound + 1);
}

/**
 * Returns the index of the oldest item to keep when compressing. May return
 * contents.length which indicates that everything should be compressed.
 *
 * The algorithm has two phases:
 *
 * 1. **Scan:** walk left-to-right looking for the first non-functionResponse
 *    user message that lands past `fraction` of total chars. That's the
 *    "clean" split — the kept slice starts with a fresh user prompt.
 *
 * 2. **Fallbacks** (no clean split found): the gate that gets us here has
 *    already decided we need to compress, so all three fallbacks bias toward
 *    *more* compression rather than less:
 *
 *    - last entry is `model` without functionCall → compress everything.
 *    - last entry is `user` with functionResponse → compress everything (the
 *      trailing tool round is complete; no orphans).
 *    - last entry is `model` with functionCall (in-flight) → compress
 *      everything except the trailing call plus the last `retainCount`
 *      complete tool rounds. The kept slice may start with `model+fc`;
 *      callers must inject a synthetic continuation user message between
 *      `summary_ack_model` and the kept slice to preserve role alternation.
 *
 * The pre-fallback returns of `lastSplitPoint` (compress less) only happen
 * for malformed histories that don't end in user/model.
 *
 * Exported for testing purposes.
 */
export function findCompressSplitPoint(
  contents: Content[],
  fraction: number,
  retainCount = TOOL_ROUND_RETAIN_COUNT,
): number {
  if (fraction <= 0 || fraction >= 1) {
    throw new Error('Fraction must be between 0 and 1');
  }

  const charCounts = contents.map((content) => JSON.stringify(content).length);
  const totalCharCount = charCounts.reduce((a, b) => a + b, 0);
  const targetCharCount = totalCharCount * fraction;

  let lastSplitPoint = 0;
  let cumulativeCharCount = 0;
  for (let i = 0; i < contents.length; i++) {
    const content = contents[i];
    if (content.role === 'user' && !hasFunctionResponse(content)) {
      if (cumulativeCharCount >= targetCharCount) {
        return i;
      }
      lastSplitPoint = i;
    }
    cumulativeCharCount += charCounts[i];
  }

  const lastContent = contents[contents.length - 1];
  if (lastContent?.role === 'model') {
    if (!hasFunctionCall(lastContent)) return contents.length;
    return splitPointRetainingTrailingPairs(contents, retainCount);
  }
  if (lastContent?.role === 'user' && hasFunctionResponse(lastContent)) {
    return contents.length;
  }
  return lastSplitPoint;
}

export interface CompressOptions {
  promptId: string;
  force: boolean;
  model: string;
  config: Config;
  /**
   * Whether a previous unforced compression attempt failed for this chat.
   * Suppresses auto-compaction; manual `/compress` (force=true) overrides.
   */
  hasFailedCompressionAttempt: boolean;
  /**
   * Most recent prompt token count for this chat. Compared against
   * `threshold * contextWindowSize` for the auto-compaction gate. Callers
   * source this from the per-chat counter (main session, subagents alike) —
   * the service does not read or write any global telemetry.
   */
  originalTokenCount: number;
  /**
   * Hook trigger to report for this compression. `force=true` bypasses the
   * threshold gate but does not always mean the user manually requested
   * compaction; reactive overflow recovery is forced but still automatic.
   */
  trigger?: CompactTrigger;
  signal?: AbortSignal;
}

export class ChatCompressionService {
  async compress(
    chat: GeminiChat,
    opts: CompressOptions,
  ): Promise<{ newHistory: Content[] | null; info: ChatCompressionInfo }> {
    const {
      promptId,
      force,
      model,
      config,
      hasFailedCompressionAttempt,
      originalTokenCount,
      trigger,
      signal,
    } = opts;
    const compactTrigger = trigger ?? (force ? 'manual' : 'auto');
    const threshold =
      config.getChatCompression()?.contextPercentageThreshold ??
      COMPRESSION_TOKEN_THRESHOLD;

    // Cheap gates first — these don't need the curated history.
    if (threshold <= 0 || (hasFailedCompressionAttempt && !force)) {
      return {
        newHistory: null,
        info: {
          originalTokenCount: 0,
          newTokenCount: 0,
          compressionStatus: CompressionStatus.NOOP,
        },
      };
    }

    // Don't compress if not forced and we are under the limit. This is the
    // steady-state path on every send; we want to exit before paying for the
    // full `getHistory(true)` clone below.
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

    const curatedHistory = chat.getHistory(true);
    if (curatedHistory.length === 0) {
      return {
        newHistory: null,
        info: {
          originalTokenCount: 0,
          newTokenCount: 0,
          compressionStatus: CompressionStatus.NOOP,
        },
      };
    }

    // Fire PreCompact hook before compression begins
    const hookSystem = config.getHookSystem();
    if (hookSystem) {
      const preCompactTrigger =
        compactTrigger === 'manual'
          ? PreCompactTrigger.Manual
          : PreCompactTrigger.Auto;
      try {
        await hookSystem.firePreCompactEvent(preCompactTrigger, '', signal);
      } catch (err) {
        config.getDebugLogger().warn(`PreCompact hook failed: ${err}`);
      }
    }

    // For manual /compress (force=true), if the last message is an orphaned model
    // funcCall (agent interrupted/crashed before the response arrived), strip it
    // before computing the split point. After stripping, the history ends cleanly
    // (typically with a user funcResponse) and findCompressSplitPoint handles it
    // through its normal logic — no special-casing needed.
    //
    // auto-compress (force=false) must NOT strip: it fires inside
    // sendMessageStream() before the matching funcResponse is pushed onto the
    // history, so the trailing funcCall is still active, not orphaned.
    const lastMessage = curatedHistory[curatedHistory.length - 1];
    const hasOrphanedFuncCall =
      force &&
      lastMessage?.role === 'model' &&
      lastMessage.parts?.some((p) => !!p.functionCall);
    const historyForSplit = hasOrphanedFuncCall
      ? curatedHistory.slice(0, -1)
      : curatedHistory;

    const splitPoint = findCompressSplitPoint(
      historyForSplit,
      1 - COMPRESSION_PRESERVE_THRESHOLD,
    );

    const historyToCompress = historyForSplit.slice(0, splitPoint);
    const historyToKeep = historyForSplit.slice(splitPoint);
    // The in-flight fallback path may produce a kept slice starting with
    // model+functionCall; the post-summary history needs a synthetic user
    // between the summary's model_ack and the kept entries.
    const keepNeedsContinuationBridge = historyToKeep[0]?.role === 'model';

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
    const totalCharCount = historyForSplit.reduce(
      (sum, c) => sum + JSON.stringify(c).length,
      0,
    );
    if (
      totalCharCount > 0 &&
      compressCharCount / totalCharCount < MIN_COMPRESSION_FRACTION
    ) {
      return {
        newHistory: null,
        info: {
          originalTokenCount,
          newTokenCount: originalTokenCount,
          compressionStatus: CompressionStatus.NOOP,
        },
      };
    }

    const summaryResult = await runSideQuery(config, {
      purpose: 'chat-compression',
      model,
      // Best-effort: failures fall back to NOOP and the next turn re-triggers
      // compression anyway, so don't burn 7 retries blocking the user mid-turn.
      maxAttempts: 1,
      systemInstruction: getCompressionPrompt(),
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
      // Compression quality drives every subsequent main turn — keep reasoning on.
      config: {
        thinkingConfig: { includeThoughts: true },
      },
      abortSignal: signal ?? new AbortController().signal,
      promptId,
    });
    const summary = summaryResult.text;
    const isSummaryEmpty = !summary || summary.trim().length === 0;
    const compressionUsageMetadata = summaryResult.usage;
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
        // When the kept slice starts with model+functionCall (because
        // tool-round absorption pulled the only fresh user message into
        // compress), inject a synthetic continuation prompt so the joined
        // history alternates correctly.
        ...(keepNeedsContinuationBridge
          ? [
              {
                role: 'user' as const,
                parts: [
                  {
                    text: 'Continue with the prior task using the context above.',
                  },
                ],
              },
            ]
          : []),
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

      // Fire PostCompact event after successful compression
      try {
        const postCompactTrigger =
          compactTrigger === 'manual'
            ? PostCompactTrigger.Manual
            : PostCompactTrigger.Auto;
        await config
          .getHookSystem()
          ?.firePostCompactEvent(postCompactTrigger, summary, signal);
      } catch (err) {
        config.getDebugLogger().warn(`PostCompact hook failed: ${err}`);
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
