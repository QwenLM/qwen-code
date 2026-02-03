/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as crypto from 'node:crypto';

import { VectorStore, getVectorStoreDir } from './vectorStore.js';
import type { Chunk } from '../types.js';

/**
 * Generates a unique test project hash to avoid conflicts.
 */
function generateTestHash(): string {
  return `test_${crypto.randomBytes(8).toString('hex')}`;
}

/**
 * Creates a mock Chunk object.
 */
function createMockChunk(overrides: Partial<Chunk> = {}): Chunk {
  return {
    id: crypto.randomUUID(),
    filepath: 'src/index.ts',
    content: 'function hello() { return "world"; }',
    startLine: 1,
    endLine: 3,
    index: 0,
    contentHash: 'chunk_hash_123',
    type: 'function',
    metadata: {
      language: 'typescript',
      functionName: 'hello',
    },
    ...overrides,
  };
}

/**
 * Generates a random embedding vector.
 */
function generateRandomEmbedding(dimension: number = 1024): number[] {
  const embedding: number[] = [];
  for (let i = 0; i < dimension; i++) {
    embedding.push(Math.random() * 2 - 1); // Random values between -1 and 1
  }
  // Normalize to unit vector for cosine similarity
  const norm = Math.sqrt(embedding.reduce((sum, val) => sum + val * val, 0));
  return embedding.map((val) => val / norm);
}

describe('VectorStore', () => {
  let store: VectorStore;
  let testHash: string;
  let vectorDir: string;

  beforeEach(async () => {
    testHash = generateTestHash();
    vectorDir = getVectorStoreDir(testHash);
    store = new VectorStore(testHash);
    await store.initialize();
  });

  afterEach(() => {
    // Destroy the store and clean up
    try {
      store.destroy();
    } catch {
      // Ignore errors during cleanup
    }

    // Remove test directory
    const indexDir = vectorDir.replace('/vectors', '');
    if (fs.existsSync(indexDir)) {
      fs.rmSync(indexDir, { recursive: true, force: true });
    }
  });

  describe('Initialization', () => {
    it('should initialize successfully', async () => {
      // Store was already initialized in beforeEach
      const stats = store.getStats();
      expect(stats.docCount).toBe(0);
    });

    it('should create collection directory', async () => {
      expect(fs.existsSync(vectorDir)).toBe(true);
    });
  });

  describe('Insert Operations', () => {
    it('should insert a single chunk with embedding', async () => {
      const chunk = createMockChunk();
      const embedding = generateRandomEmbedding();

      await store.insertBatch([{ chunk, embedding }]);

      const stats = store.getStats();
      expect(stats.docCount).toBe(1);
    });

    it('should insert multiple chunks in batch', async () => {
      const docs = [
        {
          chunk: createMockChunk({ id: 'chunk1' }),
          embedding: generateRandomEmbedding(),
        },
        {
          chunk: createMockChunk({ id: 'chunk2' }),
          embedding: generateRandomEmbedding(),
        },
        {
          chunk: createMockChunk({ id: 'chunk3' }),
          embedding: generateRandomEmbedding(),
        },
      ];

      await store.insertBatch(docs);

      const stats = store.getStats();
      expect(stats.docCount).toBe(3);
    });
  });

  describe('Query Operations', () => {
    it('should find similar vectors', async () => {
      // Create chunks with known embeddings
      const baseEmbedding = generateRandomEmbedding();

      // Create a similar embedding (slightly modified)
      const similarEmbedding = baseEmbedding.map(
        (v) => v + (Math.random() - 0.5) * 0.1,
      );
      // Normalize
      const norm = Math.sqrt(
        similarEmbedding.reduce((sum, val) => sum + val * val, 0),
      );
      const normalizedSimilar = similarEmbedding.map((v) => v / norm);

      // Create a different embedding
      const differentEmbedding = generateRandomEmbedding();

      const docs = [
        {
          chunk: createMockChunk({ id: 'similar', filepath: 'src/similar.ts' }),
          embedding: normalizedSimilar,
        },
        {
          chunk: createMockChunk({
            id: 'different',
            filepath: 'src/different.ts',
          }),
          embedding: differentEmbedding,
        },
      ];

      await store.insertBatch(docs);
      store.optimize();

      // Query with base embedding - should find similar chunk first
      const results = await store.query(baseEmbedding, 2);

      expect(results.length).toBe(2);
      // The similar embedding should have higher score (closer to 1 for cosine)
      expect(results[0].chunkId).toBe('similar');
    });

    it('should respect topK limit', async () => {
      const docs = Array.from({ length: 10 }, (_, i) => ({
        chunk: createMockChunk({ id: `chunk${i}` }),
        embedding: generateRandomEmbedding(),
      }));

      await store.insertBatch(docs);
      store.optimize();

      const results = await store.query(generateRandomEmbedding(), 5);

      expect(results.length).toBe(5);
    });

    it('should filter by file path', async () => {
      const docs = [
        {
          chunk: createMockChunk({ id: 'chunk1', filepath: 'src/auth.ts' }),
          embedding: generateRandomEmbedding(),
        },
        {
          chunk: createMockChunk({ id: 'chunk2', filepath: 'src/auth.ts' }),
          embedding: generateRandomEmbedding(),
        },
        {
          chunk: createMockChunk({ id: 'chunk3', filepath: 'src/utils.ts' }),
          embedding: generateRandomEmbedding(),
        },
      ];

      await store.insertBatch(docs);
      store.optimize();

      const results = await store.query(
        generateRandomEmbedding(),
        10,
        "file_path = 'src/auth.ts'",
      );

      expect(results.length).toBe(2);
      expect(results.every((r) => r.filePath === 'src/auth.ts')).toBe(true);
    });
  });

  describe('Delete Operations', () => {
    it('should delete vectors by file path', async () => {
      const docs = [
        {
          chunk: createMockChunk({ id: 'keep1', filepath: 'src/keep.ts' }),
          embedding: generateRandomEmbedding(),
        },
        {
          chunk: createMockChunk({ id: 'delete1', filepath: 'src/delete.ts' }),
          embedding: generateRandomEmbedding(),
        },
        {
          chunk: createMockChunk({ id: 'delete2', filepath: 'src/delete.ts' }),
          embedding: generateRandomEmbedding(),
        },
      ];

      await store.insertBatch(docs);

      let stats = store.getStats();
      expect(stats.docCount).toBe(3);

      await store.deleteByFilePath('src/delete.ts');

      stats = store.getStats();
      expect(stats.docCount).toBe(1);
    });

    it('should delete vectors by chunk IDs', async () => {
      const docs = [
        {
          chunk: createMockChunk({ id: 'id1' }),
          embedding: generateRandomEmbedding(),
        },
        {
          chunk: createMockChunk({ id: 'id2' }),
          embedding: generateRandomEmbedding(),
        },
        {
          chunk: createMockChunk({ id: 'id3' }),
          embedding: generateRandomEmbedding(),
        },
      ];

      await store.insertBatch(docs);

      let stats = store.getStats();
      expect(stats.docCount).toBe(3);

      await store.deleteByChunkIds(['id1', 'id2']);

      stats = store.getStats();
      expect(stats.docCount).toBe(1);
    });
  });

  describe('Optimize', () => {
    it('should optimize without error', async () => {
      const docs = Array.from({ length: 5 }, (_, i) => ({
        chunk: createMockChunk({ id: `chunk${i}` }),
        embedding: generateRandomEmbedding(),
      }));

      await store.insertBatch(docs);

      // Should not throw
      expect(() => store.optimize()).not.toThrow();
    });
  });
});
