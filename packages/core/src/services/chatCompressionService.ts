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
import { PreCompactTrigger, PostCompactTrigger } from '../hooks/types.js';
import {
  resolveSlimmingConfig,
  slimCompactionInput,
} from './compactionInputSlimming.js';
import { estimatePromptTokens } from './tokenEstimation.js';
import { composePostCompactHistory } from './postCompactAttachments.js';

/**
 * Hard cap on the compression sideQuery output (summary text only, since
 * thinking is disabled). Mirrors claude-code's MAX_OUTPUT_TOKENS_FOR_SUMMARY
 * (autoCompact.ts:30) which is based on p99.99 of real compaction outputs.
 */
export const COMPACT_MAX_OUTPUT_TOKENS = 20_000;

/**
 * Default proportional auto-compaction threshold. Used as a small-window
 * fallback / safety net inside computeThresholds — when the window is so
 * small that the absolute branch becomes degenerate, the proportional
 * branch keeps the trigger usable.
 */
export const DEFAULT_PCT = 0.7;

/**
 * Offset from DEFAULT_PCT used to position the warn tier proportionally
 * (warn-pct = 0.7 - 0.1 = 0.6). Three-tier ladder makes warn fire
 * meaningfully before auto on small windows where the absolute formula
 * would otherwise compress warn flush against auto.
 */
export const WARN_PCT_OFFSET = 0.1;

/**
 * Token budget reserved from the window for compression output. Matches
 * COMPACT_MAX_OUTPUT_TOKENS because thinking is disabled (see Task 1) and
 * maxOutputTokens is therefore the hard ceiling on total summary output.
 */
export const SUMMARY_RESERVE = COMPACT_MAX_OUTPUT_TOKENS; // 20_000

/**
 * Distance between auto threshold and effectiveWindow. Matches claude-code's
 * AUTOCOMPACT_BUFFER_TOKENS (autoCompact.ts:62) — empirically chosen to leave
 * headroom for the compaction sideQuery round-trip plus a few user-message
 * turns before the window saturates.
 */
export const AUTOCOMPACT_BUFFER = 13_000;

/**
 * Distance between warn threshold and auto threshold. Matches claude-code's
 * WARNING_THRESHOLD_BUFFER_TOKENS (autoCompact.ts:63) — sized so the warn
 * tier fires a couple of turns before auto-compaction in practice.
 */
export const WARN_BUFFER = 20_000;

/** Distance between hard threshold and effectiveWindow (matches claude-code's MANUAL_COMPACT_BUFFER). */
export const HARD_BUFFER = 3_000;

/**
 * Auto-compaction consecutive-failure circuit breaker. After this many
 * consecutive failures the cheap-gate NOOPs until a successful force
 * compress resets the counter. Co-located here with other compaction-
 * tuning constants; the counter state itself lives on GeminiChat.
 */
export const MAX_CONSECUTIVE_FAILURES = 3;

export interface CompactionThresholds {
  /** Token count at which UI warn tier triggers. */
  readonly warn: number;
  /** Token count at which auto-compaction triggers. */
  readonly auto: number;
  /** Token count at which auto-compaction is force-triggered (bypasses the consecutive-failure breaker). */
  readonly hard: number;
  /** Window minus SUMMARY_RESERVE; the budget available for input + summary. */
  readonly effectiveWindow: number;
}

/**
 * Compute the three-tier threshold ladder for a given context window.
 *
 * Each tier is `max(proportional, absolute)`:
 *   auto = max(DEFAULT_PCT * window,                       effectiveWindow - AUTOCOMPACT_BUFFER)
 *   warn = max((DEFAULT_PCT - WARN_PCT_OFFSET) * window,   auto - WARN_BUFFER)
 *   hard = max(effectiveWindow - HARD_BUFFER,              auto)   // hard degrades to auto for tiny windows
 *
 * Small windows (where the absolute branch goes negative) automatically
 * fall back to the proportional branch. Large windows are dominated by
 * the absolute branch, capping wasted reservation to ~33K instead of 30%
 * of the window.
 *
 * Pure function — no I/O, no shared state — safe to call repeatedly.
 */
export function computeThresholds(window: number): CompactionThresholds {
  // Clamp to 0 for tiny windows (window < SUMMARY_RESERVE) so the surfaced
  // value in `/context` stays meaningful. The Math.max guards on auto/warn/hard
  // below absorb the floor — clamping does not shift those outputs because
  // each is `max(proportional, absolute)` and the proportional branch
  // dominates whenever the absolute branch goes negative.
  const effectiveWindow = Math.max(0, window - SUMMARY_RESERVE);

  const absAuto = effectiveWindow - AUTOCOMPACT_BUFFER;
  const auto = Math.max(DEFAULT_PCT * window, absAuto);

  const absWarn = auto - WARN_BUFFER;
  const warn = Math.max((DEFAULT_PCT - WARN_PCT_OFFSET) * window, absWarn);

  const rawHard = effectiveWindow - HARD_BUFFER;
  const hard = Math.max(rawHard, auto);

  return { warn, auto, hard, effectiveWindow };
}

export type CompactTrigger = 'manual' | 'auto';

export interface CompressOptions {
  promptId: string;
  force: boolean;
  model: string;
  config: Config;
  /**
   * Number of consecutive auto-compaction failures for this chat. When it reaches
   * MAX_CONSECUTIVE_FAILURES, the cheap-gate stops trying until a successful
   * force=true call resets it.
   */
  consecutiveFailures: number;
  /**
   * Most recent prompt token count for this chat. Compared against
   * `computeThresholds(contextWindowSize).auto` for the auto-compaction
   * gate, optionally augmented by the pending user message's estimated
   * token count via `estimatePromptTokens` (see Task 3 / Task 6). Callers
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
  /**
   * Pending user message about to be sent. When present, the cheap-gate
   * adds its estimated token count to `originalTokenCount` (which reflects
   * only the prior turn's API usage) so the gate sees the real prompt size.
   * Optional for backward compatibility with callers that don't have a
   * user message in hand (e.g. manual /compress force=true paths).
   */
  pendingUserMessage?: Content;
  /**
   * Pre-computed effective-token count from `estimatePromptTokens()`. When
   * provided, the cheap-gate skips its own estimation pass (and the
   * accompanying `chat.getHistoryShallow(true)` clone). Callers that already
   * computed this value upstream — primarily `sendMessageStream` for the
   * hard-tier rescue — pass it through to avoid duplicate work.
   * (review #4168 R1.3 / R1.4)
   */
  precomputedEffectiveTokens?: number;
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
      consecutiveFailures,
      originalTokenCount,
      trigger,
      signal,
    } = opts;
    const compactTrigger = trigger ?? (force ? 'manual' : 'auto');
    const chatCompressionSettings = config.getChatCompression();
    const slimmingConfig = resolveSlimmingConfig(chatCompressionSettings);

    // Cheap gates first — these don't need the curated history. Forward
    // originalTokenCount on NOOP (matching the threshold-gate branch below)
    // so telemetry consumers can distinguish "breaker tripped at N tokens"
    // from "session has zero tokens".
    if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES && !force) {
      return {
        newHistory: null,
        info: {
          originalTokenCount,
          newTokenCount: originalTokenCount,
          compressionStatus: CompressionStatus.NOOP,
        },
      };
    }

    if (!force) {
      const contextLimit =
        config.getContentGeneratorConfig()?.contextWindowSize ??
        DEFAULT_TOKEN_LIMIT;
      const { auto } = computeThresholds(contextLimit);
      // Order of preference for the effective-token estimate:
      //   1. Caller already computed it (sendMessageStream hard-tier rescue)
      //   2. Compute it here from history + pending user message
      //   3. Fall back to the raw API-reported count
      // Path 1 avoids a second `getHistoryShallow(true)` clone per send when
      // sendMessageStream already paid for one. (R1.3 / R1.4)
      const pendingUserMessage = opts.pendingUserMessage;
      const effectiveTokens =
        opts.precomputedEffectiveTokens !== undefined
          ? opts.precomputedEffectiveTokens
          : pendingUserMessage
            ? estimatePromptTokens(
                chat.getHistoryShallow(true),
                pendingUserMessage,
                originalTokenCount,
                slimmingConfig.imageTokenEstimate,
              )
            : originalTokenCount;
      if (effectiveTokens < auto) {
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

    // Compression only reads the existing history while deciding the split and
    // preparing the side-query payload. Avoid `getHistory(true)` here: long
    // tool-heavy sessions can make a defensive deep clone larger than the
    // remaining V8 heap headroom at exactly the moment compaction is trying to
    // reduce memory pressure.
    const curatedHistory = chat.getHistoryShallow(true);
    if (curatedHistory.length === 0) {
      return {
        newHistory: null,
        info: {
          originalTokenCount,
          newTokenCount: originalTokenCount,
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

    // CLAUDE-CODE-STYLE FULL-HISTORY COMPRESSION
    // We no longer split the history into "compress" + "keep" slices.
    // The entire curated history is sent to the summary side-query, and
    // the post-compact history is assembled by composePostCompactHistory
    // (summary + model ack + recent file restores + recent image restore).
    const historyForCompression = curatedHistory;

    // Guard: need at least a user+model pair for a meaningful summary.
    if (historyForCompression.length < 2) {
      return {
        newHistory: null,
        info: {
          originalTokenCount,
          newTokenCount: originalTokenCount,
          compressionStatus: CompressionStatus.NOOP,
        },
      };
    }

    // Slim the side-query input: replace inlineData with placeholders.
    // The original history (with images) is preserved separately for
    // the post-compact image restoration block.
    const slim = slimCompactionInput(historyForCompression);
    if (slim.stats.imagesStripped > 0 || slim.stats.documentsStripped > 0) {
      config
        .getDebugLogger()
        .debug(
          `[chat-compression] slimmed ${slim.stats.imagesStripped} image(s) ` +
            `and ${slim.stats.documentsStripped} document(s) from side-query payload`,
        );
    }

    const summaryResult = await runSideQuery(config, {
      purpose: 'chat-compression',
      model,
      // Best-effort: failures fall back to NOOP and the next turn re-triggers
      // compression anyway, so don't burn 7 retries blocking the user mid-turn.
      maxAttempts: 1,
      systemInstruction: getCompressionPrompt(),
      contents: [
        ...slim.slimmedHistory,
        {
          role: 'user',
          parts: [
            {
              text: 'First, reason in your scratchpad. Then, produce the 9-section summary.',
            },
          ],
        },
      ],
      // Compression output is bounded by maxOutputTokens to guarantee a predictable
      // reserve across providers (see docs/design/auto-compaction-threshold-redesign.md).
      // Thinking is disabled because per-provider thinking-budget semantics are
      // inconsistent (Anthropic/OpenAI count it separately, Gemini varies by model).
      config: {
        thinkingConfig: { includeThoughts: false },
        maxOutputTokens: COMPACT_MAX_OUTPUT_TOKENS,
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

    // Defensive guard: if the side-query hit COMPACT_MAX_OUTPUT_TOKENS, the
    // summary is likely truncated mid-content and unsafe to persist. Drop it
    // and surface as a failure so the consecutive-failure breaker counts it —
    // if the model consistently produces max-length summaries we want to stop
    // trying after MAX_CONSECUTIVE_FAILURES strikes rather than burn an API
    // call on every send. Reactive overflow still catches the catastrophic
    // case. See docs/design/auto-compaction-threshold-redesign.md risk #2.
    //
    // TODO(finish_reason): the current `>= cap` check is a heuristic that
    // false-positives on legitimate summaries that happen to land exactly at
    // the cap. The proper signal is `finish_reason === 'length'` (OpenAI) /
    // `MAX_TOKENS` (Gemini), but `runSideQuery` doesn't surface it today.
    // Plumb it through and tighten this guard when that's available.
    if (
      !isSummaryEmpty &&
      typeof compressionOutputTokenCount === 'number' &&
      compressionOutputTokenCount >= COMPACT_MAX_OUTPUT_TOKENS
    ) {
      config
        .getDebugLogger()
        .warn(
          `[chat-compression] summary output reached the ` +
            `COMPACT_MAX_OUTPUT_TOKENS cap (${COMPACT_MAX_OUTPUT_TOKENS}); ` +
            `dropping potentially-truncated result. This counts as a ` +
            `compression failure for the per-chat circuit breaker.`,
        );
      return {
        newHistory: null,
        info: {
          originalTokenCount,
          newTokenCount: originalTokenCount,
          // Distinct from EMPTY_SUMMARY so telemetry / logs can tell a
          // prompt-quality failure (empty summary → tune prompt / splitter)
          // apart from a capacity failure (output cap hit → raise cap or
          // shrink splitter input). isCompressionFailureStatus() treats both
          // as failures so the persistence behaviour is unchanged. (R5.2)
          compressionStatus:
            CompressionStatus.COMPRESSION_FAILED_OUTPUT_TRUNCATED,
        },
      };
    }

    let newTokenCount = originalTokenCount;
    let extraHistory: Content[] = [];
    let canCalculateNewTokenCount = false;

    if (!isSummaryEmpty) {
      // Use the new composer — assembles summary + ack + file restores +
      // image restore. No tail preservation, no continuation bridge.
      extraHistory = await composePostCompactHistory(
        historyForCompression,
        summary,
      );

      // Best-effort token math using *only* model-reported token counts.
      //
      // Note: compressionInputTokenCount includes the compression prompt and
      // the extra "reason in your scratchpad" instruction(approx. 1000 tokens), and
      // compressionOutputTokenCount reflects the summary tokens only since
      // thinking is disabled.
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
