/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { WebSearchProviderConfig } from '@qwen-code/qwen-code-core';
import type { Settings } from './settings.js';

/**
 * CLI arguments related to web search configuration
 */
export interface WebSearchCliArgs {
  tavilyApiKey?: string;
  googleApiKey?: string;
  googleSearchEngineId?: string;
  webSearchDefault?: string;
}

/**
 * Web search configuration structure
 */
export interface WebSearchConfig {
  provider: WebSearchProviderConfig[];
  default: string;
}

/**
 * Build webSearch configuration from multiple sources with priority:
 * 1. settings.json (new format) - highest priority
 * 2. Command line args + environment variables
 * 3. Legacy tavilyApiKey (backward compatibility)
 *
 * @param argv - Command line arguments
 * @param settings - User settings from settings.json
 * @returns WebSearch configuration or undefined if no providers available
 */
export function buildWebSearchConfig(
  argv: WebSearchCliArgs,
  settings: Settings,
): WebSearchConfig | undefined {
  // Priority 1: Use settings.json webSearch config if present
  if (settings.webSearch) {
    return settings.webSearch;
  }

  // Priority 2: Build from command line args and environment variables
  const providers: WebSearchProviderConfig[] = [];

  // DashScope is always available (official, free)
  providers.push({ type: 'dashscope' } as WebSearchProviderConfig);

  // Tavily from args/env/legacy settings
  const tavilyKey =
    argv.tavilyApiKey ||
    settings.advanced?.tavilyApiKey ||
    process.env['TAVILY_API_KEY'];
  if (tavilyKey) {
    providers.push({
      type: 'tavily',
      apiKey: tavilyKey,
    } as WebSearchProviderConfig);
  }

  // Google from args/env
  const googleKey = argv.googleApiKey || process.env['GOOGLE_API_KEY'];
  const googleEngineId =
    argv.googleSearchEngineId || process.env['GOOGLE_SEARCH_ENGINE_ID'];
  if (googleKey && googleEngineId) {
    providers.push({
      type: 'google',
      apiKey: googleKey,
      searchEngineId: googleEngineId,
    } as WebSearchProviderConfig);
  }

  // If no providers configured, return undefined
  if (providers.length === 0) {
    return undefined;
  }

  // Determine default provider
  // Priority: CLI arg > has Tavily key > DashScope (fallback)
  const defaultProvider =
    argv.webSearchDefault || (tavilyKey ? 'tavily' : 'dashscope');

  return {
    provider: providers,
    default: defaultProvider,
  };
}
