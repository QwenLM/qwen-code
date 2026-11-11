/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { outputTokenLimit, tokenLimit } from '../core/tokenLimits.js';
import type { Model } from '../provider/model/model.js';
import {
  ENV_AUTOCOMPACT_WINDOW,
  ENV_AUTOCOMPACT_PCT_OVERRIDE,
  ENV_BLOCKING_LIMIT_OVERRIDE,
} from '../config/brand.js';

/**
 * Headroom kept above the auto-compact trigger so that compression has a
 * chance to fire before the model's context window is fully consumed.
 */
export const MIN_AUTOCOMPACT_BUFFER_TOKENS = 13_000;
export const AUTOCOMPACT_BUFFER_RATIO = 0.05;
export const MAX_OUTPUT_TOKENS_FOR_SUMMARY = 20_000;

/**
 * Buffer between the compress threshold and the "warning" UI state.
 *
 * Intentionally equal to ERROR_THRESHOLD_BUFFER_TOKENS: the same
 * value is used for both, creating a single band where both warning and error
 * UI states are active simultaneously.  This is by design — the warning badge and error
 * colour appear together right below the auto-compact trigger, leaving the user
 * no ambiguity about needing to compress.
 */
export const WARNING_THRESHOLD_BUFFER_TOKENS = 20_000;

/**
 * Buffer between the compress threshold and the "error" UI state.
 * Currently identical to the warning buffer.
 */
export const ERROR_THRESHOLD_BUFFER_TOKENS = 20_000;

/**
 * Headroom kept above the absolute blocking limit. When usage exceeds
 * (effective context window - this buffer), we refuse to start another
 * turn until the user runs `/compact` manually.
 */
export const MANUAL_COMPACT_BUFFER_TOKENS = 3_000;

/**
 * The one session fact the threshold helpers need but cannot derive: which
 * context window this session selected for a model. Narrowed rather than a full
 * `Config` so these stay plain numeric helpers with no session dependency.
 */
/**
 * Returns the current request's input context window before compaction output
 * reservation. When the caller already resolved a window for the request, that
 * value is authoritative; otherwise the session's configured window is used, and
 * only a caller that supplies neither falls back to the session's listed model
 * limit. UI display should use this raw window.
 *
 * The session window and model snapshot arrive as arguments, never from a
 * process global: this module cannot tell which session is asking, and a
 * process serving several would otherwise read whichever session came last.
 *
 * Honors the ENV_AUTOCOMPACT_WINDOW env override (clamps the raw context
 * window down) so debugging can simulate smaller windows without rebuilds.
 */
export function getRawContextWindowSize(
  model: Model | undefined,
  resolvedContextWindow?: number,
): number {
  let contextWindow = resolvedContextWindow ?? tokenLimit(model);

  const overrideRaw = process.env[ENV_AUTOCOMPACT_WINDOW];
  if (overrideRaw) {
    const parsed = Number.parseInt(overrideRaw, 10);
    if (!Number.isNaN(parsed) && parsed > 0) {
      contextWindow = Math.min(contextWindow, parsed);
    }
  }

  return contextWindow;
}

export function getSummaryReserveTokens(model: Model | undefined): number {
  return Math.min(outputTokenLimit(model), MAX_OUTPUT_TOKENS_FOR_SUMMARY);
}

/**
 * Returns the input budget available before auto-compact should account for
 * the compact summary response.
 */
export function getEffectiveContextWindowSize(
  model: Model | undefined,
  resolvedContextWindow?: number,
): number {
  return Math.max(
    0,
    getRawContextWindowSize(model, resolvedContextWindow) -
      getSummaryReserveTokens(model),
  );
}

export function getAutoCompactBufferTokens(
  effectiveContextWindow: number,
): number {
  return Math.max(
    MIN_AUTOCOMPACT_BUFFER_TOKENS,
    Math.floor(effectiveContextWindow * AUTOCOMPACT_BUFFER_RATIO),
  );
}

export function getAutoCompactThresholdForContextWindow(
  effectiveContextWindow: number,
): number {
  if (effectiveContextWindow <= 0) return 0;

  const baseThreshold = Math.max(
    0,
    effectiveContextWindow - getAutoCompactBufferTokens(effectiveContextWindow),
  );

  const envPercent = process.env[ENV_AUTOCOMPACT_PCT_OVERRIDE];
  if (envPercent) {
    const parsed = Number.parseFloat(envPercent);
    if (!Number.isNaN(parsed) && parsed > 0 && parsed <= 100) {
      const percentageThreshold = Math.floor(
        effectiveContextWindow * (parsed / 100),
      );
      return Math.min(percentageThreshold, baseThreshold);
    }
  }

  return baseThreshold;
}

/**
 * The token count above which auto-compact should fire.
 *
 * Honors the ENV_AUTOCOMPACT_PCT_OVERRIDE env override (0–100) for
 * debugging — the override can only LOWER the threshold, never raise it.
 */
export function getAutoCompactThreshold(
  model: Model | undefined,
  resolvedContextWindow?: number,
): number {
  const effectiveContextWindow = getEffectiveContextWindowSize(
    model,
    resolvedContextWindow,
  );
  return getAutoCompactThresholdForContextWindow(effectiveContextWindow);
}

export interface TokenWarningState {
  /** Percentage of remaining headroom against the auto-compact threshold. */
  percentLeft: number;
  isAboveWarningThreshold: boolean;
  isAboveErrorThreshold: boolean;
  isAboveAutoCompactThreshold: boolean;
  /** Hard wall — refuse to send another turn until manual compaction. */
  isAtBlockingLimit: boolean;
}

/**
 * Compute the warning ladder for a given token usage. UI consumes
 * `percentLeft` plus the boolean flags; the auto-compact stage consumes
 * `isAboveAutoCompactThreshold`.
 *
 * Honors ENV_BLOCKING_LIMIT_OVERRIDE for debugging the blocking-limit path.
 */
export function calculateTokenWarningState(
  tokenUsage: number,
  model: Model | undefined,
  resolvedContextWindow?: number,
): TokenWarningState {
  const effectiveContextWindow = getEffectiveContextWindowSize(
    model,
    resolvedContextWindow,
  );
  return calculateTokenWarningStateForContextWindow(
    tokenUsage,
    effectiveContextWindow,
  );
}

export function calculateTokenWarningStateForContextWindow(
  tokenUsage: number,
  effectiveContextWindow: number,
): TokenWarningState {
  const autoCompactThreshold = getAutoCompactThresholdForContextWindow(
    effectiveContextWindow,
  );

  const percentLeft =
    autoCompactThreshold > 0
      ? Math.max(
          0,
          Math.round(
            ((autoCompactThreshold - tokenUsage) / autoCompactThreshold) * 100,
          ),
        )
      : 0;

  const warningThreshold =
    autoCompactThreshold - WARNING_THRESHOLD_BUFFER_TOKENS;
  const errorThreshold = autoCompactThreshold - ERROR_THRESHOLD_BUFFER_TOKENS;

  const defaultBlockingLimit =
    effectiveContextWindow - MANUAL_COMPACT_BUFFER_TOKENS;

  const blockingOverrideRaw = process.env[ENV_BLOCKING_LIMIT_OVERRIDE];
  const blockingOverride = blockingOverrideRaw
    ? Number.parseInt(blockingOverrideRaw, 10)
    : Number.NaN;
  const blockingLimit =
    !Number.isNaN(blockingOverride) && blockingOverride > 0
      ? blockingOverride
      : defaultBlockingLimit;

  return {
    percentLeft,
    isAboveWarningThreshold: tokenUsage >= warningThreshold,
    isAboveErrorThreshold: tokenUsage >= errorThreshold,
    isAboveAutoCompactThreshold: tokenUsage >= autoCompactThreshold,
    isAtBlockingLimit: tokenUsage >= blockingLimit,
  };
}
