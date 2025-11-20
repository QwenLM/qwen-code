/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { TiktokenEncoding, Tiktoken } from 'tiktoken';
import { get_encoding } from 'tiktoken';

// Cache encodings globally to reuse across instances
const encodingCache = new Map<string, Tiktoken>();

/**
 * Text tokenizer for calculating text tokens using tiktoken
 */
export class TextTokenizer {
  private encodingName: string;

  constructor(encodingName: string = 'cl100k_base') {
    this.encodingName = encodingName;
  }

  /**
   * Initialize the tokenizer (lazy loading)
   */
  private async ensureEncoding(): Promise<Tiktoken | null> {
    // Check if we already have this encoding cached
    if (encodingCache.has(this.encodingName)) {
      return encodingCache.get(this.encodingName) || null;
    }

    try {
      // Use type assertion since we know the encoding name is valid
      const encoding = get_encoding(this.encodingName as TiktokenEncoding);
      encodingCache.set(this.encodingName, encoding);
      return encoding;
    } catch (error) {
      console.warn(
        `Failed to load tiktoken with encoding ${this.encodingName}:`,
        error,
      );
      return null;
    }
  }

  /**
   * Calculate tokens for text content
   */
  async calculateTokens(text: string): Promise<number> {
    if (!text) return 0;

    const encoding = await this.ensureEncoding();

    if (encoding) {
      try {
        return encoding.encode(text).length;
      } catch (error) {
        console.warn('Error encoding text with tiktoken:', error);
      }
    }

    // Fallback: rough approximation using character count
    // This is a conservative estimate: 1 token ≈ 4 characters for most languages
    return Math.ceil(text.length / 4);
  }

  /**
   * Calculate tokens for multiple text strings in parallel
   */
  async calculateTokensBatch(texts: string[]): Promise<number[]> {
    const encoding = await this.ensureEncoding();

    if (encoding) {
      try {
        return texts.map((text) => {
          if (!text) return 0;
          return encoding.encode(text).length;
        });
      } catch (error) {
        console.warn('Error encoding texts with tiktoken:', error);
        // In case of error, return fallback estimation for all texts
        return texts.map((text) => Math.ceil((text || '').length / 4));
      }
    }

    // Fallback for batch processing
    return texts.map((text) => Math.ceil((text || '').length / 4));
  }

  /**
   * Dispose of resources
   */
  dispose(): void {
    if (encodingCache.has(this.encodingName)) {
      try {
        const encoding = encodingCache.get(this.encodingName)!;
        encoding.free();
        encodingCache.delete(this.encodingName);
      } catch (error) {
        console.warn('Error freeing tiktoken encoding:', error);
      }
    }
  }

  /**
   * Get the encoding instance, useful for external consumers who want to reuse it
   */
  async getEncoding(): Promise<Tiktoken | null> {
    return await this.ensureEncoding();
  }
}
