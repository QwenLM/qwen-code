/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WebSearchTool, WebSearchToolParams } from './web-search.js';
import { Config } from '../config/config.js';
import { GeminiClient } from '../core/client.js';

// Mock GeminiClient and Config constructor
vi.mock('../core/client.js');
vi.mock('../config/config.js');

// Mock global fetch
const mockFetch = vi.fn();
global.fetch = mockFetch;

describe('WebSearchTool', () => {
  const abortSignal = new AbortController().signal;
  let mockGeminiClient: GeminiClient;
  let tool: WebSearchTool;

  beforeEach(() => {
    vi.clearAllMocks();
    const mockConfigInstance = {
      getGeminiClient: () => mockGeminiClient,
      getProxy: () => undefined,
      getTavilyApiKey: () => 'test-api-key', // Add the missing method
    } as unknown as Config;
    mockGeminiClient = new GeminiClient(mockConfigInstance);
    tool = new WebSearchTool(mockConfigInstance);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('build', () => {
    it('should return an invocation for a valid query', () => {
      const params: WebSearchToolParams = { query: 'test query' };
      const invocation = tool.build(params);
      expect(invocation).toBeDefined();
      expect(invocation.params).toEqual(params);
    });

    it('should throw an error for an empty query', () => {
      const params: WebSearchToolParams = { query: '' };
      expect(() => tool.build(params)).toThrow(
        "The 'query' parameter cannot be empty.",
      );
    });

    it('should throw an error for a query with only whitespace', () => {
      const params: WebSearchToolParams = { query: '   ' };
      expect(() => tool.build(params)).toThrow(
        "The 'query' parameter cannot be empty.",
      );
    });
  });

  describe('getDescription', () => {
    it('should return a description of the search', () => {
      const params: WebSearchToolParams = { query: 'test query' };
      const invocation = tool.build(params);
      expect(invocation.getDescription()).toBe(
        'Searching the web for: "test query"',
      );
    });
  });

  describe('execute', () => {
    it('should return search results for a successful query', async () => {
      const params: WebSearchToolParams = { query: 'successful query' };

      // Mock the fetch response
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          answer: 'Here are your results.',
          results: [],
        }),
      } as Response);

      const invocation = tool.build(params);
      const result = await invocation.execute(abortSignal);

      expect(result.llmContent).toBe(
        'Web search results for "successful query":\n\nHere are your results.',
      );
      expect(result.returnDisplay).toBe(
        'Search results for "successful query" returned.',
      );
      expect(result.sources).toEqual([]);
    });

    it('should handle no search results found', async () => {
      const params: WebSearchToolParams = { query: 'no results query' };

      // Mock the fetch response
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          answer: '',
          results: [],
        }),
      } as Response);

      const invocation = tool.build(params);
      const result = await invocation.execute(abortSignal);

      expect(result.llmContent).toBe(
        'No search results or information found for query: "no results query"',
      );
      expect(result.returnDisplay).toBe('No information found.');
    });

    it('should handle API errors gracefully', async () => {
      const params: WebSearchToolParams = { query: 'error query' };

      // Mock the fetch to reject
      mockFetch.mockRejectedValueOnce(new Error('API Failure'));

      const invocation = tool.build(params);
      const result = await invocation.execute(abortSignal);

      expect(result.llmContent).toContain('Error:');
      expect(result.llmContent).toContain('API Failure');
      expect(result.returnDisplay).toBe('Error performing web search.');
    });

    it('should correctly format results with sources', async () => {
      const params: WebSearchToolParams = { query: 'grounding query' };

      // Mock the fetch response
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          answer: 'This is a test response.',
          results: [
            { title: 'Example Site', url: 'https://example.com' },
            { title: 'Google', url: 'https://google.com' },
          ],
        }),
      } as Response);

      const invocation = tool.build(params);
      const result = await invocation.execute(abortSignal);

      const expectedLlmContent = `Web search results for "grounding query":

This is a test response.

Sources:
[1] Example Site (https://example.com)
[2] Google (https://google.com)`;

      expect(result.llmContent).toBe(expectedLlmContent);
      expect(result.returnDisplay).toBe(
        'Search results for "grounding query" returned.',
      );
      expect(result.sources).toHaveLength(2);
    });
  });
});
