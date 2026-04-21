/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GlmProvider } from './glm-provider.js';

describe('GlmProvider', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  describe('isAvailable', () => {
    it('should return true when apiKey is provided', () => {
      const provider = new GlmProvider({ type: 'glm', apiKey: 'test-key' });
      expect(provider.isAvailable()).toBe(true);
    });

    it('should return false when apiKey is missing', () => {
      const provider = new GlmProvider({ type: 'glm' });
      expect(provider.isAvailable()).toBe(false);
    });

    it('should return false when apiKey is empty string', () => {
      const provider = new GlmProvider({ type: 'glm', apiKey: '' });
      expect(provider.isAvailable()).toBe(false);
    });
  });

  describe('name', () => {
    it('should have name "GLM"', () => {
      const provider = new GlmProvider({ type: 'glm', apiKey: 'key' });
      expect(provider.name).toBe('GLM');
    });
  });

  describe('search', () => {
    const signal = new AbortController().signal;

    it('should call the GLM API with correct URL and headers', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          id: 'test-id',
          created: 1234567890,
          request_id: 'req-1',
          search_result: [],
        }),
      });
      global.fetch = mockFetch;

      const provider = new GlmProvider({ type: 'glm', apiKey: 'my-key' });
      await provider.search('test query', signal);

      expect(mockFetch).toHaveBeenCalledOnce();
      const [url, options] = mockFetch.mock.calls[0];
      expect(url).toBe('https://open.bigmodel.cn/api/paas/v4/web_search');
      expect(options.method).toBe('POST');
      expect(options.headers['Authorization']).toBe('Bearer my-key');
      expect(options.headers['Content-Type']).toBe('application/json');
    });

    it('should send correct default request body', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          id: 'id',
          created: 0,
          request_id: 'r',
          search_result: [],
        }),
      });
      global.fetch = mockFetch;

      const provider = new GlmProvider({ type: 'glm', apiKey: 'key' });
      await provider.search('hello world', signal);

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.search_query).toBe('hello world');
      expect(body.search_engine).toBe('search_std');
      expect(body.search_intent).toBe(false);
      expect(body.count).toBe(10);
      expect(body.search_recency_filter).toBe('noLimit');
    });

    it('should respect custom config options', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          id: 'id',
          created: 0,
          request_id: 'r',
          search_result: [],
        }),
      });
      global.fetch = mockFetch;

      const provider = new GlmProvider({
        type: 'glm',
        apiKey: 'key',
        searchEngine: 'search_pro_sogou',
        maxResults: 20,
        searchIntent: true,
        searchRecencyFilter: 'oneWeek',
        contentSize: 'high',
        searchDomainFilter: 'example.com',
      });
      await provider.search('query', signal);

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.search_engine).toBe('search_pro_sogou');
      expect(body.count).toBe(20);
      expect(body.search_intent).toBe(true);
      expect(body.search_recency_filter).toBe('oneWeek');
      expect(body.content_size).toBe('high');
      expect(body.search_domain_filter).toBe('example.com');
    });

    it('should truncate query to 70 characters', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          id: 'id',
          created: 0,
          request_id: 'r',
          search_result: [],
        }),
      });
      global.fetch = mockFetch;

      const longQuery = 'a'.repeat(100);
      const provider = new GlmProvider({ type: 'glm', apiKey: 'key' });
      await provider.search(longQuery, signal);

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.search_query.length).toBe(70);
    });

    it('should map search_result to WebSearchResultItem correctly', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          id: 'id',
          created: 0,
          request_id: 'r',
          search_result: [
            {
              title: 'Test Title',
              content: 'Test content snippet.',
              link: 'https://example.com/page',
              media: 'Example Site',
              publish_date: '2026-04-01',
            },
          ],
        }),
      });
      global.fetch = mockFetch;

      const provider = new GlmProvider({ type: 'glm', apiKey: 'key' });
      const result = await provider.search('query', signal);

      expect(result.query).toBe('query');
      expect(result.results).toHaveLength(1);
      expect(result.results[0]).toMatchObject({
        title: 'Test Title',
        url: 'https://example.com/page',
        content: 'Test content snippet.',
        publishedDate: '2026-04-01',
      });
    });

    it('should handle empty search_result array', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          id: 'id',
          created: 0,
          request_id: 'r',
          search_result: [],
        }),
      });
      global.fetch = mockFetch;

      const provider = new GlmProvider({ type: 'glm', apiKey: 'key' });
      const result = await provider.search('query', signal);

      expect(result.results).toHaveLength(0);
    });

    it('should throw an error on non-ok HTTP response', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        text: async () => 'Unauthorized',
      });

      const provider = new GlmProvider({ type: 'glm', apiKey: 'bad-key' });
      await expect(provider.search('query', signal)).rejects.toThrow(
        '[GLM] API request failed (HTTP 401)',
      );
    });

    it('should throw an error when not available (no apiKey)', async () => {
      const provider = new GlmProvider({ type: 'glm' });
      await expect(provider.search('query', signal)).rejects.toThrow(
        '[GLM] Provider is not available',
      );
    });

    it('should not include content_size in body when not configured', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          id: 'id',
          created: 0,
          request_id: 'r',
          search_result: [],
        }),
      });
      global.fetch = mockFetch;

      const provider = new GlmProvider({ type: 'glm', apiKey: 'key' });
      await provider.search('query', signal);

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body).not.toHaveProperty('content_size');
      expect(body).not.toHaveProperty('search_domain_filter');
    });
  });
});
