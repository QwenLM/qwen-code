/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

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
    if (!text || text.length === 0) {
      return 0;
    }

    let asciiChars = 0;
    let nonAsciiChars = 0;

    for (let i = 0; i < text.length; i++) {
      const charCode = text.charCodeAt(i);
      if (charCode < 128) {
        asciiChars++;
      } else {
        nonAsciiChars++;
      }
    }

    const tokens = asciiChars / 4 + nonAsciiChars * 1.1;
    return Math.ceil(tokens);
  }
}
