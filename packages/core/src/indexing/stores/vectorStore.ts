/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';

// Use createRequire to load CommonJS module zvec in ESM context
const require = createRequire(import.meta.url);
// eslint-disable-next-line no-restricted-syntax
const zvec = require('zvec');
const {
  ZVecCollectionSchema,
  ZVecCreateAndOpen,
  ZVecOpen,
  ZVecDataType,
  ZVecIndexType,
  ZVecMetricType,
  ZVecInitialize,
  ZVecLogLevel,
  ZVecLogType,
} = zvec;
import type {
  ZVecCollection,
  ZVecDoc,
  ZVecFieldSchema,
  ZVecVectorSchema,
} from 'zvec';

import { Storage } from '../../config/storage.js';
import type { Chunk, IVectorStore, VectorSearchResult } from '../types.js';

/** Default embedding dimension for text-embedding-v4 model. */
const EMBEDDING_DIMENSION = 1024;

/** Batch size for vector insertions. */
const INSERT_BATCH_SIZE = 100;

/** Flag to track if Zvec has been globally initialized. */
let zvecInitialized = false;

/**
 * Gets the vector store directory path for a project.
 * @param projectHash SHA-256 hash of the project root path.
 * @returns Absolute path to the vector store directory.
 */
export function getVectorStoreDir(projectHash: string): string {
  return path.join(Storage.getGlobalQwenDir(), 'index', projectHash, 'vectors');
}

/**
 * Zvec-based vector storage for semantic code search.
 * Uses HNSW index with cosine similarity for efficient nearest neighbor search.
 */
export class VectorStore implements IVectorStore {
  private collection: ZVecCollection | null = null;
  private readonly collectionPath: string;
  private readonly collectionName = 'codebase_vectors';

  /**
   * Creates a new VectorStore instance.
   * @param projectHash SHA-256 hash of the project root path.
   */
  constructor(projectHash: string) {
    this.collectionPath = path.join(
      getVectorStoreDir(projectHash),
      this.collectionName,
    );
  }

  /**
   * Initializes the vector store, creating or opening the collection.
   */
  async initialize(): Promise<void> {
    // Global Zvec initialization (only once per process)
    if (!zvecInitialized) {
      ZVecInitialize({
        logType: ZVecLogType.CONSOLE,
        logLevel: ZVecLogLevel.WARN,
      });
      zvecInitialized = true;
    }

    // Check if collection already exists
    const collectionExists = fs.existsSync(this.collectionPath);

    if (collectionExists) {
      // Open existing collection
      try {
        this.collection = ZVecOpen(this.collectionPath);
      } catch {
        // If open fails, try to recreate
        await this.recreateCollection();
      }
    } else {
      // Create new collection
      await this.createCollection();
    }
  }

  /**
   * Creates the collection schema and initializes a new collection.
   */
  private async createCollection(): Promise<void> {
    // Ensure directory exists
    const dir = path.dirname(this.collectionPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    // Define vector field schema
    const contentEmbedding: ZVecVectorSchema = {
      name: 'content_embedding',
      dataType: ZVecDataType.VECTOR_FP32,
      dimension: EMBEDDING_DIMENSION,
      indexParams: {
        indexType: ZVecIndexType.HNSW,
        metricType: ZVecMetricType.COSINE,
      },
    };

    // Define scalar field schemas
    const chunkId: ZVecFieldSchema = {
      name: 'chunk_id',
      dataType: ZVecDataType.STRING,
      nullable: false,
    };

    const filePath: ZVecFieldSchema = {
      name: 'file_path',
      dataType: ZVecDataType.STRING,
      nullable: false,
      indexParams: {
        indexType: ZVecIndexType.INVERT, // Enable filtering by file path
      },
    };

    const chunkContent: ZVecFieldSchema = {
      name: 'chunk_content',
      dataType: ZVecDataType.STRING,
      nullable: false,
    };

    const startLine: ZVecFieldSchema = {
      name: 'start_line',
      dataType: ZVecDataType.INT64,
      nullable: false,
    };

    const endLine: ZVecFieldSchema = {
      name: 'end_line',
      dataType: ZVecDataType.INT64,
      nullable: false,
    };

    // Create collection schema
    const schema = new ZVecCollectionSchema({
      name: this.collectionName,
      vectors: [contentEmbedding],
      fields: [chunkId, filePath, chunkContent, startLine, endLine],
    });

    // Create and open collection
    this.collection = ZVecCreateAndOpen(this.collectionPath, schema);
  }

  /**
   * Recreates the collection by deleting and creating anew.
   */
  private async recreateCollection(): Promise<void> {
    // Remove existing collection
    if (fs.existsSync(this.collectionPath)) {
      fs.rmSync(this.collectionPath, { recursive: true, force: true });
    }

    // Create new collection
    await this.createCollection();
  }

  /**
   * Inserts chunks with their embeddings in batches.
   * @param docs Array of chunk-embedding pairs.
   */
  async insertBatch(
    docs: Array<{ chunk: Chunk; embedding: number[] }>,
  ): Promise<void> {
    if (!this.collection) {
      throw new Error('VectorStore not initialized');
    }

    for (let i = 0; i < docs.length; i += INSERT_BATCH_SIZE) {
      const batch = docs.slice(i, i + INSERT_BATCH_SIZE);
      const zvecDocs: ZVecDoc[] = batch.map(({ chunk, embedding }) => ({
        id: chunk.id,
        vectors: {
          content_embedding: new Float32Array(embedding),
        },
        fields: {
          chunk_id: chunk.id,
          file_path: chunk.filepath,
          chunk_content: chunk.content,
          start_line: chunk.startLine,
          end_line: chunk.endLine,
        },
      }));

      const result = this.collection.insert(zvecDocs);
      // insert returns an array of status objects
      const failedResults = Array.isArray(result)
        ? result.filter((r) => !r.ok)
        : [];
      if (failedResults.length > 0) {
        throw new Error(`Batch insert failed at index ${i}`);
      }
    }
  }

  /**
   * Performs vector similarity search.
   * @param queryVector Query embedding vector.
   * @param topK Number of results to return.
   * @param filter Optional filter expression (e.g., "file_path = 'src/index.ts'").
   * @returns Array of search results sorted by similarity.
   */
  async query(
    queryVector: number[],
    topK: number,
    filter?: string,
  ): Promise<VectorSearchResult[]> {
    if (!this.collection) {
      throw new Error('VectorStore not initialized');
    }

    const queryParams: {
      fieldName: string;
      topk: number;
      vector: Float32Array;
      filter?: string;
    } = {
      fieldName: 'content_embedding',
      topk: topK,
      vector: new Float32Array(queryVector),
    };

    if (filter) {
      queryParams.filter = filter;
    }

    const results = this.collection.query(queryParams);

    return results.map((doc: ZVecDoc, index: number) => ({
      chunkId: (doc.fields?.['chunk_id'] as string) ?? '',
      filePath: (doc.fields?.['file_path'] as string) ?? '',
      content: (doc.fields?.['chunk_content'] as string) ?? '',
      score: doc.score ?? 0,
      rank: index + 1,
    }));
  }

  /**
   * Deletes all vectors associated with a file path.
   * Uses loop-based deletion to handle files with more than 1000 chunks.
   * @param filePath File path to delete vectors for.
   */
  async deleteByFilePath(filePath: string): Promise<void> {
    if (!this.collection) {
      throw new Error('VectorStore not initialized');
    }

    const BATCH_SIZE = 1000;
    const filterExpr = `file_path = '${this.escapeFilterValue(filePath)}'`;

    // Zvec doesn't support direct filter-based deletion,
    // so we need to query for matching IDs first and then delete.
    // Loop until no more matching documents are found (handles large files).
    let deletedCount = 0;
    do {
      deletedCount = 0;
      const matchingDocs = this.collection.query({
        fieldName: 'content_embedding',
        topk: BATCH_SIZE,
        // Use a dummy vector for filter-only query
        vector: new Float32Array(1024).fill(0),
        filter: filterExpr,
      });

      for (const doc of matchingDocs) {
        if (doc.id) {
          this.collection.delete(doc.id);
          deletedCount++;
        }
      }
    } while (deletedCount >= BATCH_SIZE);
  }

  /**
   * Deletes vectors by chunk IDs.
   * @param chunkIds Array of chunk IDs to delete.
   */
  async deleteByChunkIds(chunkIds: string[]): Promise<void> {
    if (!this.collection) {
      throw new Error('VectorStore not initialized');
    }

    for (const id of chunkIds) {
      this.collection.delete(id);
    }
  }

  /**
   * Escapes a string value for use in filter expressions.
   * @param value Value to escape.
   * @returns Escaped value.
   */
  private escapeFilterValue(value: string): string {
    return value.replace(/'/g, "''");
  }

  /**
   * Optimizes the collection's internal structures for better performance.
   * Should be called after bulk insertions are complete.
   */
  optimize(): void {
    if (!this.collection) {
      throw new Error('VectorStore not initialized');
    }

    this.collection.optimize();
  }

  /**
   * Gets statistics about the vector store.
   * @returns Collection statistics.
   */
  getStats(): { docCount: number } {
    if (!this.collection) {
      throw new Error('VectorStore not initialized');
    }

    const stats = this.collection.stats;
    return {
      docCount: stats?.docCount ?? 0,
    };
  }

  /**
   * Destroys the collection and cleans up resources.
   * WARNING: This permanently deletes all data.
   */
  destroy(): void {
    if (this.collection) {
      this.collection.destroy();
      this.collection = null;
    }
  }

  /**
   * Closes the collection without destroying data.
   */
  close(): void {
    if (this.collection) {
      // Zvec doesn't have a close method, but we can clear the reference
      this.collection = null;
    }
  }
}
