/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WebSearchTool } from './index.js';
import type { Config } from '../../config/config.js';
import type { WebSearchConfig } from './types.js';
import { ApprovalMode } from '../../config/config.js';

describe('WebSearchTool', () => {
  let mockConfig: Config;

  beforeEach(() => {
    vi.resetAllMocks();
    mockConfig = {
      getApprovalMode: vi.fn(() => ApprovalMode.AUTO_EDIT),
      setApprovalMode: vi.fn(),
      getWebSearchConfig: vi.fn(),
    } as unknown as Config;
  });

  describe('formatSearchResults', () => {
    it('should use answer when available and append sources', async () => {
      const webSearchConfig: WebSearchConfig = {
        provider: [
          {
            type: 'tavily',
            apiKey: 'test-key',
          },
        ],
        default: 'tavily',
      };

      (
        mockConfig.getWebSearchConfig as ReturnType<typeof vi.fn>
      ).mockReturnValue(webSearchConfig);

      // Mock fetch to return search results with answer
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          query: 'test query',
          answer: 'This is a concise answer from the search provider.',
          results: [
            {
              title: 'Result 1',
              url: 'https://example.com/1',
              content: 'Content 1',
            },
            {
              title: 'Result 2',
              url: 'https://example.com/2',
              content: 'Content 2',
            },
          ],
        }),
      });

      const tool = new WebSearchTool(mockConfig);
      const invocation = tool.build({ query: 'test query' });
      const result = await invocation.execute(new AbortController().signal);

      expect(result.llmContent).toContain(
        'This is a concise answer from the search provider.',
      );
      expect(result.llmContent).toContain('Sources:');
      expect(result.llmContent).toContain(
        '[1] Result 1 (https://example.com/1)',
      );
      expect(result.llmContent).toContain(
        '[2] Result 2 (https://example.com/2)',
      );
    });

    it('should build informative summary when answer is not available', async () => {
      const webSearchConfig: WebSearchConfig = {
        provider: [
          {
            type: 'google',
            apiKey: 'test-key',
            searchEngineId: 'test-engine',
          },
        ],
        default: 'google',
      };

      (
        mockConfig.getWebSearchConfig as ReturnType<typeof vi.fn>
      ).mockReturnValue(webSearchConfig);

      // Mock fetch to return search results without answer
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          items: [
            {
              title: 'Google Result 1',
              link: 'https://example.com/1',
              snippet: 'This is a helpful snippet from the first result.',
            },
            {
              title: 'Google Result 2',
              link: 'https://example.com/2',
              snippet: 'This is a helpful snippet from the second result.',
            },
          ],
        }),
      });

      const tool = new WebSearchTool(mockConfig);
      const invocation = tool.build({ query: 'test query' });
      const result = await invocation.execute(new AbortController().signal);

      // Should contain formatted results with title, snippet, and source
      expect(result.llmContent).toContain('1. **Google Result 1**');
      expect(result.llmContent).toContain(
        'This is a helpful snippet from the first result.',
      );
      expect(result.llmContent).toContain('Source: https://example.com/1');
      expect(result.llmContent).toContain('2. **Google Result 2**');
      expect(result.llmContent).toContain(
        'This is a helpful snippet from the second result.',
      );
      expect(result.llmContent).toContain('Source: https://example.com/2');

      // Should include web_fetch hint
      expect(result.llmContent).toContain('web_fetch tool');
    });

    it('should include optional fields when available', async () => {
      const webSearchConfig: WebSearchConfig = {
        provider: [
          {
            type: 'tavily',
            apiKey: 'test-key',
          },
        ],
        default: 'tavily',
      };

      (
        mockConfig.getWebSearchConfig as ReturnType<typeof vi.fn>
      ).mockReturnValue(webSearchConfig);

      // Mock fetch to return results with score and publishedDate
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          query: 'test query',
          results: [
            {
              title: 'Result with metadata',
              url: 'https://example.com',
              content: 'Content with metadata',
              score: 0.95,
              published_date: '2024-01-15',
            },
          ],
        }),
      });

      const tool = new WebSearchTool(mockConfig);
      const invocation = tool.build({ query: 'test query' });
      const result = await invocation.execute(new AbortController().signal);

      // Should include relevance score
      expect(result.llmContent).toContain('Relevance: 95%');
      // Should include published date
      expect(result.llmContent).toContain('Published: 2024-01-15');
    });

    it('should handle empty results gracefully', async () => {
      const webSearchConfig: WebSearchConfig = {
        provider: [
          {
            type: 'google',
            apiKey: 'test-key',
            searchEngineId: 'test-engine',
          },
        ],
        default: 'google',
      };

      (
        mockConfig.getWebSearchConfig as ReturnType<typeof vi.fn>
      ).mockReturnValue(webSearchConfig);

      // Mock fetch to return empty results
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          items: [],
        }),
      });

      const tool = new WebSearchTool(mockConfig);
      const invocation = tool.build({ query: 'test query' });
      const result = await invocation.execute(new AbortController().signal);

      expect(result.llmContent).toContain('No search results found');
    });

    it('should limit to top 5 results in fallback mode', async () => {
      const webSearchConfig: WebSearchConfig = {
        provider: [
          {
            type: 'google',
            apiKey: 'test-key',
            searchEngineId: 'test-engine',
          },
        ],
        default: 'google',
      };

      (
        mockConfig.getWebSearchConfig as ReturnType<typeof vi.fn>
      ).mockReturnValue(webSearchConfig);

      // Mock fetch to return 10 results
      const items = Array.from({ length: 10 }, (_, i) => ({
        title: `Result ${i + 1}`,
        link: `https://example.com/${i + 1}`,
        snippet: `Snippet ${i + 1}`,
      }));

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ items }),
      });

      const tool = new WebSearchTool(mockConfig);
      const invocation = tool.build({ query: 'test query' });
      const result = await invocation.execute(new AbortController().signal);

      // Should only contain first 5 results
      expect(result.llmContent).toContain('1. **Result 1**');
      expect(result.llmContent).toContain('5. **Result 5**');
      expect(result.llmContent).not.toContain('6. **Result 6**');
      expect(result.llmContent).not.toContain('10. **Result 10**');
    });
  });

  describe('validation', () => {
    it('should throw validation error when query is empty', () => {
      const tool = new WebSearchTool(mockConfig);
      expect(() => tool.build({ query: '' })).toThrow(
        "The 'query' parameter cannot be empty",
      );
    });

    it('should throw validation error when provider is empty string', () => {
      const tool = new WebSearchTool(mockConfig);
      expect(() => tool.build({ query: 'test', provider: '' })).toThrow(
        "The 'provider' parameter cannot be empty",
      );
    });
  });

  describe('configuration', () => {
    it('should return error when web search is not configured', async () => {
      (
        mockConfig.getWebSearchConfig as ReturnType<typeof vi.fn>
      ).mockReturnValue(null);

      const tool = new WebSearchTool(mockConfig);
      const invocation = tool.build({ query: 'test query' });
      const result = await invocation.execute(new AbortController().signal);

      expect(result.error?.message).toContain('Web search is disabled');
      expect(result.llmContent).toContain('Web search is disabled');
    });

    it('should return descriptive message in getDescription when web search is not configured', () => {
      (
        mockConfig.getWebSearchConfig as ReturnType<typeof vi.fn>
      ).mockReturnValue(null);

      const tool = new WebSearchTool(mockConfig);
      const invocation = tool.build({ query: 'test query' });
      const description = invocation.getDescription();

      expect(description).toBe(
        ' (Web search is disabled - configure a provider in settings.json)',
      );
    });

    it('should return provider name in getDescription when web search is configured', () => {
      const webSearchConfig: WebSearchConfig = {
        provider: [
          {
            type: 'tavily',
            apiKey: 'test-key',
          },
        ],
        default: 'tavily',
      };

      (
        mockConfig.getWebSearchConfig as ReturnType<typeof vi.fn>
      ).mockReturnValue(webSearchConfig);

      const tool = new WebSearchTool(mockConfig);
      const invocation = tool.build({ query: 'test query' });
      const description = invocation.getDescription();

      expect(description).toBe(' (Searching the web via tavily)');
    });
  });
});
