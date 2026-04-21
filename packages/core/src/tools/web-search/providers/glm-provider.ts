/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { BaseWebSearchProvider } from '../base-provider.js';
import type {
  WebSearchResult,
  WebSearchResultItem,
  GlmProviderConfig,
} from '../types.js';

const GLM_WEB_SEARCH_URL = 'https://open.bigmodel.cn/api/paas/v4/web_search';

interface GlmSearchResultItem {
  title: string;
  content: string;
  link: string;
  media?: string;
  icon?: string;
  refer?: string;
  publish_date?: string;
}

interface GlmSearchResponse {
  id: string;
  created: number;
  request_id: string;
  search_intent?: Array<{
    query: string;
    intent: 'SEARCH_ALL' | 'SEARCH_NONE' | 'SEARCH_ALWAYS';
    keywords: string;
  }>;
  search_result: GlmSearchResultItem[];
}

/**
 * Web search provider using ZhipuAI (GLM) Web Search API.
 * Docs: https://docs.bigmodel.cn/api-reference/工具-api/网络搜索
 */
export class GlmProvider extends BaseWebSearchProvider {
  readonly name = 'GLM';

  constructor(private readonly config: GlmProviderConfig) {
    super();
  }

  isAvailable(): boolean {
    return !!this.config.apiKey;
  }

  protected async performSearch(
    query: string,
    signal: AbortSignal,
  ): Promise<WebSearchResult> {
    const body: Record<string, unknown> = {
      search_query: query.slice(0, 70), // API limit: max 70 chars
      search_engine: this.config.searchEngine ?? 'search_std',
      search_intent: this.config.searchIntent ?? false,
      count: this.config.maxResults ?? 10,
      search_recency_filter: this.config.searchRecencyFilter ?? 'noLimit',
    };

    if (this.config.contentSize) {
      body['content_size'] = this.config.contentSize;
    }
    if (this.config.searchDomainFilter) {
      body['search_domain_filter'] = this.config.searchDomainFilter;
    }

    const response = await fetch(GLM_WEB_SEARCH_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify(body),
      signal,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(
        `[${this.name}] API request failed (HTTP ${response.status}): ${text}`,
      );
    }

    const data = (await response.json()) as GlmSearchResponse;

    const results: WebSearchResultItem[] = (data.search_result ?? []).map(
      (item) => ({
        title: item.title,
        url: item.link,
        content: item.content,
        publishedDate: item.publish_date,
      }),
    );

    return {
      query,
      results,
    };
  }
}
