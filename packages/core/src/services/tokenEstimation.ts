/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Content } from '@google/genai';
import {
  DEFAULT_IMAGE_TOKEN_ESTIMATE,
  estimateContentChars,
  TOKEN_TO_CHAR_RATIO,
} from './compactionInputSlimming.js';

/**
 * Average characters-per-token for char-based token estimation. The inputs
 * are character counts from `estimateContentChars` (i.e. `string.length`),
 * not byte counts — for CJK / multi-byte text the byte/char ratio differs
 * from 1, so a "bytes" name would mislead. (review #4168 R3.1)
 *
 * Re-exported from `compactionInputSlimming.ts`'s `TOKEN_TO_CHAR_RATIO`
 * (the single declaration). Previously this file declared a duplicate
 * `= 4` literal with the coupling enforced only by prose. If someone had
 * changed one constant without the other, the splitter and the gate
 * would disagree on content size — producing intermittent compression
 * quality degradation extremely hard to trace. (R7.4)
 */
export const CHARS_PER_TOKEN = TOKEN_TO_CHAR_RATIO;

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
  return Math.ceil(totalChars / CHARS_PER_TOKEN);
}

/**
 * Compute an effective prompt-token count for the auto-compaction gate.
 *
 * `lastPromptTokenCount` (from the previous turn's usage metadata) lacks
 * three things: the current user message, the previous turn's MODEL
 * RESPONSE that has since been appended to history, and any initial
 * value on the very first send. This helper closes all three gaps via
 * local estimation.
 *
 * R10.1: `lastCandidatesTokenCount` is the previous turn's
 * `candidatesTokenCount` (model output) — captured alongside
 * `lastPromptTokenCount` in the same usage-metadata handler. Without it
 * the steady-state estimate lags by one response (typically 500–5000
 * tokens) and the hard-tier rescue (which sits only HARD_BUFFER ≈ 3K
 * from the window edge) fires late, costing a doomed API round-trip
 * before reactive recovery catches the overflow.
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
  lastCandidatesTokenCount: number = 0,
): number {
  if (lastPromptTokenCount > 0) {
    return (
      lastPromptTokenCount +
      lastCandidatesTokenCount +
      estimateContentTokens([userMessage], imageTokenEstimate)
    );
  }
  // First-send fallback (no API data yet): estimate from `history + userMessage`
  // only. This MISSES the system prompt (~8-15K), tool definitions (~5K),
  // skill content, and cache headers — typically ~15-20K of under-estimate.
  // The reactive overflow handler is the safety net if the hard-tier rescue
  // misses for that reason. See review #4168 R3.3.
  //
  // The cold-start branch does NOT add `lastCandidatesTokenCount` — by
  // definition we have no prior API response when this branch runs, and
  // any pre-existing model turns are walked via `history`.
  return estimateContentTokens([...history, userMessage], imageTokenEstimate);
}
