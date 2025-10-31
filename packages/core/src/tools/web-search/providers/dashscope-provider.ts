/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { promises as fs } from 'node:fs';
import * as os from 'os';
import * as path from 'path';
import { BaseWebSearchProvider } from '../base-provider.js';
import type {
  WebSearchResult,
  WebSearchResultItem,
  DashScopeProviderConfig,
} from '../types.js';
import type { QwenCredentials } from '../../../qwen/qwenOAuth2.js';

interface DashScopeSearchItem {
  _id: string;
  snippet: string;
  title: string;
  url: string;
  timestamp: number;
  timestamp_format: string;
  hostname: string;
  hostlogo?: string;
  web_main_body?: string;
  _score?: number;
}

interface DashScopeSearchResponse {
  headers: Record<string, unknown>;
  rid: string;
  status: number;
  message: string | null;
  data: {
    total: number;
    totalDistinct: number;
    docs: DashScopeSearchItem[];
    keywords?: string[];
    qpInfos?: Array<{
      query: string;
      cleanQuery: string;
      sensitive: boolean;
      spellchecked: string;
      spellcheck: boolean;
      tokenized: string[];
      stopWords: string[];
      synonymWords: string[];
      recognitions: unknown[];
      rewrite: string;
      operator: string;
    }>;
    aggs?: unknown;
    extras?: Record<string, unknown>;
  };
  debug?: unknown;
  success: boolean;
}

// File System Configuration
const QWEN_DIR = '.qwen';
const QWEN_CREDENTIAL_FILENAME = 'oauth_creds.json';

/**
 * Get the path to the cached OAuth credentials file.
 */
function getQwenCachedCredentialPath(): string {
  return path.join(os.homedir(), QWEN_DIR, QWEN_CREDENTIAL_FILENAME);
}

/**
 * Load cached Qwen OAuth credentials from disk.
 */
async function loadQwenCredentials(): Promise<QwenCredentials | null> {
  try {
    const keyFile = getQwenCachedCredentialPath();
    const creds = await fs.readFile(keyFile, 'utf-8');
    return JSON.parse(creds) as QwenCredentials;
  } catch {
    return null;
  }
}

/**
 * Web search provider using Alibaba Cloud DashScope API.
 */
export class DashScopeProvider extends BaseWebSearchProvider {
  readonly name = 'DashScope';

  constructor(private readonly config: DashScopeProviderConfig) {
    super();
  }

  isAvailable(): boolean {
    return true;
    // return !!(this.config.apiKey && this.config.uid && this.config.appId);
  }

  /**
   * Get the access token for authentication.
   * Tries OAuth credentials first, falls back to apiKey if OAuth is not available.
   */
  private async getAccessToken(): Promise<string | null> {
    // Try to load OAuth credentials first
    const credentials = await loadQwenCredentials();
    if (credentials?.access_token) {
      // Check if token is not expired
      if (credentials.expiry_date && credentials.expiry_date > Date.now()) {
        return credentials.access_token;
      }
    }

    // Fallback to apiKey from config if OAuth is not available
    return this.config.apiKey || null;
  }

  protected async performSearch(
    query: string,
    signal: AbortSignal,
  ): Promise<WebSearchResult> {
    // Get access token from OAuth credentials or fallback to apiKey
    const accessToken = await this.getAccessToken();
    if (!accessToken) {
      throw new Error(
        'No access token available. Please authenticate using OAuth',
      );
    }

    const requestBody = {
      uq: query,
      page: 1,
      rows: this.config.maxResults || 10,
    };

    const response = await fetch(
      'https://pre-portal.qwen.ai/api/v1/indices/plugin/web_search',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify(requestBody),
        signal,
      },
    );

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(
        `API error: ${response.status} ${response.statusText}${text ? ` - ${text}` : ''}`,
      );
    }

    const data = (await response.json()) as DashScopeSearchResponse;

    if (data.status !== 0) {
      throw new Error(`API error: ${data.message || 'Unknown error'}`);
    }

    const results: WebSearchResultItem[] = (data.data?.docs || []).map(
      (item) => ({
        title: item.title,
        url: item.url,
        content: item.snippet,
        score: item._score,
        publishedDate: item.timestamp_format,
      }),
    );

    return {
      query,
      results,
    };
  }
}
