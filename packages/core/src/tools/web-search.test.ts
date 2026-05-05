/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WebSearchTool, __resetWebSearchCallCount } from './web-search.js';
import type { Config } from '../config/config.js';
import { ToolErrorType } from './tool-error.js';

const mockFetch = vi.fn();

function buildMockConfig(overrides: Partial<Record<string, unknown>> = {}) {
  const cgConfig = {
    apiKey: 'test-key',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen-coder',
    ...overrides,
  };
  return {
    getContentGeneratorConfig: vi.fn(() => cgConfig),
    getModel: vi.fn(() => cgConfig.model),
    getApprovalMode: vi.fn(),
    setApprovalMode: vi.fn(),
    getSessionId: vi.fn(() => 'test-session'),
    getProxy: vi.fn(),
  } as unknown as Config;
}

function buildSearchResponse(
  results: Array<{
    title: string;
    url: string;
    snippet?: string;
    site_name?: string;
  }>,
) {
  return {
    ok: true,
    json: () =>
      Promise.resolve({
        search_info: {
          search_results: results.map((r, i) => ({ index: i, ...r })),
        },
        choices: [{ message: { content: '' } }],
      }),
    text: () => Promise.resolve(''),
  } as unknown as Response;
}

describe('WebSearchTool', () => {
  let mockConfig: Config;
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.resetAllMocks();
    mockFetch.mockReset();
    global.fetch = mockFetch as unknown as typeof fetch;
    mockConfig = buildMockConfig();
    __resetWebSearchCallCount(mockConfig);
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  describe('parameter validation', () => {
    it('rejects query shorter than 2 characters', () => {
      const tool = new WebSearchTool(mockConfig);
      expect(() => tool.build({ query: 'a' })).toThrow();
    });

    it('rejects allowed_domains > 25', () => {
      const tool = new WebSearchTool(mockConfig);
      const tooMany = Array.from({ length: 26 }, (_, i) => `d${i}.com`);
      expect(() =>
        tool.build({ query: 'foo bar', allowed_domains: tooMany }),
      ).toThrow();
    });

    it('accepts a valid query', () => {
      const tool = new WebSearchTool(mockConfig);
      expect(() => tool.build({ query: 'foo bar' })).not.toThrow();
    });
  });

  describe('backend unsupported', () => {
    it('returns WEB_SEARCH_PROVIDER_UNSUPPORTED when apiKey missing', async () => {
      const cfg = buildMockConfig({ apiKey: undefined });
      const tool = new WebSearchTool(cfg);
      const invocation = tool.build({ query: 'hello world' });
      const result = await invocation.execute(new AbortController().signal);
      expect(result.error?.type).toBe(
        ToolErrorType.WEB_SEARCH_PROVIDER_UNSUPPORTED,
      );
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  describe('successful search', () => {
    it('parses search_info and formats results', async () => {
      mockFetch.mockResolvedValueOnce(
        buildSearchResponse([
          {
            title: 'Result one',
            url: 'https://example.com/a',
            snippet: 'snippet a',
            site_name: 'example.com',
          },
          {
            title: 'Result two',
            url: 'https://other.com/b',
            snippet: 'snippet b',
          },
        ]),
      );
      const tool = new WebSearchTool(mockConfig);
      const invocation = tool.build({ query: 'hello world' });
      const result = await invocation.execute(new AbortController().signal);
      expect(result.error).toBeUndefined();
      expect(result.llmContent).toContain('Result one');
      expect(result.llmContent).toContain('Result two');
      expect(result.llmContent).toContain('https://example.com/a');
      expect(result.llmContent).toContain('Safety:');
      expect(result.returnDisplay).toContain('2 result(s)');
    });

    it('passes assigned_site_list when allowed_domains is set', async () => {
      mockFetch.mockResolvedValueOnce(
        buildSearchResponse([{ title: 'r', url: 'https://github.com/a' }]),
      );
      const tool = new WebSearchTool(mockConfig);
      const invocation = tool.build({
        query: 'hello world',
        allowed_domains: ['github.com', 'stackoverflow.com'],
      });
      await invocation.execute(new AbortController().signal);
      expect(mockFetch).toHaveBeenCalledOnce();
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.search_options.assigned_site_list).toEqual([
        'github.com',
        'stackoverflow.com',
      ]);
      expect(body.enable_search).toBe(true);
      expect(body.search_options.forced_search).toBe(true);
    });
  });

  describe('search_info location compatibility', () => {
    it('falls back to choices[0].message.search_info when top-level absent', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            choices: [
              {
                message: {
                  content: '',
                  search_info: {
                    search_results: [
                      {
                        index: 0,
                        title: 'nested',
                        url: 'https://example.com/nested',
                      },
                    ],
                  },
                },
              },
            ],
          }),
        text: () => Promise.resolve(''),
      } as unknown as Response);
      const tool = new WebSearchTool(mockConfig);
      const inv = tool.build({ query: 'hello world' });
      const r = await inv.execute(new AbortController().signal);
      expect(r.error).toBeUndefined();
      expect(r.llmContent).toContain('nested');
      expect(r.llmContent).toContain('https://example.com/nested');
    });
  });

  describe('blocked_domains', () => {
    it('filters results by exact host and subdomains', async () => {
      mockFetch.mockResolvedValueOnce(
        buildSearchResponse([
          { title: 'keep', url: 'https://github.com/a' },
          { title: 'drop1', url: 'https://evil.com/x' },
          { title: 'drop2', url: 'https://sub.evil.com/y' },
        ]),
      );
      const tool = new WebSearchTool(mockConfig);
      const invocation = tool.build({
        query: 'hello world',
        blocked_domains: ['evil.com'],
      });
      const result = await invocation.execute(new AbortController().signal);
      expect(result.llmContent).toContain('keep');
      expect(result.llmContent).not.toContain('drop1');
      expect(result.llmContent).not.toContain('drop2');
    });
  });

  describe('rate limiting', () => {
    it('blocks the 9th call in a session', async () => {
      mockFetch.mockResolvedValue(
        buildSearchResponse([{ title: 'r', url: 'https://example.com/a' }]),
      );
      const tool = new WebSearchTool(mockConfig);
      // first 8 calls succeed
      for (let i = 0; i < 8; i++) {
        const inv = tool.build({ query: `query ${i + 1}` });
        const r = await inv.execute(new AbortController().signal);
        expect(r.error).toBeUndefined();
      }
      // 9th call should be rate-limited
      const inv = tool.build({ query: 'query 9' });
      const r = await inv.execute(new AbortController().signal);
      expect(r.error?.type).toBe(ToolErrorType.WEB_SEARCH_RATE_LIMITED);
    });

    it('does not increment counter when backend fails', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        json: () => Promise.resolve({}),
        text: () => Promise.resolve('server error'),
      } as unknown as Response);
      const tool = new WebSearchTool(mockConfig);
      const inv1 = tool.build({ query: 'fails first' });
      const r1 = await inv1.execute(new AbortController().signal);
      expect(r1.error?.type).toBe(ToolErrorType.WEB_SEARCH_BACKEND_FAILED);

      // second call should still proceed (counter not incremented on failure)
      mockFetch.mockResolvedValueOnce(
        buildSearchResponse([{ title: 'ok', url: 'https://example.com/x' }]),
      );
      const inv2 = tool.build({ query: 'works second' });
      const r2 = await inv2.execute(new AbortController().signal);
      expect(r2.error).toBeUndefined();
    });
  });

  describe('error handling', () => {
    it('returns WEB_SEARCH_BACKEND_FAILED on HTTP error', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
        json: () => Promise.resolve({}),
        text: () => Promise.resolve('unauthorized'),
      } as unknown as Response);
      const tool = new WebSearchTool(mockConfig);
      const inv = tool.build({ query: 'hello world' });
      const r = await inv.execute(new AbortController().signal);
      expect(r.error?.type).toBe(ToolErrorType.WEB_SEARCH_BACKEND_FAILED);
      expect(r.error?.message).toContain('HTTP 401');
    });

    it('returns WEB_SEARCH_BACKEND_FAILED on network error', async () => {
      mockFetch.mockRejectedValueOnce(new Error('ENOTFOUND'));
      const tool = new WebSearchTool(mockConfig);
      const inv = tool.build({ query: 'hello world' });
      const r = await inv.execute(new AbortController().signal);
      expect(r.error?.type).toBe(ToolErrorType.WEB_SEARCH_BACKEND_FAILED);
    });

    it('returns WEB_SEARCH_NO_RESULTS when search_info empty', async () => {
      mockFetch.mockResolvedValueOnce(buildSearchResponse([]));
      const tool = new WebSearchTool(mockConfig);
      const inv = tool.build({ query: 'hello world' });
      const r = await inv.execute(new AbortController().signal);
      expect(r.error?.type).toBe(ToolErrorType.WEB_SEARCH_NO_RESULTS);
    });
  });

  describe('safety footer', () => {
    it('always appends prompt-injection safety notice to llmContent', async () => {
      mockFetch.mockResolvedValueOnce(
        buildSearchResponse([
          { title: 't', url: 'https://example.com/x', snippet: 's' },
        ]),
      );
      const tool = new WebSearchTool(mockConfig);
      const inv = tool.build({ query: 'hello world' });
      const r = await inv.execute(new AbortController().signal);
      expect(r.llmContent).toContain('untrusted data');
    });
  });

  describe('tool description', () => {
    it('warns about prompt injection in tool description', () => {
      const tool = new WebSearchTool(mockConfig);
      // Tool definition / description is exposed via the `description` field.
      const desc = (tool as unknown as { description: string }).description;
      expect(desc).toMatch(/UNTRUSTED EXTERNAL CONTENT/);
      expect(desc).toMatch(/ignore previous instructions/);
    });
  });
});
