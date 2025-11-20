/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { WebSearchProvider, WebSearchResult } from './types.js';

/**
 * Base implementation for web search providers.
 * Provides common functionality for error handling.
 */
export abstract class BaseWebSearchProvider implements WebSearchProvider {
  abstract readonly name: string;

  /**
   * Check if the provider is available (has required configuration).
   */
  abstract isAvailable(): boolean;

  /**
   * Perform the actual search implementation.
   * @param query The search query
   * @param signal Abort signal for cancellation
   * @returns Promise resolving to search results
   */
  protected abstract performSearch(
    query: string,
    signal: AbortSignal,
  ): Promise<WebSearchResult>;

  /**
   * Execute a web search with error handling.
   * @param query The search query
   * @param signal Abort signal for cancellation
   * @returns Promise resolving to search results
   */
  async search(query: string, signal: AbortSignal): Promise<WebSearchResult> {
    if (!this.isAvailable()) {
      throw new Error(
        `[${this.name}] Provider is not available. Please check your configuration.`,
      );
    }

    try {
      return await this.performSearch(query, signal);
    } catch (error: unknown) {
      if (
        error instanceof Error &&
        error.message.startsWith(`[${this.name}]`)
      ) {
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`[${this.name}] Search failed: ${message}`);
    }
  }
}
