/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EmbeddingService, type ILlmClient } from './embeddingService.js';
import { EmbeddingCache } from './embeddingCache.js';
import type { Chunk } from './types.js';

/**
 * Creates a mock chunk for testing.
 */
function createMockChunk(overrides: Partial<Chunk> = {}): Chunk {
  return {
    id: `chunk_${Math.random().toString(36).slice(2)}`,
    filepath: 'src/test.ts',
    content: 'function test() { return 42; }',
    startLine: 1,
    endLine: 3,
    index: 0,
    contentHash: 'hash_abc123',
    type: 'function',
    metadata: {
      language: 'typescript',
      functionName: 'test',
    },
    ...overrides,
  };
}

/**
 * Creates a mock embedding vector.
 */
function createMockEmbedding(dimension: number = 1024): number[] {
  return Array.from({ length: dimension }, () => Math.random());
}

describe('EmbeddingService', () => {
  let mockLlmClient: ILlmClient;
  let mockCache: EmbeddingCache;
  let service: EmbeddingService;

  beforeEach(() => {
    // Create mock LLM client
    mockLlmClient = {
      generateEmbedding: vi
        .fn()
        .mockImplementation(async (texts: string[]) =>
          texts.map(() => createMockEmbedding()),
        ),
    };

    // Create mock cache (memory-only, no SQLite)
    mockCache = new EmbeddingCache(null, { persistToSqlite: false });

    // Create service with test configuration
    service = new EmbeddingService(mockLlmClient, mockCache, {
      batchSize: 5,
      maxRetries: 2,
      retryDelayMs: 10,
    });
  });

  describe('embedChunks', () => {
    it('should return empty array for empty input', async () => {
      const results = await service.embedChunks([]);
      expect(results).toEqual([]);
      expect(mockLlmClient.generateEmbedding).not.toHaveBeenCalled();
    });

    it('should generate embeddings for chunks', async () => {
      const chunks = [
        createMockChunk(),
        createMockChunk({ content: 'another function' }),
      ];

      const results = await service.embedChunks(chunks);

      expect(results).toHaveLength(2);
      expect(results[0].chunk).toBe(chunks[0]);
      expect(results[0].embedding).toHaveLength(1024);
      expect(results[1].chunk).toBe(chunks[1]);
      expect(results[1].embedding).toHaveLength(1024);
      expect(mockLlmClient.generateEmbedding).toHaveBeenCalledTimes(1);
    });

    it('should use cache for repeated chunks', async () => {
      const chunk = createMockChunk();

      // First call - should generate
      const results1 = await service.embedChunks([chunk]);
      expect(mockLlmClient.generateEmbedding).toHaveBeenCalledTimes(1);

      // Second call with same chunk - should use cache
      const results2 = await service.embedChunks([chunk]);
      expect(mockLlmClient.generateEmbedding).toHaveBeenCalledTimes(1); // Still 1
      expect(results2[0].embedding).toEqual(results1[0].embedding);
    });

    it('should process chunks in batches', async () => {
      const chunks = Array.from({ length: 12 }, (_, i) =>
        createMockChunk({ id: `chunk_${i}`, content: `content ${i}` }),
      );

      await service.embedChunks(chunks);

      // With batchSize=5, 12 chunks should result in 3 API calls
      expect(mockLlmClient.generateEmbedding).toHaveBeenCalledTimes(3);
    });

    it('should handle mixed cached and uncached chunks', async () => {
      // Note: chunks must have different contentHash to be cached separately
      const chunk1 = createMockChunk({
        id: 'cached',
        content: 'cached content',
        contentHash: 'hash_1',
      });
      const chunk2 = createMockChunk({
        id: 'uncached',
        content: 'uncached content',
        contentHash: 'hash_2',
      });

      // Pre-cache chunk1
      await service.embedChunks([chunk1]);
      expect(mockLlmClient.generateEmbedding).toHaveBeenCalledTimes(1);

      // Now request both - chunk1 should be cached, chunk2 needs embedding
      const results = await service.embedChunks([chunk1, chunk2]);
      expect(results).toHaveLength(2);
      expect(mockLlmClient.generateEmbedding).toHaveBeenCalledTimes(2); // 1 initial + 1 for chunk2
    });

    it('should retry on failure', async () => {
      let callCount = 0;
      mockLlmClient.generateEmbedding = vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount < 2) {
          throw new Error('API temporarily unavailable');
        }
        return [createMockEmbedding()];
      });

      const chunks = [createMockChunk()];
      const results = await service.embedChunks(chunks);

      expect(results).toHaveLength(1);
      expect(callCount).toBe(2); // 1 failure + 1 success
    });

    it('should track statistics', async () => {
      const chunks = [
        createMockChunk({ id: '1', content: 'a' }),
        createMockChunk({ id: '2', content: 'b' }),
      ];

      await service.embedChunks(chunks);
      let stats = service.getStats();

      expect(stats.totalChunks).toBe(2);
      expect(stats.generatedChunks).toBe(2);
      expect(stats.cachedChunks).toBe(0);

      // Request same chunks again (should be cached)
      await service.embedChunks(chunks);
      stats = service.getStats();

      expect(stats.totalChunks).toBe(4);
      expect(stats.cachedChunks).toBe(2);
      expect(stats.cacheHitRate).toBeCloseTo(0.5, 1);
    });
  });

  describe('getStats', () => {
    it('should return correct cache hit rate', async () => {
      const stats = service.getStats();
      expect(stats.cacheHitRate).toBe(0); // No operations yet
    });
  });

  describe('resetStats', () => {
    it('should reset all statistics', async () => {
      const chunks = [createMockChunk()];
      await service.embedChunks(chunks);

      service.resetStats();
      const stats = service.getStats();

      expect(stats.totalChunks).toBe(0);
      expect(stats.cachedChunks).toBe(0);
      expect(stats.generatedChunks).toBe(0);
      expect(stats.failedChunks).toBe(0);
    });
  });

  describe('error handling', () => {
    it('should handle API errors gracefully', async () => {
      // EmbeddingService is designed to be fault-tolerant
      // When all retries fail, it returns empty results instead of throwing
      mockLlmClient.generateEmbedding = vi
        .fn()
        .mockRejectedValue(new Error('API Error'));

      const chunks = [createMockChunk()];
      const results = await service.embedChunks(chunks);

      // Should return empty results (no successful embeddings)
      expect(results).toHaveLength(0);

      // Stats should track the failure
      const stats = service.getStats();
      expect(stats.failedChunks).toBe(1);
    });

    it('should handle partial batch failures', async () => {
      let callCount = 0;
      mockLlmClient.generateEmbedding = vi.fn().mockImplementation(async () => {
        callCount++;
        // Fail permanently (exhaust retries)
        throw new Error('Persistent failure');
      });

      const chunks = [createMockChunk()];

      // Should not throw, but return empty results
      const results = await service.embedChunks(chunks);
      expect(results).toHaveLength(0);
      // With concurrent processing: initial retries (2) + failedBatch retry (2) = 4
      expect(callCount).toBe(4);
    });
  });

  describe('embedding input formatting', () => {
    it('should include metadata in embedding input', async () => {
      const chunk = createMockChunk({
        filepath: 'src/utils/helper.ts',
        type: 'function',
        metadata: {
          language: 'typescript',
          functionName: 'calculateSum',
          signature: '(a: number, b: number) => number',
        },
      });

      await service.embedChunks([chunk]);

      const callArgs = vi.mocked(mockLlmClient.generateEmbedding).mock
        .calls[0][0];
      expect(callArgs[0]).toContain('src/utils/helper.ts');
      expect(callArgs[0]).toContain('function');
      expect(callArgs[0]).toContain('calculateSum');
    });
  });
});
