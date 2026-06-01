/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  Content,
  GenerateContentResponseUsageMetadata,
} from '@google/genai';
import {
  DEFAULT_IMAGE_TOKEN_ESTIMATE,
  TOKEN_TO_CHAR_RATIO,
  estimateContentChars,
} from './compactionInputSlimming.js';

/**
 * Average characters-per-token for char-based token estimation. The inputs
 * are character counts from `estimateContentChars` (i.e. `string.length`),
 * not byte counts — for CJK / multi-byte text the byte/char ratio differs
 * from 1, so a "bytes" name would mislead. Programmatically aliased to
 * compactionInputSlimming.ts's TOKEN_TO_CHAR_RATIO so the auto-compaction
 * trigger and the compression size estimator can never drift on this constant.
 * Matches claude-code's roughTokenCountEstimation default. (review #4168 R3.1)
 */
export const CHARS_PER_TOKEN = TOKEN_TO_CHAR_RATIO;

/**
 * Estimate the token count of a list of Content objects via char/4.
 *
 * Reuses `estimateContentChars` so that inlineData / functionCall /
 * functionResponse get the same treatment they receive when computing
 * compression size estimates — keeping the two estimators in sync prevents
 * the auto-compaction trigger and the compressor from disagreeing on size.
 *
 * Intended for the pre-send threshold gate only. char/4 is a conservative
 * lower bound (real tokenizers vary ±30%); using it to TRIGGER compaction
 * earlier is safe (false-positive), using it to SKIP compaction is not.
 */
export function estimateContentTokens(
  contents: Content[],
  imageTokenEstimate: number = DEFAULT_IMAGE_TOKEN_ESTIMATE,
): number {
  let totalChars = 0;
  for (const content of contents) {
    totalChars += estimateContentChars(content, imageTokenEstimate);
  }
  return Math.ceil(totalChars / CHARS_PER_TOKEN);
}

/**
 * Compute an effective prompt-token count for the auto-compaction gate.
 *
 * `lastPromptTokenCount` (from the previous turn's usage metadata) lacks
 * three things: the current user message, the previous model response that
 * was appended to local history after that prompt count was reported, and
 * any initial value on the very first send. This helper closes those gaps via
 * local estimation plus `lastOutputTokenCount` when available.
 *
 * WARNING: like estimateContentTokens, this is a conservative lower
 * bound. Use it to TRIGGER earlier, never to SKIP — the fallback path
 * (lastPromptTokenCount === 0) returns a pure estimate with no API-
 * authoritative anchor.
 */
export function estimatePromptTokens(
  history: Content[],
  userMessage: Content,
  lastPromptTokenCount: number,
  lastOutputTokenCount: number = 0,
  imageTokenEstimate: number = DEFAULT_IMAGE_TOKEN_ESTIMATE,
): number {
  if (lastPromptTokenCount > 0) {
    return (
      lastPromptTokenCount +
      lastOutputTokenCount +
      estimateContentTokens([userMessage], imageTokenEstimate)
    );
  }
  // First-send fallback (no API data yet): estimate from `history + userMessage`
  // only. This MISSES the system prompt (~8-15K), tool definitions (~5K),
  // skill content, and cache headers — typically ~15-20K of under-estimate.
  // The reactive overflow handler is the safety net if the hard-tier rescue
  // misses for that reason. See review #4168 R3.3.
  return estimateContentTokens([...history, userMessage], imageTokenEstimate);
}

export function getUsageOutputTokenCountForPromptEstimate(
  usage: GenerateContentResponseUsageMetadata | undefined,
): number {
  if (usage?.promptTokenCount === undefined) {
    return 0;
  }
  if (usage.totalTokenCount !== undefined) {
    return Math.max(0, usage.totalTokenCount - usage.promptTokenCount);
  }
  const candidates = Math.max(0, usage.candidatesTokenCount ?? 0);
  const thoughts = Math.max(0, usage.thoughtsTokenCount ?? 0);
  // Some OpenAI-compatible providers include reasoning tokens inside
  // candidatesTokenCount when totalTokenCount is unavailable. If candidates
  // already dominates thoughts, treat thoughts as potentially overlapping;
  // otherwise add the larger reasoning-only count so long-thinking responses
  // still advance the steady-state prompt estimate.
  return candidates >= thoughts ? candidates : candidates + thoughts;
}
