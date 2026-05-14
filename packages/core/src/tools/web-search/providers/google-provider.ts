/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { BaseWebSearchProvider } from '../base-provider.js';
import type {
  WebSearchResult,
  WebSearchResultItem,
  GoogleProviderConfig,
} from '../types.js';

interface GoogleSearchItem {
  title: string;
  link: string;
  snippet?: string;
  displayLink?: string;
  formattedUrl?: string;
}

interface GoogleSearchResponse {
  items?: GoogleSearchItem[];
  searchInformation?: {
    totalResults?: string;
    searchTime?: number;
  };
}

/**
 * Web search provider using Google Custom Search API.
 */
export class GoogleProvider extends BaseWebSearchProvider {
  readonly name = 'Google';

  constructor(private readonly config: GoogleProviderConfig) {
    super();
  }

  isAvailable(): boolean {
    return !!(this.config.apiKey && this.config.searchEngineId);
  }

  protected async performSearch(
    query: string,
    signal: AbortSignal,
  ): Promise<WebSearchResult> {
    const params = new URLSearchParams({
      key: this.config.apiKey!,
      cx: this.config.searchEngineId!,
      q: query,
      num: String(this.config.maxResults || 10),
      safe: this.config.safeSearch || 'medium',
    });

    if (this.config.language) {
      params.append('lr', `lang_${this.config.language}`);
    }

    if (this.config.country) {
      params.append('cr', `country${this.config.country}`);
    }

    const url = `https://www.googleapis.com/customsearch/v1?${params.toString()}`;

    const response = await fetch(url, {
      method: 'GET',
      signal,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(
        `API error: ${response.status} ${response.statusText}${text ? ` - ${text}` : ''}`,
      );
    }

    const data = (await response.json()) as GoogleSearchResponse;

    const results: WebSearchResultItem[] = (data.items || []).map((item) => ({
      title: item.title,
      url: item.link,
      content: item.snippet,
    }));

    return {
      query,
      results,
    };
  }
}
