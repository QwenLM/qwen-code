/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as crypto from 'node:crypto';

import { MetadataStore, getIndexDir } from './metadataStore.js';
import type { Chunk, FileMetadata } from '../types.js';

/**
 * Generates a unique test project hash to avoid conflicts.
 */
function generateTestHash(): string {
  return `test_${crypto.randomBytes(8).toString('hex')}`;
}

/**
 * Creates a mock FileMetadata object.
 */
function createMockFile(overrides: Partial<FileMetadata> = {}): FileMetadata {
  return {
    path: 'src/index.ts',
    contentHash: 'abc123',
    lastModified: Date.now(),
    size: 1024,
    language: 'typescript',
    ...overrides,
  };
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

describe('MetadataStore', () => {
  let store: MetadataStore;
  let testHash: string;
  let indexDir: string;

  beforeEach(() => {
    testHash = generateTestHash();
    indexDir = getIndexDir(testHash);
    store = new MetadataStore(testHash);
  });

  afterEach(() => {
    // Close the store and clean up
    store.close();

    // Remove test directory
    if (fs.existsSync(indexDir)) {
      fs.rmSync(indexDir, { recursive: true, force: true });
    }
  });

  describe('File Metadata Operations', () => {
    it('should insert and retrieve file metadata', () => {
      const file = createMockFile({ path: 'src/app.ts' });

      store.insertFileMeta([file]);
      const retrieved = store.getFileMeta('src/app.ts');

      expect(retrieved).not.toBeNull();
      expect(retrieved?.path).toBe(file.path);
      expect(retrieved?.contentHash).toBe(file.contentHash);
      expect(retrieved?.size).toBe(file.size);
      expect(retrieved?.language).toBe(file.language);
    });

    it('should return null for non-existent file', () => {
      const result = store.getFileMeta('non/existent/file.ts');
      expect(result).toBeNull();
    });

    it('should get all file metadata', () => {
      const files = [
        createMockFile({ path: 'src/a.ts' }),
        createMockFile({ path: 'src/b.ts' }),
        createMockFile({ path: 'src/c.ts' }),
      ];

      store.insertFileMeta(files);
      const allFiles = store.getAllFileMeta();

      expect(allFiles).toHaveLength(3);
      expect(allFiles.map((f) => f.path).sort()).toEqual([
        'src/a.ts',
        'src/b.ts',
        'src/c.ts',
      ]);
    });

    it('should update existing file metadata on re-insert', () => {
      const file = createMockFile({ path: 'src/update.ts', contentHash: 'v1' });
      store.insertFileMeta([file]);

      const updatedFile = { ...file, contentHash: 'v2', size: 2048 };
      store.insertFileMeta([updatedFile]);

      const retrieved = store.getFileMeta('src/update.ts');
      expect(retrieved?.contentHash).toBe('v2');
      expect(retrieved?.size).toBe(2048);
    });

    it('should delete file metadata by paths', () => {
      const files = [
        createMockFile({ path: 'src/delete1.ts' }),
        createMockFile({ path: 'src/delete2.ts' }),
        createMockFile({ path: 'src/keep.ts' }),
      ];

      store.insertFileMeta(files);
      store.deleteFileMeta(['src/delete1.ts', 'src/delete2.ts']);

      expect(store.getFileMeta('src/delete1.ts')).toBeNull();
      expect(store.getFileMeta('src/delete2.ts')).toBeNull();
      expect(store.getFileMeta('src/keep.ts')).not.toBeNull();
    });
  });

  describe('Chunk Operations', () => {
    it('should insert and retrieve chunks', () => {
      const file = createMockFile({ path: 'src/chunks.ts' });
      store.insertFileMeta([file]);

      const chunks = [
        createMockChunk({ filepath: 'src/chunks.ts', index: 0 }),
        createMockChunk({ filepath: 'src/chunks.ts', index: 1 }),
      ];

      store.insertChunks(chunks);
      const retrieved = store.getChunksByFilePath('src/chunks.ts');

      expect(retrieved).toHaveLength(2);
      expect(retrieved[0].index).toBe(0);
      expect(retrieved[1].index).toBe(1);
    });

    it('should delete chunks when file is deleted (CASCADE)', () => {
      const file = createMockFile({ path: 'src/cascade.ts' });
      store.insertFileMeta([file]);

      const chunk = createMockChunk({ filepath: 'src/cascade.ts' });
      store.insertChunks([chunk]);

      // Verify chunk exists
      expect(store.getChunksByFilePath('src/cascade.ts')).toHaveLength(1);

      // Delete file (should cascade delete chunks)
      store.deleteFileMeta(['src/cascade.ts']);

      // Chunks should be gone
      expect(store.getChunksByFilePath('src/cascade.ts')).toHaveLength(0);
    });

    it('should delete chunks by file path', () => {
      const file = createMockFile({ path: 'src/manual.ts' });
      store.insertFileMeta([file]);

      const chunks = [
        createMockChunk({ filepath: 'src/manual.ts', index: 0 }),
        createMockChunk({ filepath: 'src/manual.ts', index: 1 }),
      ];
      store.insertChunks(chunks);

      store.deleteChunksByFilePath(['src/manual.ts']);
      expect(store.getChunksByFilePath('src/manual.ts')).toHaveLength(0);
    });
  });

  describe('FTS Search', () => {
    it('should find chunks via full-text search', () => {
      const file = createMockFile({ path: 'src/search.ts' });
      store.insertFileMeta([file]);

      const chunks = [
        createMockChunk({
          filepath: 'src/search.ts',
          content: 'function authenticate(user, password) { return true; }',
          index: 0,
        }),
        createMockChunk({
          filepath: 'src/search.ts',
          content: 'function logout() { session.clear(); }',
          index: 1,
        }),
      ];
      store.insertChunks(chunks);

      const results = store.searchFTS('authenticate', 10);

      expect(results.length).toBeGreaterThan(0);
      expect(results[0].content).toContain('authenticate');
    });

    it('should return empty array for no matches', () => {
      const file = createMockFile({ path: 'src/nomatch.ts' });
      store.insertFileMeta([file]);

      const chunk = createMockChunk({
        filepath: 'src/nomatch.ts',
        content: 'const x = 1;',
      });
      store.insertChunks([chunk]);

      const results = store.searchFTS('nonexistentterm12345', 10);
      expect(results).toHaveLength(0);
    });
  });

  describe('Embedding Cache', () => {
    it('should store and retrieve embeddings', () => {
      const cacheKey = 'test_embedding_key';
      const embedding = [0.1, 0.2, 0.3, 0.4, 0.5];

      store.setEmbeddingCache(cacheKey, embedding);
      const retrieved = store.getEmbeddingCache(cacheKey);

      expect(retrieved).not.toBeNull();
      expect(retrieved).toHaveLength(5);
      // Compare with tolerance for floating point
      for (let i = 0; i < embedding.length; i++) {
        expect(retrieved![i]).toBeCloseTo(embedding[i], 5);
      }
    });

    it('should return null for non-existent cache key', () => {
      const result = store.getEmbeddingCache('nonexistent_key');
      expect(result).toBeNull();
    });
  });

  describe('Index Status', () => {
    it('should get default index status', () => {
      const status = store.getIndexStatus();

      expect(status.status).toBe('idle');
      expect(status.phase).toBe(0);
      expect(status.overallProgress).toBe(0);
    });

    it('should update index status', () => {
      store.updateIndexStatus({
        status: 'scanning',
        phase: 1,
        phaseProgress: 50,
        overallProgress: 25,
        totalFiles: 100,
        scannedFiles: 25,
      });

      const status = store.getIndexStatus();

      expect(status.status).toBe('scanning');
      expect(status.phase).toBe(1);
      expect(status.phaseProgress).toBe(50);
      expect(status.totalFiles).toBe(100);
      expect(status.scannedFiles).toBe(25);
    });
  });

  describe('Build Checkpoint', () => {
    it('should save and retrieve checkpoint', () => {
      const checkpoint = {
        phase: 'chunking' as const,
        lastProcessedPath: 'src/halfway.ts',
        pendingChunkIds: ['chunk1', 'chunk2'],
        updatedAt: Date.now(),
      };

      store.saveCheckpoint(checkpoint);
      const retrieved = store.getCheckpoint();

      expect(retrieved).not.toBeNull();
      expect(retrieved?.phase).toBe('chunking');
      expect(retrieved?.lastProcessedPath).toBe('src/halfway.ts');
      expect(retrieved?.pendingChunkIds).toEqual(['chunk1', 'chunk2']);
    });

    it('should return null when no checkpoint exists', () => {
      // Default state has phase = NULL
      const checkpoint = store.getCheckpoint();
      expect(checkpoint).toBeNull();
    });

    it('should clear checkpoint', () => {
      store.saveCheckpoint({
        phase: 'embedding',
        lastProcessedPath: 'src/test.ts',
        pendingChunkIds: [],
        updatedAt: Date.now(),
      });

      store.clearCheckpoint();
      const checkpoint = store.getCheckpoint();

      expect(checkpoint).toBeNull();
    });
  });

  describe('Statistics', () => {
    it('should return correct counts', () => {
      // Initial stats
      let stats = store.getStats();
      expect(stats.fileCount).toBe(0);
      expect(stats.chunkCount).toBe(0);

      // Add data
      const file = createMockFile({ path: 'src/stats.ts' });
      store.insertFileMeta([file]);

      const chunks = [
        createMockChunk({ filepath: 'src/stats.ts', index: 0 }),
        createMockChunk({ filepath: 'src/stats.ts', index: 1 }),
      ];
      store.insertChunks(chunks);

      store.setEmbeddingCache('key1', [0.1, 0.2]);

      // Check updated stats
      stats = store.getStats();
      expect(stats.fileCount).toBe(1);
      expect(stats.chunkCount).toBe(2);
      expect(stats.cacheCount).toBe(1);
    });
  });
});
