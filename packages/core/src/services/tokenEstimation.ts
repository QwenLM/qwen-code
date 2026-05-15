/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Content } from '@google/genai';
import {
  DEFAULT_IMAGE_TOKEN_ESTIMATE,
  estimateContentChars,
} from './compactionInputSlimming.js';

/**
 * Average bytes-per-token for char-based token estimation.
 * Matches claude-code's roughTokenCountEstimation default (tokens.ts).
 */
export const BYTES_PER_TOKEN = 4;

/**
 * Estimate the token count of a list of Content objects via char/4.
 *
 * Reuses `estimateContentChars` so that inlineData / functionCall /
 * functionResponse get the same treatment they receive when computing
 * compression split points — keeping the two estimators in sync prevents
 * the auto-compaction trigger and the splitter from disagreeing on size.
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
  return Math.ceil(totalChars / BYTES_PER_TOKEN);
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
  return estimateContentTokens([...history, userMessage], imageTokenEstimate);
}
