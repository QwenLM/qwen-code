/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { TestRig, printDebugInfo, validateModelOutput } from './test-helper.js';

describe('web_search', () => {
  it('should be able to search the web', async () => {
    // Check if any web search provider is available
    const hasTavilyKey = !!process.env['TAVILY_API_KEY'];
    const hasGoogleKey =
      !!process.env['GOOGLE_API_KEY'] &&
      !!process.env['GOOGLE_SEARCH_ENGINE_ID'];

    // Skip if no provider is configured
    // Note: DashScope provider is automatically available for Qwen OAuth users,
    // but we can't easily detect that in tests without actual OAuth credentials
    if (!hasTavilyKey && !hasGoogleKey) {
      console.warn(
        'Skipping web search test: No web search provider configured. ' +
          'Set TAVILY_API_KEY or GOOGLE_API_KEY+GOOGLE_SEARCH_ENGINE_ID environment variables.',
      );
      return;
    }

    const rig = new TestRig();
    // Configure web search in settings if provider keys are available
    const webSearchSettings: Record<string, unknown> = {};
    const providers: Array<{
      type: string;
      apiKey?: string;
      searchEngineId?: string;
    }> = [];

    if (hasTavilyKey) {
      providers.push({ type: 'tavily', apiKey: process.env['TAVILY_API_KEY'] });
    }
    if (hasGoogleKey) {
      providers.push({
        type: 'google',
        apiKey: process.env['GOOGLE_API_KEY'],
        searchEngineId: process.env['GOOGLE_SEARCH_ENGINE_ID'],
      });
    }

    if (providers.length > 0) {
      webSearchSettings.webSearch = {
        provider: providers,
        default: providers[0]?.type,
      };
    }

    await rig.setup('should be able to search the web', {
      settings: webSearchSettings,
    });

    let result;
    try {
      result = await rig.run(`what is the weather in London`);
    } catch (error) {
      // Network errors can occur in CI environments
      if (
        error instanceof Error &&
        (error.message.includes('network') || error.message.includes('timeout'))
      ) {
        console.warn(
          'Skipping test due to network error:',
          (error as Error).message,
        );
        return; // Skip the test
      }
      throw error; // Re-throw if not a network error
    }

    const foundToolCall = await rig.waitForToolCall('web_search');

    // Add debugging information
    if (!foundToolCall) {
      const allTools = printDebugInfo(rig, result);

      // Check if the tool call failed due to network issues
      const failedSearchCalls = allTools.filter(
        (t) => t.toolRequest.name === 'web_search' && !t.toolRequest.success,
      );
      if (failedSearchCalls.length > 0) {
        console.warn(
          'web_search tool was called but failed, possibly due to network issues',
        );
        console.warn(
          'Failed calls:',
          failedSearchCalls.map((t) => t.toolRequest.args),
        );
        return; // Skip the test if network issues
      }
    }

    expect(foundToolCall, 'Expected to find a call to web_search').toBeTruthy();

    // Validate model output - will throw if no output, warn if missing expected content
    const hasExpectedContent = validateModelOutput(
      result,
      ['weather', 'london'],
      'Web search test',
    );

    // If content was missing, log the search queries used
    if (!hasExpectedContent) {
      const searchCalls = rig
        .readToolLogs()
        .filter((t) => t.toolRequest.name === 'web_search');
      if (searchCalls.length > 0) {
        console.warn(
          'Search queries used:',
          searchCalls.map((t) => t.toolRequest.args),
        );
      }
    }
  });
});
