/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Content } from '@google/genai';
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
 * two things: the current user message, and any initial value on the
 * very first send. This helper closes both gaps via local estimation.
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
  imageTokenEstimate: number = DEFAULT_IMAGE_TOKEN_ESTIMATE,
): number {
  if (lastPromptTokenCount > 0) {
    return (
      lastPromptTokenCount +
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
