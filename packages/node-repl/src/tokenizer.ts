/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Lightweight, dependency-free character-based token estimator. Standalone port
 * of qwen-code core's request-tokenizer, used only for the ~10k-token output
 * guardrail — it is a heuristic, not an exact tokenizer, and needs no wasm,
 * model, or network.
 *
 * Units are integers = tokens * 20, so estimates can be accumulated across
 * streamed chunks without float drift.
 */
export const TOKEN_ESTIMATE_UNITS_PER_TOKEN = 20;

function countNonAsciiChars(text: string): number {
  let count = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) >= 0x80) count++;
  }
  return count;
}

/**
 * Estimates token *units* (tokens * 20) for a string.
 * - Pure ASCII (code, English): ~4 chars/token  -> chars * 5.
 * - Non-ASCII (CJK etc.): ~1.1 tokens/char       -> chars * 22.
 */
export function estimateTextTokenUnits(text: string): number {
  if (!text || text.length === 0) return 0;
  const nonAsciiChars = countNonAsciiChars(text);
  if (nonAsciiChars === 0) {
    return text.length * 5; // 5 = 20 / 4
  }
  const asciiChars = text.length - nonAsciiChars;
  // 5 = 20 / 4; 22 = 20 * 1.1.
  return asciiChars * 5 + nonAsciiChars * 22;
}
