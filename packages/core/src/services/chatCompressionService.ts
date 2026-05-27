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
  DEFAULT_IMAGE_TOKEN_ESTIMATE,
  estimateContentChars,
  resolveSlimmingConfig,
  slimCompactionInput,
} from './compactionInputSlimming.js';
import {
  estimateContentTokens,
  estimatePromptTokens,
} from './tokenEstimation.js';

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
  precomputedCharCounts?: number[],
): number {
  if (fraction <= 0 || fraction >= 1) {
    throw new Error('Fraction must be between 0 and 1');
  }

  // Slimming-aware char estimator: base64 payloads in inlineData
  // would otherwise dominate the split. The caller can pre-compute and
  // pass `precomputedCharCounts` to avoid a redundant walk when the
  // surrounding compress() loop also needs the values.
  //
  // NOTE on the fallback: when `precomputedCharCounts` is omitted, we
  // use `DEFAULT_IMAGE_TOKEN_ESTIMATE` rather than the user's resolved
  // setting / env override. The only production caller is `compress()`,
  // which always passes precomputed counts, so the fallback is a
  // test-friendly default — not a behavior path users can influence.
  // Production callers MUST pass `precomputedCharCounts`.
  const charCounts =
    precomputedCharCounts ??
    contents.map((content) =>
      estimateContentChars(content, DEFAULT_IMAGE_TOKEN_ESTIMATE),
    );
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

    // Only manual `/compress` (trigger='manual') performs the orphan-strip:
    // if the chat was interrupted with a trailing model funcCall whose
    // funcResponse never arrived, the user-initiated /compress between
    // turns can safely drop it before computing the split point.
    //
    // Both automatic paths (trigger='auto') — cheap-gate (force=false) AND
    // hard-rescue (force=true) — must NOT strip. They fire inside
    // sendMessageStream() BEFORE the pending funcResponse is pushed onto
    // history, so the trailing funcCall is still active, not orphaned.
    //
    // Gating on `trigger === 'manual'` instead of `force` disambiguates
    // "user wants this compressed now, history can be mutated" from
    // "automatic compression mid-turn, history snapshot is live state and
    // must be preserved verbatim". Earlier the predicate used `force`,
    // which is correct for manual /compress (force=true, trigger='manual')
    // but conflated hard-rescue (force=true, trigger='auto') and silently
    // stripped active funcCalls there.
    const lastMessage = curatedHistory[curatedHistory.length - 1];
    const hasOrphanedFuncCall =
      compactTrigger === 'manual' &&
      lastMessage?.role === 'model' &&
      lastMessage.parts?.some((p) => !!p.functionCall);
    const historyForSplit = hasOrphanedFuncCall
      ? curatedHistory.slice(0, -1)
      : curatedHistory;

    // Precompute charCounts once and share with the splitter + the
    // MIN_COMPRESSION_FRACTION guard below, avoiding two extra walks.
    const charCounts = historyForSplit.map((c) =>
      estimateContentChars(c, slimmingConfig.imageTokenEstimate),
    );
    const splitPoint = findCompressSplitPoint(
      historyForSplit,
      1 - COMPRESSION_PRESERVE_THRESHOLD,
      TOOL_ROUND_RETAIN_COUNT,
      charCounts,
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
    let compressCharCount = 0;
    for (let i = 0; i < splitPoint; i++) compressCharCount += charCounts[i]!;
    const totalCharCount = charCounts.reduce((a, b) => a + b, 0);
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

    // Slim the side-query; live history unchanged.
    const slim = slimCompactionInput(historyToCompress);
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
              text: 'First, reason in your scratchpad. Then, generate the <state_snapshot>.',
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
    if (compressionOutputTokenCount === undefined && !isSummaryEmpty) {
      compressionOutputTokenCount = estimateContentTokens(
        [{ role: 'model', parts: [{ text: summary }] }],
        slimmingConfig.imageTokenEstimate,
      );
      config
        .getDebugLogger()
        .warn(
          `[chat-compression] compression side-query omitted usage metadata; ` +
            `using local estimate for summary output token count ` +
            `(${compressionOutputTokenCount}).`,
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

      // Best-effort token math using model-reported token counts when
      // available. Some OpenAI-compatible providers omit usage for the
      // compression side-query; in that case, fall back to the same local
      // content estimator used by the auto-compaction gate so a valid summary
      // can still shrink the history instead of failing with a token-count
      // error.
      //
      // Note: compressionInputTokenCount includes the compression prompt and
      // the extra "reason in your scratchpad" instruction(approx. 1000 tokens), and
      // compressionOutputTokenCount reflects the summary tokens only since
      // thinking is disabled.
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
      } else {
        const estimatedOriginalVisibleTokenCount = estimateContentTokens(
          historyForSplit,
          slimmingConfig.imageTokenEstimate,
        );
        const estimatedNewVisibleTokenCount = estimateContentTokens(
          extraHistory,
          slimmingConfig.imageTokenEstimate,
        );
        if (
          estimatedOriginalVisibleTokenCount > 0 &&
          estimatedNewVisibleTokenCount > 0
        ) {
          const estimatedNonVisibleTokenCount = Math.max(
            0,
            originalTokenCount - estimatedOriginalVisibleTokenCount,
          );
          // Keep the API-reported system/tool/prompt remainder intact. The
          // local estimator is only used for the visible conversation delta, so
          // missing usage metadata cannot replace the authoritative total with
          // a much smaller visible-history-only estimate.
          newTokenCount =
            estimatedNonVisibleTokenCount + estimatedNewVisibleTokenCount;
          canCalculateNewTokenCount = true;
          config
            .getDebugLogger()
            .debug(
              `[chat-compression] usage metadata missing; estimated ` +
                `post-compression token count by preserving the ` +
                `API-reported non-visible remainder ` +
                `(${estimatedNonVisibleTokenCount}) and replacing the ` +
                `visible-history estimate (${estimatedOriginalVisibleTokenCount} -> ` +
                `${estimatedNewVisibleTokenCount}).`,
            );
        }
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
