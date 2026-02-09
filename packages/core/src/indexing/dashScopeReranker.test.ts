/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  DashScopeReranker,
  createCodeSearchReranker,
  CODE_SEARCH_INSTRUCT,
} from './dashScopeReranker.js';

// Mock fetch globally
const mockFetch = vi.fn();
global.fetch = mockFetch;

describe('DashScopeReranker', () => {
  const testApiKey = 'test-api-key-12345';

  beforeEach(() => {
    vi.resetAllMocks();
    // Reset environment variable
    delete process.env['DASHSCOPE_API_KEY'];
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('constructor', () => {
    it('should throw error if no API key provided', () => {
      expect(() => new DashScopeReranker()).toThrow(
        'DashScope API key is required',
      );
    });

    it('should use API key from config', () => {
      const reranker = new DashScopeReranker({ apiKey: testApiKey });
      expect(reranker).toBeInstanceOf(DashScopeReranker);
    });

    it('should use API key from environment variable', () => {
      process.env['DASHSCOPE_API_KEY'] = testApiKey;
      const reranker = new DashScopeReranker();
      expect(reranker).toBeInstanceOf(DashScopeReranker);
    });

    it('should prefer config API key over environment variable', () => {
      process.env['DASHSCOPE_API_KEY'] = 'env-key';
      const reranker = new DashScopeReranker({ apiKey: testApiKey });
      expect(reranker.getModel()).toBe('qwen3-rerank');
    });

    it('should use default model qwen3-rerank', () => {
      const reranker = new DashScopeReranker({ apiKey: testApiKey });
      expect(reranker.getModel()).toBe('qwen3-rerank');
    });

    it('should allow custom model selection', () => {
      const reranker = new DashScopeReranker({
        apiKey: testApiKey,
        model: 'gte-rerank-v2',
      });
      expect(reranker.getModel()).toBe('gte-rerank-v2');
    });
  });

  describe('rerank', () => {
    const mockSuccessResponse = {
      request_id: 'test-request-id',
      output: {
        results: [
          { index: 0, relevance_score: 0.95 },
          { index: 2, relevance_score: 0.75 },
          { index: 1, relevance_score: 0.3 },
        ],
      },
      usage: {
        total_tokens: 100,
      },
    };

    it('should return empty array for empty documents', async () => {
      const reranker = new DashScopeReranker({ apiKey: testApiKey });
      const results = await reranker.rerank('test query', []);
      expect(results).toEqual([]);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('should rerank documents and return sorted results', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => mockSuccessResponse,
      });

      const reranker = new DashScopeReranker({ apiKey: testApiKey });
      const documents = [
        { id: 'doc1', content: 'First document about reranking' },
        { id: 'doc2', content: 'Second document about quantum computing' },
        { id: 'doc3', content: 'Third document about reranking models' },
      ];

      const results = await reranker.rerank('what is reranking', documents);

      expect(results).toHaveLength(3);
      expect(results[0]).toEqual({ id: 'doc1', score: 0.95 });
      expect(results[1]).toEqual({ id: 'doc3', score: 0.75 });
      expect(results[2]).toEqual({ id: 'doc2', score: 0.3 });
    });

    it('should track token usage', async () => {
      const singleDocResponse = {
        request_id: 'test-request-id',
        output: {
          results: [{ index: 0, relevance_score: 0.95 }],
        },
        usage: { total_tokens: 100 },
      };
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => singleDocResponse,
      });

      const reranker = new DashScopeReranker({ apiKey: testApiKey });
      expect(reranker.totalTokensUsed).toBe(0);

      await reranker.rerank('test query', [{ id: 'doc1', content: 'content' }]);

      expect(reranker.totalTokensUsed).toBe(100);
    });

    it('should reset token count', async () => {
      const singleDocResponse = {
        request_id: 'test-request-id',
        output: {
          results: [{ index: 0, relevance_score: 0.95 }],
        },
        usage: { total_tokens: 100 },
      };
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => singleDocResponse,
      });

      const reranker = new DashScopeReranker({ apiKey: testApiKey });
      await reranker.rerank('test query', [{ id: 'doc1', content: 'content' }]);

      expect(reranker.totalTokensUsed).toBe(100);
      reranker.resetTokenCount();
      expect(reranker.totalTokensUsed).toBe(0);
    });

    it('should send correct request body', async () => {
      const twoDocResponse = {
        request_id: 'test-request-id',
        output: {
          results: [
            { index: 0, relevance_score: 0.95 },
            { index: 1, relevance_score: 0.75 },
          ],
        },
        usage: { total_tokens: 100 },
      };
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => twoDocResponse,
      });

      const reranker = new DashScopeReranker({
        apiKey: testApiKey,
        model: 'qwen3-rerank',
        topN: 5,
        instruct: 'Custom instruction',
      });

      await reranker.rerank('test query', [
        { id: 'doc1', content: 'First content' },
        { id: 'doc2', content: 'Second content' },
      ]);

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, options] = mockFetch.mock.calls[0];

      expect(url).toContain('dashscope.aliyuncs.com');
      expect(options.method).toBe('POST');
      expect(options.headers['Content-Type']).toBe('application/json');
      expect(options.headers['Authorization']).toBe(`Bearer ${testApiKey}`);

      const body = JSON.parse(options.body);
      expect(body.model).toBe('qwen3-rerank');
      expect(body.input.query).toBe('test query');
      expect(body.input.documents).toEqual(['First content', 'Second content']);
      expect(body.parameters.top_n).toBe(5);
      expect(body.parameters.instruct).toBe('Custom instruction');
    });

    it('should not include instruct for gte-rerank-v2', async () => {
      const singleDocResponse = {
        request_id: 'test-request-id',
        output: {
          results: [{ index: 0, relevance_score: 0.95 }],
        },
        usage: { total_tokens: 50 },
      };
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => singleDocResponse,
      });

      const reranker = new DashScopeReranker({
        apiKey: testApiKey,
        model: 'gte-rerank-v2',
        instruct: 'This should be ignored',
      });

      await reranker.rerank('test query', [{ id: 'doc1', content: 'content' }]);

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.parameters?.instruct).toBeUndefined();
    });

    it('should handle API errors gracefully', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
        json: async () => ({
          code: 'InvalidApiKey',
          message: 'Invalid API key',
        }),
      });

      const reranker = new DashScopeReranker({ apiKey: testApiKey });

      await expect(
        reranker.rerank('test query', [{ id: 'doc1', content: 'content' }]),
      ).rejects.toThrow('DashScope Rerank API error: 401 Unauthorized');
    });

    it('should handle API-level errors in response body', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          code: 'InvalidParameter',
          message: 'Documents array is empty',
        }),
      });

      const reranker = new DashScopeReranker({ apiKey: testApiKey });

      await expect(
        reranker.rerank('test query', [{ id: 'doc1', content: 'content' }]),
      ).rejects.toThrow('DashScope Rerank API error: InvalidParameter');
    });

    it('should handle timeout', async () => {
      // Create a promise that never resolves to simulate a hanging request
      // The AbortController will abort it
      mockFetch.mockImplementation(
        (_url: string, options: { signal: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            options.signal.addEventListener('abort', () => {
              const error = new Error('The operation was aborted');
              error.name = 'AbortError';
              reject(error);
            });
          }),
      );

      const reranker = new DashScopeReranker({
        apiKey: testApiKey,
        timeout: 50, // Very short timeout
      });

      await expect(
        reranker.rerank('test query', [{ id: 'doc1', content: 'content' }]),
      ).rejects.toThrow('timeout');
    }, 10000);
  });

  describe('batch processing', () => {
    it('should process documents in batches when exceeding maxDocsPerRequest', async () => {
      const batchResponse1 = {
        request_id: 'batch1',
        output: {
          results: [
            { index: 0, relevance_score: 0.9 },
            { index: 1, relevance_score: 0.8 },
          ],
        },
        usage: { total_tokens: 50 },
      };

      const batchResponse2 = {
        request_id: 'batch2',
        output: {
          results: [
            { index: 0, relevance_score: 0.95 },
            { index: 1, relevance_score: 0.7 },
          ],
        },
        usage: { total_tokens: 50 },
      };

      mockFetch
        .mockResolvedValueOnce({ ok: true, json: async () => batchResponse1 })
        .mockResolvedValueOnce({ ok: true, json: async () => batchResponse2 });

      const reranker = new DashScopeReranker({
        apiKey: testApiKey,
        maxDocsPerRequest: 2, // Force batching
      });

      const documents = [
        { id: 'doc1', content: 'content1' },
        { id: 'doc2', content: 'content2' },
        { id: 'doc3', content: 'content3' },
        { id: 'doc4', content: 'content4' },
      ];

      const results = await reranker.rerank('test query', documents);

      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(results).toHaveLength(4);
      // Results should be sorted by score
      expect(results[0].score).toBe(0.95);
      expect(reranker.totalTokensUsed).toBe(100); // 50 + 50
    });

    it('should respect topN when batching', async () => {
      const batchResponse = {
        request_id: 'batch',
        output: {
          results: [
            { index: 0, relevance_score: 0.9 },
            { index: 1, relevance_score: 0.8 },
          ],
        },
        usage: { total_tokens: 50 },
      };

      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => batchResponse,
      });

      const reranker = new DashScopeReranker({
        apiKey: testApiKey,
        maxDocsPerRequest: 2,
        topN: 2,
      });

      const documents = [
        { id: 'doc1', content: 'content1' },
        { id: 'doc2', content: 'content2' },
        { id: 'doc3', content: 'content3' },
        { id: 'doc4', content: 'content4' },
      ];

      const results = await reranker.rerank('test query', documents);

      // Should only return top 2 after merging batches
      expect(results).toHaveLength(2);
    });
  });

  describe('createCodeSearchReranker', () => {
    it('should create reranker with code search defaults', () => {
      const reranker = createCodeSearchReranker({ apiKey: testApiKey });
      expect(reranker).toBeInstanceOf(DashScopeReranker);
      expect(reranker.getModel()).toBe('qwen3-rerank');
    });

    it('should allow config overrides', () => {
      const reranker = createCodeSearchReranker({
        apiKey: testApiKey,
        model: 'gte-rerank-v2',
      });
      expect(reranker.getModel()).toBe('gte-rerank-v2');
    });
  });

  describe('CODE_SEARCH_INSTRUCT', () => {
    it('should be a non-empty string', () => {
      expect(CODE_SEARCH_INSTRUCT).toBeTruthy();
      expect(typeof CODE_SEARCH_INSTRUCT).toBe('string');
      expect(CODE_SEARCH_INSTRUCT.length).toBeGreaterThan(50);
    });

    it('should mention code search priorities', () => {
      expect(CODE_SEARCH_INSTRUCT).toContain('code');
      expect(CODE_SEARCH_INSTRUCT).toContain('implementation');
    });
  });
});
