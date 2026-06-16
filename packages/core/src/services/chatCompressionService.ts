/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Content } from '@google/genai';
import type { Config } from '../config/config.js';
import { ApprovalMode } from '../config/config.js';
import type { GeminiChat } from '../core/geminiChat.js';
import {
  type ChatCompressionInfo,
  type CompactionTriggerReason,
  CompressionStatus,
} from '../core/turn.js';
import { DEFAULT_TOKEN_LIMIT } from '../core/tokenLimits.js';
import { getCompressionPrompt } from '../core/prompts.js';
import { runSideQuery } from '../utils/sideQuery.js';
import { logChatCompression } from '../telemetry/loggers.js';
import { makeChatCompressionEvent } from '../telemetry/types.js';
import { PreCompactTrigger, PostCompactTrigger } from '../hooks/types.js';
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
 * Each tier is `max(proportional, absolute)`:
 *   auto = max(DEFAULT_PCT * window,                       effectiveWindow - AUTOCOMPACT_BUFFER)
 *   warn = max((DEFAULT_PCT - WARN_PCT_OFFSET) * window,   auto - WARN_BUFFER)
 *   hard = min(window, max(effectiveWindow - HARD_BUFFER,  auto + HARD_BUFFER))
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
  // Guarantee hard > auto so compaction doesn't wait until the last moment.
  // For tiny/zero windows where auto is already at the proportional floor,
  // clamp hard to the window itself so it never exceeds the actual limit.
  const hard = Math.min(window, Math.max(rawHard, auto + HARD_BUFFER));

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
  /**
   * User-supplied focus directives passed to the compression side-query.
   * Appended to the system prompt as an `Additional Instructions:` block.
   * Sourced from `/compress <text>`. PreCompact hooks may further append
   * `additionalContext` via `hookSpecificOutput`; user text always comes
   * first, hook text last (matches claude-code mergeHookInstructions).
   */
  customInstructions?: string;
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
    // Why this compaction fired, surfaced on the COMPRESSED result so the UI
    // notice is accurate. Defaults by trigger; the gate below upgrades it to
    // 'image_overflow' when the screenshot trigger is what let it through.
    let triggerReason: CompactionTriggerReason =
      compactTrigger === 'manual' ? 'manual' : 'token_limit';
    const chatCompressionSettings = config.getChatCompression();
    const slimmingConfig = resolveSlimmingConfig(chatCompressionSettings);
    const tuning = resolveCompactionTuning(chatCompressionSettings);

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
        // count, so computer-use sessions don't drown the model in stale
        // screenshots. Only counted in the would-be-NOOP path and only when
        // enabled, so the common case pays nothing. Counts NESTED tool media
        // only (countToolResponseImages), not user-pasted top-level images.
        const screenshotOverflow =
          tuning.enableScreenshotTrigger &&
          countToolResponseImages(chat.getHistoryShallow(true)) >=
            tuning.screenshotTriggerThreshold;
        if (!screenshotOverflow) {
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

    // Slim the side-query input: replace inlineData with placeholders.
    // The original history (with images) is preserved separately for
    // the post-compact image restoration block.
    const slim = slimCompactionInput(curatedHistory);
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
      systemInstruction: buildCompressionSystemPrompt(
        opts.customInstructions,
        hookExtraInstructions,
      ),
      contents: [
        ...slim.slimmedHistory,
        {
          role: 'user',
          parts: [
            {
              text: 'First, reason in your <analysis> block. Then, produce the <state_snapshot> XML.',
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
            maxFiles: tuning.maxRecentFiles,
            maxImages: tuning.maxRecentImages,
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
      // Note: compressionInputTokenCount includes the entire compression
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
          compressionStatus: CompressionStatus.COMPRESSED,
          triggerReason,
        },
      };
    }
  }
}
