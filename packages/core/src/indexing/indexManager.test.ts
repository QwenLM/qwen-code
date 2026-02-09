/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';

// Mock ripgrepUtils before importing modules that depend on it
vi.mock('../utils/ripgrepUtils.js', () => ({
  runRipgrep: vi.fn(),
}));

import { IndexManager, type ProgressCallback } from './indexManager.js';
import { runRipgrep } from '../utils/ripgrepUtils.js';
import type {
  IMetadataStore,
  IVectorStore,
  IGraphStore,
  FileMetadata,
  Chunk,
  IndexingProgress,
  BuildCheckpoint,
  ScoredChunk,
  VectorSearchResult,
  GraphEntity,
  GraphRelation,
} from './types.js';
import type { ILlmClient } from './embeddingService.js';

const mockRunRipgrep = vi.mocked(runRipgrep);

/**
 * Creates a temporary test directory with sample files.
 */
async function createTestProject(): Promise<string> {
  const testDir = path.join(
    os.tmpdir(),
    `indexmanager_test_${crypto.randomBytes(8).toString('hex')}`,
  );
  await fs.promises.mkdir(testDir, { recursive: true });

  // Create some test files
  await fs.promises.writeFile(
    path.join(testDir, 'index.ts'),
    'export function main() { console.log("Hello"); }',
  );
  await fs.promises.writeFile(
    path.join(testDir, 'utils.ts'),
    'export function add(a: number, b: number) { return a + b; }',
  );
  await fs.promises.mkdir(path.join(testDir, 'src'), { recursive: true });
  await fs.promises.writeFile(
    path.join(testDir, 'src', 'helper.ts'),
    'export const PI = 3.14159;',
  );

  return testDir;
}

/**
 * Cleans up the test directory.
 */
async function cleanupTestProject(testDir: string): Promise<void> {
  if (fs.existsSync(testDir)) {
    await fs.promises.rm(testDir, { recursive: true, force: true });
  }
}

/**
 * Creates a mock MetadataStore.
 */
function createMockMetadataStore(): IMetadataStore {
  const files = new Map<string, FileMetadata>();
  const chunks = new Map<string, Chunk[]>();
  const embeddings = new Map<string, number[]>();
  let indexStatus: IndexingProgress = {
    status: 'idle',
    phase: 0,
    phaseProgress: 0,
    overallProgress: 0,
    scannedFiles: 0,
    totalFiles: 0,
    chunkedFiles: 0,
    embeddedChunks: 0,
    totalChunks: 0,
    storedChunks: 0,
    startTime: 0,
  };
  let checkpoint: BuildCheckpoint | null = null;

  return {
    insertFileMeta: vi.fn((fileList: FileMetadata[]) => {
      for (const file of fileList) {
        files.set(file.path, file);
      }
    }),
    getFileMeta: vi.fn((filePath: string) => files.get(filePath) || null),
    getAllFileMeta: vi.fn(() => Array.from(files.values())),
    deleteFileMeta: vi.fn((paths: string[]) => {
      for (const p of paths) files.delete(p);
    }),
    insertChunks: vi.fn((chunkList: Chunk[]) => {
      for (const chunk of chunkList) {
        const existing = chunks.get(chunk.filepath) || [];
        existing.push(chunk);
        chunks.set(chunk.filepath, existing);
      }
    }),
    getChunksByFilePath: vi.fn(
      (filePath: string) => chunks.get(filePath) || [],
    ),
    deleteChunksByFilePath: vi.fn((paths: string[]) => {
      for (const p of paths) chunks.delete(p);
    }),
    searchFTS: vi.fn((): ScoredChunk[] => []),
    getRecentChunks: vi.fn((): ScoredChunk[] => []),
    getPrimaryLanguages: vi.fn((): string[] => ['typescript', 'javascript']),
    getEmbeddingCache: vi.fn((key: string) => embeddings.get(key) || null),
    setEmbeddingCache: vi.fn((key: string, embedding: number[]) => {
      embeddings.set(key, embedding);
    }),
    getIndexStatus: vi.fn(() => indexStatus),
    updateIndexStatus: vi.fn((status: Partial<IndexingProgress>) => {
      indexStatus = { ...indexStatus, ...status };
    }),
    getCheckpoint: vi.fn(() => checkpoint),
    saveCheckpoint: vi.fn((cp: BuildCheckpoint) => {
      checkpoint = cp;
    }),
    clearCheckpoint: vi.fn(() => {
      checkpoint = null;
    }),
    close: vi.fn(),
  };
}

/**
 * Creates a mock VectorStore.
 */
function createMockVectorStore(): IVectorStore {
  const vectors = new Map<string, { chunk: Chunk; embedding: number[] }>();

  return {
    initialize: vi.fn(async () => {}),
    insertBatch: vi.fn(async (docs) => {
      for (const doc of docs) {
        vectors.set(doc.chunk.id, doc);
      }
    }),
    query: vi.fn(async (): Promise<VectorSearchResult[]> => []),
    deleteByFilePath: vi.fn(async (filePath: string) => {
      for (const [id, doc] of vectors) {
        if (doc.chunk.filepath === filePath) {
          vectors.delete(id);
        }
      }
    }),
    deleteByChunkIds: vi.fn(async (ids: string[]) => {
      for (const id of ids) vectors.delete(id);
    }),
    optimize: vi.fn(),
    destroy: vi.fn(),
  };
}

/**
 * Creates a mock GraphStore.
 */
function createMockGraphStore(): IGraphStore {
  const entities = new Map<string, GraphEntity>();
  const relations: GraphRelation[] = [];

  return {
    initialize: vi.fn(async () => {}),
    insertEntities: vi.fn(async (entityList) => {
      for (const entity of entityList) {
        entities.set(entity.id, entity);
      }
    }),
    insertRelations: vi.fn(async (relationList) => {
      relations.push(...relationList);
    }),
    getEntitiesByChunkIds: vi.fn(async () => []),
    query: vi.fn(async () => []),
    deleteByFilePath: vi.fn(async (filePath: string) => {
      for (const [id, entity] of entities) {
        if (entity.filePath === filePath) {
          entities.delete(id);
        }
      }
    }),
    getStats: vi.fn(async () => ({
      nodeCount: entities.size,
      edgeCount: relations.length,
    })),
    close: vi.fn(async () => {}),
  };
}

/**
 * Creates a mock LLM client.
 */
function createMockLlmClient(): ILlmClient {
  return {
    generateEmbedding: vi.fn(async (texts: string[]) =>
      texts.map(() => Array.from({ length: 1024 }, () => Math.random())),
    ),
  };
}

describe('IndexManager', () => {
  let testDir: string;
  let metadataStore: IMetadataStore;
  let vectorStore: IVectorStore;
  let graphStore: IGraphStore;
  let llmClient: ILlmClient;
  let indexManager: IndexManager;

  beforeEach(async () => {
    testDir = await createTestProject();
    metadataStore = createMockMetadataStore();
    vectorStore = createMockVectorStore();
    graphStore = createMockGraphStore();
    llmClient = createMockLlmClient();

    // Mock ripgrep to return file list (runRipgrep returns { stdout, truncated, error? })
    // Note: ripgrep returns absolute paths, which are then converted to relative paths
    mockRunRipgrep.mockResolvedValue({
      stdout: `${testDir}/index.ts\n${testDir}/utils.ts\n${testDir}/src/helper.ts`,
      truncated: false,
    });

    indexManager = new IndexManager(
      testDir,
      metadataStore,
      vectorStore,
      llmClient,
      graphStore,
      { enableGraph: true },
    );
  });

  afterEach(async () => {
    await cleanupTestProject(testDir);
    vi.clearAllMocks();
  });

  describe('build', () => {
    it('should complete full build process', async () => {
      const progressUpdates: IndexingProgress[] = [];
      const onProgress: ProgressCallback = (p) =>
        progressUpdates.push({ ...p });

      await indexManager.build(onProgress);

      // Verify progress was reported
      expect(progressUpdates.length).toBeGreaterThan(0);

      // Verify final status
      const finalProgress = progressUpdates[progressUpdates.length - 1];
      expect(finalProgress.status).toBe('done');
      expect(finalProgress.overallProgress).toBe(100);

      // Verify stores were called
      expect(metadataStore.insertFileMeta).toHaveBeenCalled();
      expect(metadataStore.insertChunks).toHaveBeenCalled();
      expect(vectorStore.insertBatch).toHaveBeenCalled();
      expect(vectorStore.optimize).toHaveBeenCalled();
      expect(graphStore.insertEntities).toHaveBeenCalled();
    });

    it('should report progress through all phases', async () => {
      const phases = new Set<number>();
      const statuses = new Set<string>();

      await indexManager.build((p) => {
        phases.add(p.phase);
        statuses.add(p.status);
      });

      // Should go through phases 1-4
      expect(phases.has(1)).toBe(true);
      expect(phases.has(2)).toBe(true);
      expect(phases.has(3)).toBe(true);
      expect(phases.has(4)).toBe(true);

      // Should report various statuses
      expect(statuses.has('scanning')).toBe(true);
      expect(statuses.has('chunking')).toBe(true);
      expect(statuses.has('embedding')).toBe(true);
      expect(statuses.has('storing')).toBe(true);
      expect(statuses.has('done')).toBe(true);
    });

    it('should handle errors gracefully', async () => {
      // Make LLM client fail - EmbeddingService is fault-tolerant
      // So embedding failures won't cause build() to throw
      llmClient.generateEmbedding = vi
        .fn()
        .mockRejectedValue(new Error('API Error'));

      // Build should complete (with some failed embeddings)
      // Note: EmbeddingService has retry logic (3 retries with exponential backoff)
      // so this test needs extra time
      await indexManager.build();

      // Build completes even with embedding failures (fault-tolerant design)
      const progress = indexManager.getProgress();
      // The status should be 'done' since EmbeddingService doesn't throw
      expect(progress.status).toBe('done');
    }, 30000);
  });

  describe('incrementalUpdate', () => {
    it('should process added files', async () => {
      const addedFile: FileMetadata = {
        path: 'new-file.ts',
        contentHash: 'newhash',
        lastModified: Date.now(),
        size: 100,
        language: 'typescript',
      };

      // Create the file in the test directory
      await fs.promises.writeFile(
        path.join(testDir, 'new-file.ts'),
        'export const newVar = 1;',
      );

      await indexManager.incrementalUpdate({
        added: [addedFile],
        modified: [],
        deleted: [],
      });

      expect(metadataStore.insertFileMeta).toHaveBeenCalled();
      expect(metadataStore.insertChunks).toHaveBeenCalled();
    });

    it('should handle deleted files', async () => {
      await indexManager.incrementalUpdate({
        added: [],
        modified: [],
        deleted: ['old-file.ts'],
      });

      expect(metadataStore.deleteFileMeta).toHaveBeenCalledWith([
        'old-file.ts',
      ]);
      expect(metadataStore.deleteChunksByFilePath).toHaveBeenCalledWith([
        'old-file.ts',
      ]);
      expect(vectorStore.deleteByFilePath).toHaveBeenCalledWith('old-file.ts');
      expect(graphStore.deleteByFilePath).toHaveBeenCalledWith('old-file.ts');
    });

    it('should handle modified files (delete then re-add)', async () => {
      const modifiedFile: FileMetadata = {
        path: 'index.ts',
        contentHash: 'modifiedhash',
        lastModified: Date.now(),
        size: 150,
        language: 'typescript',
      };

      await indexManager.incrementalUpdate({
        added: [],
        modified: [modifiedFile],
        deleted: [],
      });

      // Should delete first
      expect(metadataStore.deleteFileMeta).toHaveBeenCalledWith(['index.ts']);
      expect(vectorStore.deleteByFilePath).toHaveBeenCalledWith('index.ts');

      // Then re-add
      expect(metadataStore.insertFileMeta).toHaveBeenCalled();
    });
  });

  describe('pause/resume/cancel', () => {
    it('should update status when paused', () => {
      indexManager.pause();

      const progress = indexManager.getProgress();
      expect(progress.status).toBe('paused');
    });

    it('should resume from paused state', () => {
      indexManager.pause();
      indexManager.resume();

      const progress = indexManager.getProgress();
      expect(progress.status).not.toBe('paused');
    });

    it('should cancel operation', () => {
      indexManager.cancel();

      const progress = indexManager.getProgress();
      expect(progress.status).toBe('idle');
    });

    it('should save checkpoint on pause', () => {
      indexManager.pause();

      expect(metadataStore.saveCheckpoint).toHaveBeenCalled();
    });
  });

  describe('buildStreaming', () => {
    it('should complete streaming build', async () => {
      const progressUpdates: IndexingProgress[] = [];

      await indexManager.buildStreaming((p) => progressUpdates.push({ ...p }));

      expect(progressUpdates.length).toBeGreaterThan(0);

      const finalProgress = progressUpdates[progressUpdates.length - 1];
      expect(finalProgress.status).toBe('done');
    });

    it('should process files in batches', async () => {
      // Use small batch size to force multiple batches
      await indexManager.buildStreaming(undefined, { streamBatchSize: 1 });

      // Should have called checkpoint save multiple times (once per batch)
      expect(
        vi.mocked(metadataStore.saveCheckpoint).mock.calls.length,
      ).toBeGreaterThan(0);
    });
  });

  describe('getProgress', () => {
    it('should return current progress state', () => {
      const progress = indexManager.getProgress();

      expect(progress).toHaveProperty('status');
      expect(progress).toHaveProperty('phase');
      expect(progress).toHaveProperty('overallProgress');
    });

    it('should return a copy of progress (not reference)', () => {
      const progress1 = indexManager.getProgress();
      const progress2 = indexManager.getProgress();

      expect(progress1).not.toBe(progress2);
      expect(progress1).toEqual(progress2);
    });
  });

  describe('graph store integration', () => {
    it('should extract entities when graph is enabled', async () => {
      await indexManager.build();

      expect(graphStore.insertEntities).toHaveBeenCalled();
      expect(graphStore.insertRelations).toHaveBeenCalled();
    });

    it('should skip graph extraction when disabled', async () => {
      const managerNoGraph = new IndexManager(
        testDir,
        metadataStore,
        vectorStore,
        llmClient,
        null, // No graph store
        { enableGraph: false },
      );

      await managerNoGraph.build();

      // Graph store methods should not be called
      expect(graphStore.insertEntities).not.toHaveBeenCalled();
    });
  });
});
