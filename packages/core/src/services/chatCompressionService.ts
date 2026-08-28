/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Content, GenerateContentConfig } from '@google/genai';
import type { Config } from '../config/config.js';
import { ApprovalMode } from '../config/config.js';
import type { GenerateTextResult } from '../core/baseLlmClient.js';
import { AuthType } from '../core/contentGenerator.js';
import type { LlmChat } from '../core/llm-chat.js';
import {
  type ChatCompressionInfo,
  type CompactionTriggerReason,
  CompressionStatus,
} from '../core/turn.js';
import { DEFAULT_TOKEN_LIMIT } from '../core/tokenLimits.js';
import { getCompressionPrompt } from '../core/prompts.js';
import { runSideQuery } from '../utils/sideQuery.js';
import { resolveModelId } from '../utils/modelId.js';
import { supportsOpenAIPrefixCaching } from '../core/openaiContentGenerator/prefix-caching.js';
import { logChatCompression } from '../telemetry/loggers.js';
import { makeChatCompressionEvent } from '../telemetry/types.js';
import { PreCompactTrigger, PostCompactTrigger } from '../hooks/types.js';
import { createDebugLogger } from '../utils/debugLogger.js';
import {
  estimateContentChars,
  resolveCompactionTuning,
  resolveSlimmingConfig,
  slimCompactionInput,
} from './compactionInputSlimming.js';
import {
  CHARS_PER_TOKEN,
  estimateContentTokens,
  estimatePromptTokens,
} from './tokenEstimation.js';
import {
  buildStateReminderParts,
  composePostCompactHistory,
  countToolResponseImages,
  postProcessSummary,
  stripAnalysisBlock,
  type SubagentSnapshot,
} from './postCompactAttachments.js';

const debugLogger = createDebugLogger('COMPRESSION');

/**
 * Hard cap on compression generation. The cold path asks providers to omit
 * returned thoughts. The cache-sharing path preserves Anthropic's
 * cache-sensitive thinking setting and makes the same returned-thought request
 * for Google GenAI. On Google this does not disable thinking or prevent its
 * tokens from sharing the output budget. Mirrors claude-code's
 * MAX_OUTPUT_TOKENS_FOR_SUMMARY (autoCompact.ts:30), which is based on p99.99
 * of real compaction outputs.
 */
export const COMPACT_MAX_OUTPUT_TOKENS = 20_000;

/**
 * Safety margin subtracted from the remaining window when computing the
 * compression side-query's output budget. The side-query input size is a
 * char/4 estimate, so this pad absorbs rounding and small per-part drift.
 * It does NOT scale with the estimate: proportional tokenizer error
 * (real tokenizers vary ±30% and under-count CJK-dense content) can still
 * push `prompt + max_tokens` over the window, in which case the backend
 * rejects the request with a 400 that propagates to the caller.
 */
export const COMPACTION_BUDGET_SAFETY_MARGIN = 1_024;

/**
 * Output budget for the compression side-query: the fixed ceiling clamped to
 * the window's remaining room (window - estimated input - safety margin).
 * Providers validate `prompt_tokens + max_tokens <= window` before
 * generating, so on small-window deployments (e.g. vLLM with a reduced
 * max_model_len) an unclamped ceiling can push the request over the window
 * and the backend rejects it with a 400 before the model runs
 * (https://github.com/QwenLM/qwen-code/issues/7960). Floored at 1 so
 * `maxOutputTokens` stays provider-valid even when the estimate already
 * fills the window — the request itself may still be rejected when the
 * prompt alone leaves no room. The estimate runs on the already-slimmed
 * history, so stripped media is no longer counted.
 *
 * The main send path enforces the same `prompt + max_tokens <= window`
 * invariant via clampOutputTokensToWindow in core/tokenLimits.ts, with
 * deliberately different tunables: that helper's 4K floor can itself exceed
 * a tight window, which this path must never do.
 *
 * Pure function — no I/O, no shared state — safe to call repeatedly.
 */
export function computeCompactionOutputBudget(
  estimatedInputTokens: number,
  contextLimit: number,
): number {
  const remaining =
    contextLimit - estimatedInputTokens - COMPACTION_BUDGET_SAFETY_MARGIN;
  return Math.max(1, Math.min(COMPACT_MAX_OUTPUT_TOKENS, remaining));
}

const COMPRESSION_REQUEST_DIRECTIVE =
  'First, reason in your <analysis> block. Then, produce the <state_snapshot> XML.';

/**
 * Default proportional auto-compaction threshold — the preferred trigger and an
 * upper bound on how high it can sit. See computeThresholds for how it combines
 * with the absolute ceiling (it governs large windows; the ceiling governs
 * smaller ones).
 */
export const DEFAULT_PCT = 0.85;

/**
 * Token budget reserved from the window for compression output. Matches
 * COMPACT_MAX_OUTPUT_TOKENS, the hard provider output ceiling for both
 * compression request shapes.
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
 * tuning constants; the counter state itself lives on LlmChat.
 */
export const MAX_CONSECUTIVE_FAILURES = 3;

const CJK_CHAR_TOKEN_MULTIPLIER = 1.5;
const CJK_CHAR_PATTERN =
  /[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff\uac00-\ud7af]/g;

function estimateSummaryOutputTokens(
  summary: string,
  imageTokenEstimate: number,
): number {
  const genericEstimate = estimateContentTokens(
    [{ role: 'model', parts: [{ text: summary }] }],
    imageTokenEstimate,
  );
  const cjkCharCount = summary.match(CJK_CHAR_PATTERN)?.length ?? 0;
  if (cjkCharCount === 0) {
    return genericEstimate;
  }

  const nonCjkCharCount = Math.max(0, summary.length - cjkCharCount);
  const cjkAwareEstimate =
    Math.ceil(nonCjkCharCount / CHARS_PER_TOKEN) +
    Math.ceil(cjkCharCount * CJK_CHAR_TOKEN_MULTIPLIER);
  return Math.max(genericEstimate, cjkAwareEstimate);
}

/**
 * Hard cap on the PreCompact hook's `additionalContext` once it is merged
 * into the side-query system prompt. The user-supplied `/compress` text is
 * already capped at `MAX_COMPRESS_INSTRUCTIONS_CHARS` (2000) in
 * compressCommand.ts for exactly this reason — the side-query has no
 * input-truncation retry, so an unbounded hook payload could inflate the
 * prompt and trigger a PTL the compaction path can't recover from. Hooks
 * may legitimately concatenate context across several scripts, so this cap
 * is set higher than the user-text cap.
 */
export const MAX_HOOK_INSTRUCTIONS_CHARS = 4000;

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
 * The absolute term (effectiveWindow - AUTOCOMPACT_BUFFER) is a *ceiling* —
 * "compact by here, or the summarization side-query has no room to run" — so
 * it is combined with the proportional preference via `min`, not `max`:
 *   auto = absoluteCeiling > 0 ? min(pct * window, absoluteCeiling) : pct * window
 *   warn = max(0, auto - WARN_BUFFER)
 *   hard = min(window, max(effectiveWindow - HARD_BUFFER, auto + HARD_BUFFER))
 *
 * So large windows compact at ~pct (never crowding the ceiling), smaller
 * windows compact at the ceiling (leaving room for the summary), and a window
 * too small for even the ceiling (≤ SUMMARY_RESERVE + AUTOCOMPACT_BUFFER) falls
 * back to the proportional value as a floor. This mirrors claude-code
 * (autoCompact.ts), which combines its percentage override with the absolute
 * ceiling via Math.min. `pct` defaults to DEFAULT_PCT.
 *
 * Pure function — no I/O, no shared state — safe to call repeatedly.
 */
export function computeThresholds(
  window: number,
  pct?: number,
): CompactionThresholds {
  const effectivePct = Math.min(
    1,
    Math.max(0, pct !== undefined && Number.isFinite(pct) ? pct : DEFAULT_PCT),
  );
  // Clamp to 0 for tiny windows (window < SUMMARY_RESERVE) so the surfaced
  // value in `/context` stays meaningful.
  const effectiveWindow = Math.max(0, window - SUMMARY_RESERVE);

  // The absolute term is a ceiling: compact before the prompt leaves too little
  // room for the summarization side-query (which needs up to SUMMARY_RESERVE of
  // output). Combine it with the proportional preference via `min`. When the
  // window is so small the ceiling is non-positive, fall back to the
  // proportional value as a floor so the trigger stays usable.
  const proportional = effectivePct * window;
  const absoluteCeiling = effectiveWindow - AUTOCOMPACT_BUFFER;
  const auto =
    absoluteCeiling > 0
      ? Math.min(proportional, absoluteCeiling)
      : proportional;

  // Warn fires WARN_BUFFER below auto (claude-code positions its warning tier
  // the same way, relative to the auto threshold).
  const warn = Math.max(0, auto - WARN_BUFFER);

  // hard is the last-ditch force-compaction point: the window edge (hardEdge),
  // but never below auto + HARD_BUFFER so it stays a distinct tier above auto on
  // degenerate small windows (where auto is the proportional floor and can
  // exceed hardEdge). Clamp to the window so hard never exceeds the actual limit.
  const hardEdge = effectiveWindow - HARD_BUFFER;
  const hard = Math.min(window, Math.max(hardEdge, auto + HARD_BUFFER));

  return { warn, auto, hard, effectiveWindow };
}

export type CompactTrigger = 'manual' | 'auto';

/**
 * Per-text-payload character cap applied to the compaction side-query when
 * the compaction was triggered by an HTTP 413 request-body overflow
 * (#10380). The side-query travels through the same byte-limited gateway
 * as the rejected request, so large tool-result texts are truncated to a
 * summary-friendly size. Token-driven compactions keep text intact.
 */
export const PAYLOAD_OVERFLOW_SIDE_QUERY_TEXT_CAP = 4000;

export interface CompressOptions {
  promptId: string;
  force: boolean;
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
   * Pre-computed all-inclusive effective-token count. This is normally from
   * `estimatePromptTokens()`, or from a provider-reported count after reactive
   * overflow. When provided, the cheap-gate skips its estimation pass and the
   * cache-sharing preflight does not add the previous model output again.
   */
  precomputedEffectiveTokens?: number;
  /** Per-request overrides used by the main turn, including transient tools. */
  requestGenerationConfig?: GenerateContentConfig;
  /**
   * User-supplied focus directives passed to the compression side-query.
   * Appended to the system prompt as an `Additional Instructions:` block.
   * Sourced from `/compress <text>`. PreCompact hooks may further append
   * `additionalContext` via `hookSpecificOutput`; user text always comes
   * first, hook text last (matches claude-code mergeHookInstructions).
   */
  customInstructions?: string;
  /**
   * Set when the compression is triggered by an HTTP 413 request-body
   * overflow rather than a token-count overflow (#10380). The side-query
   * input then truncates oversized text/tool-result payloads so the
   * compression request can itself fit under the gateway byte limit that
   * rejected the main request.
   */
  requestPayloadTooLarge?: boolean;
}

/**
 * Project active background subagent tasks into the minimal shape
 * `composePostCompactHistory` needs. `running` and `paused` are the only
 * statuses the post-compact agent might need to act on; terminal states
 * (completed / failed / cancelled) already emitted their notification XML
 * and need no reminder. Only `agent` kinds are interactive (shell and
 * monitor kinds are excluded — they don't have a send_message channel).
 *
 * Returns `[]` (not `undefined`) when the registry is absent so the
 * downstream attachment builder takes the empty-array branch and emits
 * no block, rather than treating `undefined` as a configuration error.
 */
function collectActiveSubagents(config: Config): SubagentSnapshot[] {
  const registry = config.getBackgroundTaskRegistry?.();
  if (!registry) return [];
  return registry
    .getAll()
    .filter(
      (t) =>
        t.kind === 'agent' &&
        // Only TRUE background subagents belong in a `<background-tasks>`
        // block. Foreground entries (`isBackgrounded: false`) are the
        // parent's synchronously-awaited tool call — their pending
        // functionCall is still in history and resolves through the normal
        // tool-result channel, so a reminder would mislabel them. Mirrors
        // the `getRunningBackgroundCount` filter in background-tasks.ts.
        t.isBackgrounded &&
        (t.status === 'running' || t.status === 'paused'),
    )
    .map((t) => ({
      id: t.id,
      description: t.description,
      status: t.status as 'running' | 'paused',
      startTime: t.startTime,
    }));
}

/**
 * Compose the compression side-query system prompt: the base template,
 * optionally followed by an `Additional Instructions:` block containing
 * the user's `/compress <text>` directives and any `additionalContext`
 * returned by PreCompact hooks. Order is user-first / hook-appended so an
 * explicit user intent outranks a global hook policy when both speak.
 */
function buildCompressionSystemPrompt(
  userInstructions: string | undefined,
  hookInstructions: string,
): string {
  const base = getCompressionPrompt();
  const parts: string[] = [];
  if (userInstructions && userInstructions.trim().length > 0) {
    parts.push(userInstructions.trim());
  }
  if (hookInstructions.length > 0) {
    parts.push(hookInstructions);
  }
  if (parts.length === 0) return base;
  return `${base}\n\nAdditional Instructions:\n${parts.join('\n\n')}`;
}

function supportsCompressionCacheSharing(config: Config): boolean {
  const provider = config.getContentGeneratorConfig();
  // Google GenAI prefix caching is implicit. `enableCacheControl` configures
  // explicit provider cache markers, so it must not disable Gemini/Vertex
  // cache sharing as an unrelated side effect.
  if (
    provider.authType === AuthType.USE_GEMINI ||
    provider.authType === AuthType.USE_VERTEX_AI
  ) {
    return true;
  }
  if (provider.enableCacheControl === false) return false;
  if (provider.authType === AuthType.USE_ANTHROPIC) return true;
  return supportsOpenAIPrefixCaching(provider);
}

function hasStateSnapshot(summary: string): boolean {
  const stripped = stripAnalysisBlock(summary);
  const startTag = '<state_snapshot>';
  const start = stripped.indexOf(startTag);
  const end = stripped.indexOf('</state_snapshot>', start + startTag.length);
  return (
    start >= 0 &&
    end > start + startTag.length &&
    stripped.slice(start + startTag.length, end).trim().length > 0
  );
}

export class ChatCompressionService {
  async compress(
    chat: LlmChat,
    opts: CompressOptions,
  ): Promise<{ newHistory: Content[] | null; info: ChatCompressionInfo }> {
    const {
      promptId,
      force,
      config,
      consecutiveFailures,
      originalTokenCount,
      trigger,
      signal,
    } = opts;
    const compactTrigger = trigger ?? (force ? 'manual' : 'auto');
    // Why this compaction fired, surfaced on the COMPRESSED result so the UI
    // notice is accurate. Defaults by trigger; the gate below upgrades it to
    // 'image_overflow' when the screenshot trigger is what let it through.
    // 413-driven compactions report 'payload_overflow' so the notice (and the
    // recorded payload) doesn't claim a token overflow the request never
    // reached (#10380). The reactive 413 path is force=true, so the
    // non-forced gate below cannot overwrite this.
    let triggerReason: CompactionTriggerReason = opts.requestPayloadTooLarge
      ? 'payload_overflow'
      : compactTrigger === 'manual'
        ? 'manual'
        : 'token_limit';
    const chatCompressionSettings = config.getChatCompression();
    const slimmingConfig = resolveSlimmingConfig(chatCompressionSettings);
    const tuning = resolveCompactionTuning(chatCompressionSettings);
    const contentGeneratorConfig = config.getContentGeneratorConfig();
    const contextLimit =
      contentGeneratorConfig.contextWindowSize ?? DEFAULT_TOKEN_LIMIT;

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
      // Thresholds run against the FULL window: the send-path output clamp
      // guarantees `prompt + max_tokens ≤ window`, so no output budget needs
      // to be reserved out of the window here (this replaced the
      // #5957/#6266 reservedOutputTokens machinery).
      const { auto } = computeThresholds(
        contextLimit,
        config.getAutoCompactThreshold(),
      );
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
                // lastOutputTokenCount is unavailable here. The common
                // sendMessageStream path passes precomputedEffectiveTokens,
                // which already includes the chat's previous output tokens.
                0,
                slimmingConfig.imageTokenEstimate,
              )
            : originalTokenCount;
      if (effectiveTokens < auto) {
        // Screenshot-overflow trigger: even below the token threshold,
        // compact once tool-returned images accumulate past the configured
        // count, so tool-driven visual sessions don't drown the model in stale
        // screenshots. Only counted in the would-be-NOOP path and only when
        // enabled, so the common case pays nothing. Counts NESTED tool media
        // only (countToolResponseImages), not user-pasted top-level images.
        const screenshotOverflow =
          tuning.enableScreenshotTrigger &&
          countToolResponseImages(chat.getHistoryShallow(true)) >=
            tuning.screenshotTriggerThreshold;
        if (!screenshotOverflow) {
          debugLogger.debug(
            `[compaction] cheap-gate NOOP: effectiveTokens=${effectiveTokens}, ` +
              `auto=${auto}, contextLimit=${contextLimit}`,
          );
          return {
            newHistory: null,
            info: {
              originalTokenCount,
              newTokenCount: originalTokenCount,
              compressionStatus: CompressionStatus.NOOP,
            },
          };
        }
        // Below the token threshold but the screenshot trigger fired.
        triggerReason = 'image_overflow';
      }
    }

    // Compression reads existing history plus any pending tool result while
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

    // CLAUDE-CODE-STYLE FULL-HISTORY COMPRESSION: the entire curated
    // history is sent to the summary side-query (no split, no tail
    // preservation), and the post-compact history is assembled by
    // composePostCompactHistory below (summary + model ack + recent
    // file restores + recent image restore).

    // Guard: need at least a user+model pair for a meaningful summary.
    // This runs BEFORE the PreCompact hook fires — a hook with side effects
    // (transcript dump, external notification) shouldn't be triggered for
    // a session we're about to NOOP on anyway.
    if (curatedHistory.length < 2) {
      return {
        newHistory: null,
        info: {
          originalTokenCount,
          newTokenCount: originalTokenCount,
          compressionStatus: CompressionStatus.NOOP,
        },
      };
    }

    // Fire PreCompact hook before compression begins. Pass any user-supplied
    // `/compress` instructions so hook scripts can read / log / amend them
    // via `hookSpecificOutput.additionalContext`. The aggregator concatenates
    // additionalContext across all hooks with '\n' separators.
    let hookExtraInstructions = '';
    const hookSystem = config.getHookSystem();
    if (hookSystem) {
      const preCompactTrigger =
        compactTrigger === 'manual'
          ? PreCompactTrigger.Manual
          : PreCompactTrigger.Auto;
      try {
        const result = await hookSystem.firePreCompactEvent(
          preCompactTrigger,
          opts.customInstructions ?? '',
          signal,
        );
        // `getAdditionalContext()` sanitises (`<`/`>` → `&lt;`/`&gt;`) so a
        // hook can't inject XML structure into the summary prompt. Mirrors
        // every other call-site in this repo (toolHookTriggers, agent.ts,
        // client.ts) — keep it consistent.
        const merged = result?.getAdditionalContext();
        if (merged && merged.trim().length > 0) {
          // Cap like the user-text path: an unbounded hook payload would
          // otherwise bypass MAX_COMPRESS_INSTRUCTIONS_CHARS and inflate the
          // side-query prompt past a recoverable size.
          hookExtraInstructions = merged
            .trim()
            .slice(0, MAX_HOOK_INSTRUCTIONS_CHARS);
        }
      } catch (err) {
        config.getDebugLogger().warn(`PreCompact hook failed: ${err}`);
      }
    }

    // A tool result is still pending when automatic compaction runs before
    // sendMessageStream commits the current user turn to chat history. Include
    // it in the side-query so Anthropic-compatible providers see it immediately
    // after the preceding tool_use block.
    const pendingToolResult = opts.pendingUserMessage?.parts?.some(
      (part) => !!part.functionResponse,
    );
    // With no pending functionResponse to pair with it, a trailing
    // model[functionCall] (e.g. a restored ask_user_question preserved by
    // startChat) would put `model[functionCall] → user[directive]` on the
    // wire — the shape the API rejects. Strip it like the manual-trigger
    // strip below; the preserved call stays in chat history untouched.
    const lastCurated = curatedHistory[curatedHistory.length - 1];
    const sideQueryBase =
      !pendingToolResult &&
      lastCurated?.role === 'model' &&
      lastCurated.parts?.some((part) => !!part.functionCall)
        ? curatedHistory.slice(0, -1)
        : curatedHistory;
    const sideQueryHistory = pendingToolResult
      ? [...sideQueryBase, opts.pendingUserMessage!]
      : sideQueryBase;
    const pendingToolResultTokenCount = pendingToolResult
      ? estimateContentTokens(
          [opts.pendingUserMessage!],
          slimmingConfig.imageTokenEstimate,
        )
      : 0;

    // Lazy: the cold fallback input is slimmed on demand. The original
    // history keeps its media: the shared request needs it for cache-prefix
    // identity, and the post-compact image restoration block reads it
    // afterwards.
    let coldInput: ReturnType<typeof slimCompactionInput> | undefined;
    const getColdInput = () => {
      coldInput ??= slimCompactionInput(
        sideQueryHistory,
        undefined,
        opts.requestPayloadTooLarge
          ? { maxTextChars: PAYLOAD_OVERFLOW_SIDE_QUERY_TEXT_CAP }
          : undefined,
      );
      return coldInput;
    };

    // Hoist the system prompt so the guard can include it in the estimate.
    const systemInstruction = buildCompressionSystemPrompt(
      opts.customInstructions,
      hookExtraInstructions,
    );

    // Guard: if the compaction model's context window is too small for the
    // slimmed payload, fall back to the main model for this compression only.
    // Coalesce to the main model so an undefined getCompactionModel() (e.g.
    // validation failure) never leaks to the fast model via resolveDefaultModel.
    let effectiveCompactionModel =
      config.getCompactionModel?.() ?? config.getModel();
    let compactionWarning: string | undefined;
    // Shared estimate of the slimmed side-query payload (history + system
    // instruction), memoized and lazy: the cache-sharing path must not pay
    // for slimming. The compaction-model guard adds the output reserve as
    // its third term; the budget clamp adds the directive — keeping the
    // leading terms in one place so the two checks cannot drift.
    let cachedColdInputEstimate: number | undefined;
    const getColdInputEstimate = () =>
      (cachedColdInputEstimate ??=
        estimateContentTokens(
          getColdInput().slimmedHistory,
          slimmingConfig.imageTokenEstimate,
        ) + Math.ceil(systemInstruction.length / CHARS_PER_TOKEN));
    // Window the output budget clamps against: the window of the model that
    // actually receives the side-query. Defaults to the main model's window;
    // switched below to a distinct compaction model's window when the guard
    // keeps that model (issue #7960).
    let budgetWindow = contextLimit;
    // Only check the window when the effective model differs from the main
    // model — warning about the main model being "too small" is confusing
    // when no compaction model was explicitly configured.
    if (effectiveCompactionModel !== config.getModel()) {
      const resolved = resolveModelId(effectiveCompactionModel);
      if (resolved) {
        const models = resolved.authType
          ? config.getAllConfiguredModels([resolved.authType])
          : config.getAllConfiguredModels();
        const entry = models.find((m) => m.id === resolved.modelId);
        const window = entry?.contextWindowSize;
        // Include the system prompt and the output reserve: providers check
        // prompt + max_tokens <= window, so all three terms count.
        const slimmedTokenEstimate =
          getColdInputEstimate() + COMPACT_MAX_OUTPUT_TOKENS;
        if (window && window > 0 && slimmedTokenEstimate > window) {
          compactionWarning =
            `Compaction model "${resolved.modelId}" context window ` +
            `(${window.toLocaleString()} tokens) is too small for the current ` +
            `payload (~${slimmedTokenEstimate.toLocaleString()} tokens); ` +
            `using the main model for this compression.`;
          config
            .getDebugLogger()
            .warn(`[chat-compression] ${compactionWarning}`);
          effectiveCompactionModel = config.getModel();
        } else if (window && window > 0) {
          budgetWindow = window;
        }
      }
    }

    const abortSignal = signal ?? new AbortController().signal;
    abortSignal.throwIfAborted();
    // The output budget runColdCompression requests: the fixed ceiling
    // clamped to the receiving model's remaining window (issue #7960).
    // Hoisted because the truncation guard below compares the reported
    // output count against it.
    let coldOutputBudget = COMPACT_MAX_OUTPUT_TOKENS;
    const runColdCompression = () => {
      const slim = getColdInput();
      if (slim.stats.imagesStripped > 0 || slim.stats.documentsStripped > 0) {
        config
          .getDebugLogger()
          .debug(
            `[chat-compression] slimmed ${slim.stats.imagesStripped} image(s) ` +
              `and ${slim.stats.documentsStripped} document(s) from side-query payload`,
          );
      }
      // Clamp the output budget to the receiving model's remaining window so
      // `prompt + max_tokens <= window` holds even on small-window
      // deployments (issue #7960).
      coldOutputBudget = computeCompactionOutputBudget(
        getColdInputEstimate() +
          Math.ceil(COMPRESSION_REQUEST_DIRECTIVE.length / CHARS_PER_TOKEN),
        budgetWindow,
      );
      if (coldOutputBudget < COMPACT_MAX_OUTPUT_TOKENS) {
        config
          .getDebugLogger()
          .debug(
            `[chat-compression] output budget clamped to ${coldOutputBudget} ` +
              `(estimated input ${getColdInputEstimate()}, window ${budgetWindow})`,
          );
      }
      return runSideQuery(config, {
        purpose: 'chat-compression',
        skipOutputLanguagePreference: true,
        model: effectiveCompactionModel,
        // Compression uses the compaction model (config.getCompactionModel?.()) to reduce cost.
        // Falls back to the main model if not set or if the payload exceeds the
        // compaction model's context window.
        // See https://github.com/QwenLM/qwen-code/issues/5956
        // Stream so a slow compression inference keeps the HTTP connection alive.
        // Non-streaming returns no bytes until the whole summary is generated, so
        // behind a BFF gateway with a short `proxy_read_timeout` a long inference
        // is killed with a 504 (surfaced as a 422) mid-compression, breaking the
        // session. See https://github.com/QwenLM/qwen-code/issues/5861.
        stream: true,
        // Best-effort: failures fall back to NOOP and the next turn re-triggers
        // compression anyway, so don't burn 7 retries blocking the user mid-turn.
        maxAttempts: 1,
        systemInstruction,
        contents: [
          ...slim.slimmedHistory,
          {
            role: 'user',
            parts: [
              {
                text: COMPRESSION_REQUEST_DIRECTIVE,
              },
            ],
          },
        ],
        // Compression output is bounded by the window-clamped budget to
        // guarantee a predictable reserve across providers and keep
        // `prompt + max_tokens <= window` valid on small-window deployments
        // (see docs/design/auto-compaction-threshold-redesign.md, issue
        // #7960). Thinking is disabled because per-provider thinking-budget
        // semantics are inconsistent (Anthropic/OpenAI count it separately,
        // Gemini varies by model).
        config: {
          thinkingConfig: { includeThoughts: false },
          maxOutputTokens: coldOutputBudget,
        },
        abortSignal,
        promptId,
      });
    };

    let summaryResult: GenerateTextResult | undefined;
    let usedCacheSharing = false;
    const sharedRequestText =
      `${systemInstruction}\n\n` +
      'Do not call tools; tool execution is disabled for this request. ' +
      COMPRESSION_REQUEST_DIRECTIVE;
    const sharedPromptTokenCount =
      opts.precomputedEffectiveTokens ??
      originalTokenCount + (chat.getLastOutputTokenCount?.() ?? 0);
    const sharedDirectiveTokenCount = Math.ceil(
      sharedRequestText.length / CHARS_PER_TOKEN,
    );
    const usesMainModel = effectiveCompactionModel === config.getModel();
    const providerSupportsCacheSharing =
      supportsCompressionCacheSharing(config);
    // The anchor must be provider-reported, not merely non-zero: an
    // estimate-derived count misses the ~15-20K system/tools overhead the
    // shared request actually carries, so `sharedRequestFits` could approve
    // a request that overflows the window. Estimate-only sessions stay on
    // the cold path until provider usage arrives.
    const hasProviderTokenCount =
      (chat.getLastPromptTokenCount?.() ?? 0) > 0 &&
      chat.isLastPromptTokenCountEstimated?.() !== true;
    const sharedRequestFits =
      sharedPromptTokenCount +
        sharedDirectiveTokenCount +
        COMPACT_MAX_OUTPUT_TOKENS <=
      contextLimit;
    const canShareCache =
      usesMainModel &&
      providerSupportsCacheSharing &&
      hasProviderTokenCount &&
      sharedRequestFits;
    if (!canShareCache) {
      const reason = !usesMainModel
        ? 'distinct compaction model'
        : !providerSupportsCacheSharing
          ? 'provider does not support cache sharing'
          : !hasProviderTokenCount
            ? 'no provider-reported token-count anchor'
            : `shared request exceeds context window: prompt=${sharedPromptTokenCount}, ` +
              `directive=${sharedDirectiveTokenCount}, reserve=${COMPACT_MAX_OUTPUT_TOKENS}, ` +
              `window=${contextLimit}`;
      debugLogger.debug(`[compaction] skipping cache sharing: ${reason}`);
    }
    if (canShareCache) {
      try {
        const generationConfig = {
          ...chat.getGenerationConfig(),
          ...opts.requestGenerationConfig,
        };
        const mainSystemInstruction = generationConfig.systemInstruction;
        delete generationConfig.systemInstruction;
        delete generationConfig.abortSignal;
        const authType = config.getContentGeneratorConfig().authType;
        const sharedResult = await config.getBaseLlmClient().generateText({
          contents: [
            ...sideQueryHistory,
            {
              role: 'user',
              parts: [
                {
                  text: sharedRequestText,
                },
              ],
            },
          ],
          model: effectiveCompactionModel,
          systemInstruction: mainSystemInstruction,
          config: {
            ...generationConfig,
            ...(authType === AuthType.USE_ANTHROPIC
              ? {
                  thinkingConfig: {
                    ...generationConfig.thinkingConfig,
                    // Manual Anthropic thinking requires budget_tokens to be
                    // strictly below max_tokens. Preserve thinking for cache
                    // compatibility while keeping this bounded request valid.
                    thinkingBudget: COMPACT_MAX_OUTPUT_TOKENS - 1,
                  },
                }
              : authType === AuthType.USE_GEMINI ||
                  authType === AuthType.USE_VERTEX_AI
                ? {
                    thinkingConfig: {
                      ...generationConfig.thinkingConfig,
                      includeThoughts: false,
                    },
                  }
                : {}),
            maxOutputTokens: COMPACT_MAX_OUTPUT_TOKENS,
          },
          abortSignal,
          promptId,
          stream: true,
          maxAttempts: 1,
          promptCacheSharing: true,
        });
        if (!sharedResult.hadToolCall && hasStateSnapshot(sharedResult.text)) {
          summaryResult = sharedResult;
          usedCacheSharing = true;
          config
            .getDebugLogger()
            .debug(
              `[chat-compression] cache-sharing request succeeded; ` +
                `cachedContentTokenCount=` +
                `${sharedResult.usage?.cachedContentTokenCount ?? 0}`,
            );
        } else {
          config
            .getDebugLogger()
            .warn(
              `[chat-compression] cache-sharing response was unusable ` +
                `(${sharedResult.hadToolCall ? 'tool call' : 'invalid state snapshot'}); ` +
                `falling back to the dedicated summarizer.`,
            );
        }
      } catch (error) {
        if (abortSignal.aborted) throw error;
        config
          .getDebugLogger()
          .warn(
            `[chat-compression] cache-sharing request failed; falling back ` +
              `to the dedicated summarizer: ${String(error)}`,
          );
      }
    }

    if (!summaryResult) {
      abortSignal.throwIfAborted();
      summaryResult = await runColdCompression();
    }
    const summary = summaryResult.text;
    // Check the PROCESSED summary: postProcessSummary strips <analysis>
    // blocks, so a response that is ONLY <analysis>...</analysis> (no
    // <state_snapshot>) has a non-empty RAW body but strips to nothing. If
    // we gated on the raw body, compaction would "succeed" and the agent
    // would resume with `[Summary unavailable]` as its only context — total
    // amnesia with green metrics. Treat strip-to-empty as an empty summary
    // so it takes the COMPRESSION_FAILED_EMPTY_SUMMARY path (NOOP) instead.
    const isSummaryEmpty =
      !summary || stripAnalysisBlock(summary).trim().length === 0;
    const compressionUsageMetadata = summaryResult.usage;
    const compressionInputTokenCount =
      compressionUsageMetadata?.promptTokenCount;
    let compressionOutputTokenCount =
      compressionUsageMetadata?.candidatesTokenCount;
    // Local fallback estimates are NOT bounded by the requested budget (only
    // provider-reported counts are), so the guard below keys its threshold
    // to the count's provenance.
    let outputCountIsEstimated = false;
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
      outputCountIsEstimated = true;
      compressionOutputTokenCount = estimateSummaryOutputTokens(
        summary,
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

    // Defensive guard: if the dedicated side-query hit the output budget it
    // actually requested, the summary is likely truncated mid-content and
    // unsafe to persist. Drop it and surface as a failure so the
    // consecutive-failure breaker counts it —
    // if the model consistently produces max-length summaries we want to stop
    // trying after MAX_CONSECUTIVE_FAILURES strikes rather than burn an API
    // call on every send. Reactive overflow still catches the catastrophic
    // case. See docs/design/auto-compaction-threshold-redesign.md risk #2.
    //
    // Provider-reported counts compare against coldOutputBudget, not the
    // fixed ceiling: since issue #7960's clamp the requested budget can sit
    // below COMPACT_MAX_OUTPUT_TOKENS, and output can never exceed what was
    // requested — comparing against the fixed ceiling would make this guard
    // unreachable on every clamped request. That includes the floor regime
    // (budget 1): a 1-token cap cannot hold a usable summary, so any output
    // at the cap is definitionally truncated and must be dropped.
    //
    // Local estimates instead keep the pre-clamp fixed-ceiling threshold:
    // unlike provider counts they can overshoot the budget purely from
    // estimator error (the ±30% variance the margin documents), so comparing
    // them against a clamped budget would convert that error into false
    // truncation verdicts for complete summaries. The fixed ceiling
    // preserves the pre-#7960 semantics for the usage-missing path. The one
    // exception is the floor regime (budget 1): no complete summary can
    // exist at a 1-token cap, so the false-positive rationale cannot apply
    // and estimates must be dropped there too — otherwise a provider that
    // omits usage would persist a 1-token fragment as COMPRESSED.
    //
    // TODO(finish_reason): the current `>= budget` check is a heuristic that
    // false-positives on legitimate summaries that happen to land exactly at
    // the budget. The proper signal is `finish_reason === 'length'` (OpenAI) /
    // `MAX_TOKENS` (Gemini), but `runSideQuery` doesn't surface it today.
    // Plumb it through and tighten this guard when that's available.
    const truncationThreshold =
      outputCountIsEstimated && coldOutputBudget > 1
        ? COMPACT_MAX_OUTPUT_TOKENS
        : coldOutputBudget;
    if (
      !usedCacheSharing &&
      !isSummaryEmpty &&
      typeof compressionOutputTokenCount === 'number' &&
      compressionOutputTokenCount >= truncationThreshold
    ) {
      config
        .getDebugLogger()
        .warn(
          `[chat-compression] summary output reached the truncation ` +
            `threshold (${truncationThreshold}); ` +
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
    // The threshold comparison above cannot detect cap-hits when the budget
    // was clamped and the count is a local estimate: output never exceeds
    // the requested budget and the estimator tops out at ~1.5x actual tokens,
    // so below ~2/3 of the ceiling the estimate can never reach the fixed
    // threshold. Gate that path on snapshot well-formedness instead — a
    // summary truncated at the clamped cap lacks the closing
    // </state_snapshot> tag, while a complete one carries it (the directive
    // requires the XML, and the cache-sharing path gates on the same check).
    if (
      !usedCacheSharing &&
      !isSummaryEmpty &&
      outputCountIsEstimated &&
      coldOutputBudget < COMPACT_MAX_OUTPUT_TOKENS &&
      !hasStateSnapshot(summary)
    ) {
      config
        .getDebugLogger()
        .warn(
          `[chat-compression] summary lacks a closed <state_snapshot> while ` +
            `the output budget was clamped (${coldOutputBudget}) and the ` +
            `output count is a local estimate; dropping ` +
            `potentially-truncated result. This counts as a compression ` +
            `failure for the per-chat circuit breaker.`,
        );
      return {
        newHistory: null,
        info: {
          originalTokenCount,
          newTokenCount: originalTokenCount,
          compressionStatus:
            CompressionStatus.COMPRESSION_FAILED_OUTPUT_TRUNCATED,
        },
      };
    }

    let newTokenCount = originalTokenCount;
    let extraHistory: Content[] = [];
    let canCalculateNewTokenCount = false;

    if (!isSummaryEmpty) {
      // Manual /compress has no pending functionResponse, so a trailing
      // model+functionCall is an ORPHAN (e.g. an interrupted/cancelled tool
      // call). Preserving it emits model[functionCall] immediately followed
      // by the next user TEXT turn, which the API rejects (a functionCall
      // must be followed by its functionResponse). Strip it for manual;
      // auto-compaction keeps it because the pending functionResponse pairs
      // with it (trailingFunctionCallContent).
      const lastCurated = curatedHistory[curatedHistory.length - 1];
      const historyForCompose =
        compactTrigger === 'manual' &&
        lastCurated?.role === 'model' &&
        lastCurated.parts?.some((p) => !!p.functionCall)
          ? curatedHistory.slice(0, -1)
          : curatedHistory;

      // Use the new composer — assembles summary + ack + file restores +
      // image restore. No tail preservation, no continuation bridge.
      try {
        extraHistory = await composePostCompactHistory(
          historyForCompose,
          summary,
          {
            workspaceRoot: config.getTargetDir(),
            signal,
            // A payload-overflow compaction (#10380) exists because the
            // serialized request exceeded the gateway's BYTE limit while
            // staying under the token threshold. Restoration re-embeds
            // full-size image payloads and ~20KB file blocks that the
            // slimmed side-query never carried — re-inflating the rebuilt
            // retry request straight back over the same limit and defeating
            // the recovery. Suppress restoration attachments on this path;
            // the summary that just fit dominates the retried request.
            maxFiles: opts.requestPayloadTooLarge ? 0 : tuning.maxRecentFiles,
            maxImages: opts.requestPayloadTooLarge ? 0 : tuning.maxRecentImages,
            // Restore plan-mode reminder + running-subagent snapshot so the
            // post-compact agent does not lose either piece of mid-session
            // state. Both reduce to no-ops when the corresponding source is
            // empty.
            planModeActive: config.getApprovalMode?.() === ApprovalMode.PLAN,
            runningSubagents: collectActiveSubagents(config),
          },
        );
      } catch (err) {
        // The summary side-query already succeeded; only restoration
        // assembly (disk I/O, history walking) failed. Degrade to
        // summary + ack rather than letting the throw escape to
        // sendMessageStream — an uncaught error there crashes the active
        // turn AND bypasses the COMPRESSION_FAILED breaker. The summary
        // still reduces context, so this is a degraded success, not a
        // compression failure.
        config
          .getDebugLogger()
          .warn(`[chat-compression] composePostCompactHistory failed: ${err}`);
        // Fold a trailing model+functionCall into the ack so a pending
        // functionResponse (auto-compaction mid-tool-loop) keeps its matching
        // call — otherwise the next request has an orphaned functionResponse
        // → 400. (Manual orphans were already stripped above.) Folding into
        // the ack avoids a model→model adjacency.
        const trailingFc = historyForCompose[historyForCompose.length - 1];
        const fcParts =
          trailingFc?.role === 'model'
            ? (trailingFc.parts ?? []).filter((p) => !!p.functionCall)
            : [];
        // Re-apply the SAME plan-mode + subagent reminders the normal path
        // injects. These builders are pure (no disk I/O / history walking),
        // so the failure that took out composePostCompactHistory can't take
        // them out too — and dropping them here would silently lose plan-mode
        // enforcement and the subagent roster on the degraded path.
        const reminderParts = buildStateReminderParts({
          planModeActive: config.getApprovalMode?.() === ApprovalMode.PLAN,
          runningSubagents: collectActiveSubagents(config),
        });
        extraHistory = [
          {
            role: 'user',
            parts: [{ text: postProcessSummary(summary) }, ...reminderParts],
          },
          {
            role: 'model',
            parts: [
              { text: 'Got it. Thanks for the additional context!' },
              ...fcParts,
            ],
          },
        ];
      }

      // Best-effort token math using model-reported token counts when
      // available. Some OpenAI-compatible providers omit usage for the
      // compression side-query; in that case, fall back to the same local
      // content estimator used by the auto-compaction gate so a valid summary
      // can still shrink the history instead of failing with a token-count
      // error.
      //
      // The cache-sharing request also includes the main system and tools, so
      // its input count cannot isolate visible history with a fixed subtraction;
      // that path uses the local visible-history delta below. On the cold path,
      // compressionInputTokenCount includes the entire compression
      // system prompt (the <state_snapshot> instructions, ~900 tokens) PLUS
      // the short kick-off user turn ("First, reason in your <analysis>
      // block. Then, produce the <state_snapshot> XML.", ~20 tokens) — the
      // "approx. 1000 tokens" subtracted below is for that combined fixed
      // overhead, not for any single instruction.
      // compressionOutputTokenCount reflects the raw model response (i.e.
      // <analysis> + <state_snapshot>); the <analysis> block is stripped
      // by postProcessSummary before the summary enters history, so the
      // real cost in newHistory is slightly lower than this count
      // suggests. We accept that inaccuracy in favor of avoiding local
      // token estimation.
      if (
        !usedCacheSharing &&
        typeof compressionInputTokenCount === 'number' &&
        compressionInputTokenCount > 0 &&
        typeof compressionOutputTokenCount === 'number' &&
        compressionOutputTokenCount > 0
      ) {
        canCalculateNewTokenCount = true;
        const compressedHistoryTokenCount = Math.max(
          0,
          compressionInputTokenCount - 1000 - pendingToolResultTokenCount,
        );
        newTokenCount = Math.max(
          0,
          originalTokenCount -
            compressedHistoryTokenCount +
            compressionOutputTokenCount,
        );
        // The composer injects file-restoration blocks (up to
        // maxRecentFiles × 5K tokens) and an image-restoration block (up to
        // maxRecentImages images) that are NOT in
        // compressionOutputTokenCount. Estimate their cost locally so the
        // inflation guard below fires when attachments dominate the
        // post-compact size.
        const restorationChars = extraHistory
          .slice(2) // skip [summary, model ack]
          .reduce(
            (acc, c) =>
              acc + estimateContentChars(c, slimmingConfig.imageTokenEstimate),
            0,
          );
        newTokenCount += Math.ceil(restorationChars / CHARS_PER_TOKEN);
      } else {
        const estimatedOriginalVisibleTokenCount = estimateContentTokens(
          curatedHistory,
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
              `[chat-compression] ${
                usedCacheSharing
                  ? 'cache-sharing token accounting'
                  : 'usage metadata missing'
              }; estimated ` +
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
        cache_sharing_attempted: canShareCache,
        cache_sharing_used: usedCacheSharing,
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
        // Pass the stripped summary (Finding 8a) so hook consumers see
        // the same text that lands in history — not the raw side-query
        // output with the <analysis> scratchpad still attached. The
        // resume trailer is NOT included; it is wrapper decoration for
        // the next agent turn, not state for downstream consumers.
        await config
          .getHookSystem()
          ?.firePostCompactEvent(
            postCompactTrigger,
            stripAnalysisBlock(summary),
            signal,
          );
      } catch (err) {
        config.getDebugLogger().warn(`PostCompact hook failed: ${err}`);
      }

      return {
        newHistory: extraHistory,
        info: {
          originalTokenCount,
          newTokenCount,
          newTokenCountIsEstimated: true,
          compressionStatus: CompressionStatus.COMPRESSED,
          triggerReason,
          ...(compactionWarning && { warning: compactionWarning }),
        },
      };
    }
  }
}
