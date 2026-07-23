/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

const NON_ASCII_RE = /[\u0080-\uffff]/;
export const TOKEN_ESTIMATE_UNITS_PER_TOKEN = 20;

/**
 * Text tokenizer for calculating text tokens using character-based estimation.
 *
 * Uses a lightweight character-based approach that is "good enough" for
 * guardrail features like sessionTokenLimit.
 *
 * Algorithm:
 * - ASCII characters: 0.25 tokens per char (4 chars = 1 token)
 * - Non-ASCII characters: 1.1 tokens per char (conservative for CJK, emoji, etc.)
 */
export function estimateTextTokens(text: string): number {
  if (!text || text.length === 0) {
    return 0;
  }

  if (!NON_ASCII_RE.test(text)) {
    return Math.ceil(text.length / 4);
  }

  const nonAsciiChars = countNonAsciiChars(text);
  const asciiChars = text.length - nonAsciiChars;

  return Math.ceil(asciiChars / 4 + nonAsciiChars * 1.1);
}

/** Returns 20 units per token so streams can accumulate without float drift. */
export function estimateTextTokenUnits(text: string): number {
  if (!text || text.length === 0) {
    return 0;
  }

  // Fast path: pure-ASCII text (code, English prose). A single regex scan
  // uses V8's optimized string search instead of a per-character JS loop.
  if (!NON_ASCII_RE.test(text)) {
    return text.length * 5;
  }

  const nonAsciiChars = countNonAsciiChars(text);
  const asciiChars = text.length - nonAsciiChars;

  // 5 = 20 / 4; 22 = 20 * 1.1. Keep in sync with estimateTextTokens().
  return asciiChars * 5 + nonAsciiChars * 22;
}

function countNonAsciiChars(text: string): number {
  let count = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) >= 128) {
      count++;
    }
  }
  return count;
}

export class TextTokenizer {
  /**
   * Calculate tokens for text content
   *
   * @param text - The text to estimate tokens for
   * @returns The estimated token count
   */
  async calculateTokens(text: string): Promise<number> {
    return this.calculateTokensSync(text);
  }

  /**
   * Calculate tokens for multiple text strings
   *
   * @param texts - Array of text strings to estimate tokens for
   * @returns Array of token counts corresponding to each input text
   */
  async calculateTokensBatch(texts: string[]): Promise<number[]> {
    return texts.map((text) => this.calculateTokensSync(text));
  }

  private calculateTokensSync(text: string): number {
    return estimateTextTokens(text);
  }
}
