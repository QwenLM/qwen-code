/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * WorkerRetrievalDataSource — routes DB query operations to the worker thread.
 *
 * Implements {@link IRetrievalDataSource} so that {@link RetrievalService} on the
 * main thread can execute all retrieval pipeline logic (RRF fusion, reranking,
 * LLM-based query enhancement) without holding any DB connections itself.
 *
 * Each method sends a `db_query` message to the worker and awaits the matching
 * `db_result` / `db_error` response.  The worker executes the query using the
 * MetadataStore, VectorStore, or SqliteGraphStore that it owns exclusively.
 */

import type {
  DbQueryOp,
  ScoredChunk,
  Chunk,
  VectorSearchResult,
  GraphExpansionResult,
} from './types.js';
import type { IRetrievalDataSource } from './retrievalService.js';

export class WorkerRetrievalDataSource implements IRetrievalDataSource {
  /**
   * @param send  Sends a DbQueryOp to the worker and resolves with the raw result.
   *              Provided by IndexService.sendDbQuery().
   */
  constructor(private readonly send: (op: DbQueryOp) => Promise<unknown>) {}

  async ftsSearch(query: string, limit: number): Promise<ScoredChunk[]> {
    return this.send({ type: 'fts_search', query, limit }) as Promise<
      ScoredChunk[]
    >;
  }

  async recentChunks(limit: number): Promise<ScoredChunk[]> {
    return this.send({ type: 'recent_chunks', limit }) as Promise<
      ScoredChunk[]
    >;
  }

  async chunksByIds(chunkIds: string[]): Promise<Chunk[]> {
    return this.send({ type: 'chunks_by_ids', chunkIds }) as Promise<Chunk[]>;
  }

  async primaryLanguages(): Promise<string[]> {
    return this.send({ type: 'primary_languages' }) as Promise<string[]>;
  }

  async vectorQuery(
    queryVector: number[],
    topK: number,
  ): Promise<VectorSearchResult[]> {
    return this.send({ type: 'vector_query', queryVector, topK }) as Promise<
      VectorSearchResult[]
    >;
  }

  async graphExpand(
    seedChunkIds: string[],
    options: { maxDepth: number; maxChunks: number },
  ): Promise<GraphExpansionResult | null> {
    return this.send({
      type: 'graph_expand',
      seedChunkIds,
      maxDepth: options.maxDepth,
      maxChunks: options.maxChunks,
    }) as Promise<GraphExpansionResult | null>;
  }
}
