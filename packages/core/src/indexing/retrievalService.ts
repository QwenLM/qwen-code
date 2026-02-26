/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Advanced Retrieval Service for Hybrid Code Search.
 *
 * Implements a multi-stage retrieval pipeline:
 * 1. Query Enhancement - HyDE, multi-query, synonym expansion
 * 2. Multi-Path Retrieval - BM25, vector similarity, recent files
 * 3. RRF Fusion - Reciprocal Rank Fusion for combining results
 * 4. Optional Reranking - LLM-based or cross-encoder reranking
 * 5. Graph Expansion - Dependency traversal for context enrichment
 * 6. Context Building - Formatting results for LLM consumption
 *
 * Based on research and best practices from:
 * - Continue's retrieval pipeline
 * - RAG-Fusion: Reciprocal Rank Fusion
 * - HyDE: Hypothetical Document Embeddings
 */

import type {
  GraphExpansionResult,
  RetrievalConfig,
  RetrievalResponse,
  ScoredChunk,
  Chunk,
  VectorSearchResult,
} from './types.js';
import { QueryEnhancer, type QueryEnhancerConfig } from './queryEnhancer.js';
import { ContextBuilder, type ContextBuilderConfig } from './contextBuilder.js';
import type { EmbeddingLlmClient } from './embeddingLlmClient.js';
import type { BaseLlmClient } from '../core/baseLlmClient.js';
import { createCodeSearchReranker } from './dashScopeReranker.js';

/**
 * Interface for reranking service.
 */
export interface IReranker {
  /**
   * Reranks a list of documents given a query.
   * @param query The search query.
   * @param documents Documents to rerank.
   * @returns Reranked documents with updated scores.
   */
  rerank(
    query: string,
    documents: Array<{ id: string; content: string }>,
  ): Promise<Array<{ id: string; score: number }>>;
}

/**
 * Default retrieval configuration.
 */
export const DEFAULT_RETRIEVAL_CONFIG: RetrievalConfig = {
  topK: 20,
  bm25TopK: 50,
  vectorTopK: 50,
  recentTopK: 20,
  rrfK: 60,
  maxTokens: 8000,
  enableGraph: true,
  graphDepth: 2,
  maxGraphNodes: 50,
  weights: {
    bm25: 1.0,
    vector: 1.0,
    recent: 0.5,
  },
};

/**
 * Options for retrieval operations.
 */
export interface RetrieveOptions {
  /** Number of final results to return. */
  topK?: number;
  /** Maximum tokens in context. */
  maxTokens?: number;
  /** Whether to enable graph expansion. */
  enableGraph?: boolean;
  /** Graph traversal depth. */
  graphDepth?: number;
  /** Maximum nodes in graph subgraph. */
  maxGraphNodes?: number;
  /** Custom weights for retrieval sources. */
  weights?: {
    bm25?: number;
    vector?: number;
    recent?: number;
  };
  /** Whether to enable LLM/cross-encoder reranking of fused results. */
  enableRerank?: boolean;
  /**
   * Penalty factor for test files (0-1).
   * Lower values = stronger penalty for test files.
   * Default: 0.1 (test files get 10% of their original score)
   */
  testFilePenalty?: number;
  /**
   * Boost factor for results appearing in multiple sources (1-2).
   * Higher values = stronger boost for cross-source confirmation.
   * Default: 1.3 (30% boost for each additional source)
   */
  multiSourceBoost?: number;
  /**
   * Minimum RRF score threshold (0-1).
   * Results below this threshold are filtered out.
   * Default: 0 (no filtering)
   */
  minScoreThreshold?: number;
  /**
   * Whether the query is about test code.
   * When true, the test-file penalty is skipped so test files rank normally.
   * Default: false
   */
  isTestRelated?: boolean;
}

/**
 * Async data source interface for DB-layer retrieval operations.
 * Implemented by {@link WorkerRetrievalDataSource}, which routes each call
 * to the worker thread via db_query messages so all DB I/O stays in the worker.
 */
export interface IRetrievalDataSource {
  ftsSearch(query: string, limit: number): Promise<ScoredChunk[]>;
  recentChunks(limit: number): Promise<ScoredChunk[]>;
  chunksByIds(ids: string[]): Promise<Chunk[]>;
  primaryLanguages(): Promise<string[]>;
  vectorQuery(
    queryVector: number[],
    topK: number,
  ): Promise<VectorSearchResult[]>;
  graphExpand(
    seedChunkIds: string[],
    options: { maxDepth: number; maxChunks: number },
  ): Promise<GraphExpansionResult | null>;
}

/**
 * Interface for scored chunk with fusion score.
 */
export interface FusedScoredChunk extends ScoredChunk {
  /** Fused score from RRF algorithm. */
  fusedScore: number;
  /** Sources that contributed to this result. */
  sources: Array<'bm25' | 'vector' | 'recent' | 'hyde'>;
}

/**
 * Advanced hybrid retrieval service combining multiple search strategies.
 * Implements a comprehensive retrieval pipeline:
 * 1. Query Enhancement - synonym expansion, HyDE, multi-query
 * 2. Multi-path Retrieval - BM25, vector, recent files
 * 3. RRF Fusion - reciprocal rank fusion for result combination
 * 4. Optional Reranking - LLM-based relevance scoring
 * 5. Graph Expansion - dependency traversal for context enrichment
 * 6. Context Building - formatting results for LLM consumption
 */
export class RetrievalService {
  private readonly config: RetrievalConfig;
  private readonly queryEnhancer: QueryEnhancer;
  private contextBuilder: ContextBuilder;
  private reranker?: IReranker;

  /**
   * Creates a new RetrievalService instance.
   *
   * @param llmClient Client for query.
   * @param embeddingLlmClient Client for generating embeddings.
   * @param config Optional configuration overrides.
   * @param queryEnhancerConfig Optional query enhancer configuration.
   */
  constructor(
    llmClient: BaseLlmClient | undefined,
    private readonly embeddingLlmClient: EmbeddingLlmClient | undefined,
    config: Partial<RetrievalConfig> = {},
    queryEnhancerConfig: Partial<QueryEnhancerConfig> = {},
    /**
     * Async data source that routes all DB operations to the worker thread.
     * Required — all DB calls (FTS, vector, graph, recent) go through this interface.
     */
    private readonly dataSource?: IRetrievalDataSource,
  ) {
    this.config = { ...DEFAULT_RETRIEVAL_CONFIG, ...config };
    this.queryEnhancer = new QueryEnhancer(queryEnhancerConfig, llmClient);
    this.contextBuilder = new ContextBuilder();

    if (process.env['DASHSCOPE_API_KEY']) {
      this.reranker = createCodeSearchReranker();
    }
  }

  /**
   * Performs advanced hybrid retrieval with optional enhancements.
   *
   * @param query Search query string.
   * @param options Retrieval options.
   * @returns Retrieval response with chunks, subgraph, and formatted views.
   */
  async retrieve(
    query: string,
    options: RetrieveOptions = {},
  ): Promise<RetrievalResponse> {
    const {
      topK = this.config.topK,
      maxTokens = this.config.maxTokens,
      enableGraph = this.config.enableGraph,
      graphDepth = this.config.graphDepth,
      maxGraphNodes = this.config.maxGraphNodes,
      weights = {},
      testFilePenalty = 0.1,
      multiSourceBoost = 1.3,
      minScoreThreshold = 0,
      enableRerank = true,
    } = options;

    const mergedWeights = {
      bm25: weights.bm25 ?? this.config.weights.bm25,
      vector: weights.vector ?? this.config.weights.vector,
      recent: weights.recent ?? this.config.weights.recent,
    };

    // Get primary languages from the repository's indexed files.
    // Fetched async when using dataSource (worker-backed), sync otherwise.
    // Start immediately in parallel with phase1 DB searches.
    const primaryLangsPromise: Promise<string[]> = this.dataSource
      ? this.dataSource.primaryLanguages()
      : Promise.resolve([]);

    // === Phase 1: Start original-query retrieval AND LLM enhancement in parallel ===
    // This eliminates the latency of waiting for LLM enhancement before searching.
    // Original-query searches begin immediately while the LLM generates enhanced queries.
    const phase1BM25Promise = this.bm25Search(query, this.config.bm25TopK);
    const phase1VectorPromise = this.vectorSearch(
      query,
      this.config.vectorTopK,
    );
    const phase1RecentPromise = this.recentFilesSearch(this.config.recentTopK);

    // Chain enhance off primaryLangsPromise so HyDE generates language-aware code.
    // Both start immediately; enhance begins as soon as primaryLanguages resolves.
    const enhancePromise = primaryLangsPromise.then((primaryLanguages) =>
      this.queryEnhancer.enhance(query, { primaryLanguages }),
    );

    const [phase1BM25, phase1Vector, phase1Recent, enhancedQuery] =
      await Promise.all([
        phase1BM25Promise,
        phase1VectorPromise,
        phase1RecentPromise,
        enhancePromise,
      ]);

    // === Phase 2: Additional enhanced-query retrieval (excluding original query) ===
    // Only search with queries that differ from the original to avoid duplication.
    const phase2Promises: Array<{
      promise: Promise<ScoredChunk[]>;
      source: 'bm25' | 'vector';
    }> = [];

    for (const bm25Query of enhancedQuery.bm25Queries) {
      if (bm25Query !== query) {
        phase2Promises.push({
          promise: this.bm25Search(bm25Query, this.config.bm25TopK),
          source: 'bm25',
        });
      }
    }

    for (const vectorQuery of enhancedQuery.vectorQueries) {
      if (vectorQuery !== query) {
        phase2Promises.push({
          promise: this.vectorSearch(vectorQuery, this.config.vectorTopK),
          source: 'vector',
        });
      }
    }

    const phase2Results = await Promise.all(
      phase2Promises.map((p) => p.promise),
    );

    // === Merge all sources for RRF fusion ===
    const sources: Array<{
      results: ScoredChunk[];
      weight: number;
      source: 'bm25' | 'vector' | 'recent';
    }> = [];

    // Phase 1 original-query results (highest weight — primary signal)
    sources.push({
      results: phase1BM25,
      weight: mergedWeights.bm25,
      source: 'bm25',
    });
    sources.push({
      results: phase1Vector,
      weight: mergedWeights.vector,
      source: 'vector',
    });
    sources.push({
      results: phase1Recent,
      weight: mergedWeights.recent,
      source: 'recent',
    });

    // Phase 2 enhanced-query results
    for (let i = 0; i < phase2Results.length; i++) {
      sources.push({
        results: phase2Results[i] ?? [],
        weight:
          phase2Promises[i]!.source === 'bm25'
            ? mergedWeights.bm25
            : mergedWeights.vector,
        source: phase2Promises[i]!.source,
      });
    }

    // 4. RRF Fusion with multi-source boost
    const fusedResults = this.rrfFusion(
      sources,
      this.config.rrfK,
      multiSourceBoost,
    );

    return this.postProcessResults(fusedResults, {
      query,
      topK,
      maxTokens,
      enableGraph,
      graphDepth,
      maxGraphNodes,
      testFilePenalty,
      multiSourceBoost,
      minScoreThreshold,
      enableRerank,
      isTestRelated: enhancedQuery.isTestRelated ?? false,
    });
  }

  /**
   * Performs hybrid retrieval with pre-enhanced queries, skipping the internal
   * query enhancement step. All post-processing stages (score threshold,
   * test-file penalty, reranking, graph expansion, context building) are
   * applied identically to {@link retrieve}.
   *
   * This is designed for callers that already have LLM-generated enhanced
   * queries (e.g. the codebaseSearch tool where the LLM provides bm25/vector
   * queries directly as tool parameters).
   *
   * @param rerankQuery Query string passed to the reranker for relevance scoring.
   * @param bm25Queries Pre-enhanced BM25 keyword queries.
   * @param vectorQueries Pre-enhanced vector/semantic queries.
   * @param options Retrieval options (same as {@link retrieve}).
   * @returns Retrieval response with chunks, graph data, and formatted views.
   */
  async retrieveWithEnhancedQueries(
    rerankQuery: string,
    bm25Queries: string[],
    vectorQueries: string[],
    options: RetrieveOptions = {},
  ): Promise<RetrievalResponse> {
    const {
      topK = this.config.topK,
      maxTokens = this.config.maxTokens,
      enableGraph = this.config.enableGraph,
      graphDepth = this.config.graphDepth,
      maxGraphNodes = this.config.maxGraphNodes,
      weights = {},
      testFilePenalty = 0.1,
      multiSourceBoost = 1.3,
      minScoreThreshold = 0,
      enableRerank = true,
      isTestRelated = false,
    } = options;

    const mergedWeights = {
      bm25: weights.bm25 ?? this.config.weights.bm25,
      vector: weights.vector ?? this.config.weights.vector,
      recent: weights.recent ?? this.config.weights.recent,
    };

    // Execute all BM25, vector, and recent searches in parallel.
    const bm25Promises = bm25Queries.map((q) =>
      this.bm25Search(q, this.config.bm25TopK),
    );
    const vectorPromises = vectorQueries.map((q) =>
      this.vectorSearch(q, this.config.vectorTopK),
    );
    const recentPromise = this.recentFilesSearch(this.config.recentTopK);

    const [bm25ResultArrays, vectorResultArrays, recentResults] =
      await Promise.all([
        Promise.all(bm25Promises),
        Promise.all(vectorPromises),
        recentPromise,
      ]);

    // Build RRF fusion sources.
    const sources: Array<{
      results: ScoredChunk[];
      weight: number;
      source: 'bm25' | 'vector' | 'recent';
    }> = [];

    for (const results of bm25ResultArrays) {
      sources.push({ results, weight: mergedWeights.bm25, source: 'bm25' });
    }
    for (const results of vectorResultArrays) {
      sources.push({
        results,
        weight: mergedWeights.vector,
        source: 'vector',
      });
    }
    sources.push({
      results: recentResults,
      weight: mergedWeights.recent,
      source: 'recent',
    });

    const fusedResults = this.rrfFusion(
      sources,
      this.config.rrfK,
      multiSourceBoost,
    );

    return this.postProcessResults(fusedResults, {
      query: rerankQuery,
      topK,
      maxTokens,
      enableGraph,
      graphDepth,
      maxGraphNodes,
      testFilePenalty,
      multiSourceBoost,
      minScoreThreshold,
      enableRerank,
      isTestRelated,
    });
  }

  /**
   * Shared post-processing pipeline applied after RRF fusion.
   *
   * Stages:
   * 1. Minimum score threshold filter
   * 2. Test file penalty (skipped for test-related queries)
   * 3. Optional reranking via cross-encoder
   * 4. Top-K selection
   * 5. Optional symbol-graph expansion
   * 6. Context view building
   */
  private async postProcessResults(
    fusedResults: FusedScoredChunk[],
    opts: {
      query: string;
      topK: number;
      maxTokens: number;
      enableGraph: boolean;
      graphDepth: number;
      maxGraphNodes: number;
      testFilePenalty: number;
      multiSourceBoost: number;
      minScoreThreshold: number;
      enableRerank: boolean;
      isTestRelated: boolean;
    },
  ): Promise<RetrievalResponse> {
    let results = fusedResults;

    // 1. Apply minimum score threshold filter
    if (opts.minScoreThreshold > 0) {
      const maxScore = results.length > 0 ? results[0].fusedScore : 0;
      if (maxScore > 0) {
        const absoluteThreshold = maxScore * opts.minScoreThreshold;
        results = results.filter((r) => r.fusedScore >= absoluteThreshold);
      }
    }

    // 2. Apply test file penalty (skip if query is test-related)
    const adjustedResults = !opts.isTestRelated
      ? this.applyTestFilePenalty(results, opts.testFilePenalty)
      : results;

    // 3. Optional reranking + 4. Top-K selection
    let topResults: FusedScoredChunk[];
    if (opts.enableRerank && this.reranker) {
      const rerankedResults = await this.rerank(
        opts.query,
        adjustedResults.slice(0, opts.topK * 5),
      );
      topResults = rerankedResults.slice(0, opts.topK);
    } else {
      topResults = adjustedResults.slice(0, opts.topK);
    }

    // 5. Optional graph expansion
    let symbolExpansion: GraphExpansionResult | null = null;
    if (opts.enableGraph && topResults.length > 0) {
      const seedChunkIds = topResults.map((r) => r.id);

      if (this.dataSource) {
        try {
          symbolExpansion = await this.dataSource.graphExpand(seedChunkIds, {
            maxDepth: opts.graphDepth,
            maxChunks: opts.maxGraphNodes,
          });
        } catch (error) {
          console.warn(`Symbol graph expansion failed: ${error}`);
        }
      }

      // Merge graph-discovered chunks with decaying scores
      if (symbolExpansion && symbolExpansion.relatedChunkIds.length > 0) {
        const existingIds = new Set(topResults.map((r) => r.id));
        const newChunkIds = symbolExpansion.relatedChunkIds.filter(
          (id) => !existingIds.has(id),
        );

        if (newChunkIds.length > 0) {
          try {
            const graphChunks = this.dataSource
              ? await this.dataSource.chunksByIds(newChunkIds)
              : [];

            const baseScore =
              topResults.length > 0
                ? topResults[topResults.length - 1]!.fusedScore * 0.5
                : 0.01;

            const graphScoredChunks: FusedScoredChunk[] = graphChunks.map(
              (chunk, idx) => ({
                id: chunk.id,
                filePath: chunk.filepath,
                content: chunk.content,
                startLine: chunk.startLine,
                endLine: chunk.endLine,
                score: baseScore * (1 / (idx + 1)),
                rank: topResults.length + idx + 1,
                source: 'vector' as const,
                fusedScore: baseScore * (1 / (idx + 1)),
                sources: ['vector' as const],
              }),
            );

            topResults.push(...graphScoredChunks);
          } catch (error) {
            console.warn(`Failed to load graph expansion chunks: ${error}`);
          }
        }
      }
    }

    // 6. Build context views
    topResults = topResults
      .sort((a, b) => b.fusedScore - a.fusedScore)
      .slice(0, opts.topK * 2);
    const textView = this.contextBuilder.buildTextView(
      topResults,
      opts.maxTokens,
    );

    return {
      chunks: topResults,
      subgraph: null,
      symbolExpansion,
      textView,
      graphView: null,
    };
  }

  /**
   * Reranks fused results using the configured reranker.
   */
  private async rerank(
    query: string,
    results: FusedScoredChunk[],
  ): Promise<FusedScoredChunk[]> {
    if (!this.reranker || results.length === 0) {
      return results;
    }

    try {
      const documents = results.map((c) => ({
        id: c.id,
        content: `
        ${c.filePath}:${c.startLine}-${c.endLine}

        ${c.content}
        `,
      }));

      const rerankedScores = await this.reranker.rerank(query, documents);

      // Create a map of reranked scores
      const scoreMap = new Map(rerankedScores.map((r) => [r.id, r.score]));

      // Update fused scores with reranked scores
      return results
        .map((chunk) => ({
          ...chunk,
          fusedScore: scoreMap.get(chunk.id) ?? chunk.fusedScore,
        }))
        .sort((a, b) => b.fusedScore - a.fusedScore);
    } catch {
      // Fall back to original results on error
      return results;
    }
  }

  /**
   * Performs BM25 full-text search using SQLite FTS5.
   *
   * @param query Search query (already enhanced for BM25).
   * @param topK Number of results to return.
   * @returns Array of scored chunks from BM25 search.
   */
  async bm25Search(query: string, topK: number): Promise<ScoredChunk[]> {
    if (!query.trim()) {
      return [];
    }

    if (!this.dataSource) {
      return [];
    }

    try {
      return await this.dataSource.ftsSearch(query, topK);
    } catch {
      return [];
    }
  }

  /**
   * Performs vector similarity search using embeddings.
   *
   * @param query Search query for embedding.
   * @param topK Number of results to return.
   * @returns Array of scored chunks from vector search.
   */
  async vectorSearch(query: string, topK: number): Promise<ScoredChunk[]> {
    if (!query.trim()) {
      return [];
    }

    // embeddingLlmClient is required for generating the query vector.
    if (!this.embeddingLlmClient) {
      return [];
    }

    try {
      // Embedding generation always happens here (main thread API call).
      const embeddings = await this.embeddingLlmClient.generateEmbedding([
        query,
      ]);
      if (!embeddings || embeddings.length === 0 || !embeddings[0]) {
        return [];
      }
      const queryVector = embeddings[0];

      if (!this.dataSource) {
        return [];
      }
      const results = await this.dataSource.vectorQuery(queryVector, topK);

      return results.map((r, index) => ({
        id: r.chunkId,
        filePath: r.filePath,
        content: r.content,
        startLine: r.startLine,
        endLine: r.endLine,
        score: r.score,
        rank: index + 1,
        source: 'vector' as const,
      }));
    } catch {
      return [];
    }
  }

  /**
   * Retrieves recently edited files as a retrieval source.
   * Recent files often contain contextually relevant code.
   *
   * @param topK Number of recent files to return.
   * @returns Array of scored chunks from recent files.
   */
  async recentFilesSearch(topK: number): Promise<ScoredChunk[]> {
    try {
      if (!this.dataSource) {
        return [];
      }
      return this.dataSource.recentChunks(topK);
    } catch {
      return [];
    }
  }

  /**
   * Performs Reciprocal Rank Fusion (RRF) on multiple result sets.
   *
   * RRF is a robust rank aggregation technique that combines results from
   * multiple retrieval systems without requiring score normalization.
   *
   * Formula: score(d) = Σ weight_i / (k + rank_i(d))
   *
   * Key parameters:
   * - k (rank_constant): Controls influence of lower-ranked documents
   *   - Higher k = more equal weighting across ranks
   *   - Lower k = stronger preference for top-ranked results
   *   - Default: 60 (standard value from Elasticsearch/FlashRAG)
   *
   * Enhancements over standard RRF:
   * 1. **Weighted sources**: Different retrieval methods can have different weights
   *    (e.g., BM25: 1.0, Vector: 1.0, Recent: 0.5)
   * 2. **Multi-source boost**: Documents found by both BM25 and Vector search
   *    receive a multiplicative boost, as cross-source confirmation
   *    indicates higher relevance confidence
   * 3. **Query decay**: Handled upstream - later query variations get lower weights
   *
   * @param sources Array of result sources with weights.
   * @param k RRF parameter (default: 60). Higher values give more influence to lower-ranked docs.
   * @param multiSourceBoost Boost factor for multi-source results (default: 1.3).
   * @returns Fused and sorted results.
   */
  rrfFusion(
    sources: Array<{
      results: ScoredChunk[];
      weight: number;
      source: 'bm25' | 'vector' | 'recent' | 'hyde';
    }>,
    k: number = 60,
    multiSourceBoost: number = 1.3,
  ): FusedScoredChunk[] {
    const scoreMap = new Map<
      string,
      {
        chunk: ScoredChunk;
        fusedScore: number;
        sources: Set<'bm25' | 'vector' | 'recent' | 'hyde'>;
      }
    >();

    for (const { results, weight, source } of sources) {
      for (const chunk of results) {
        const rrfScore = weight / (k + chunk.rank);

        const existing = scoreMap.get(chunk.id);
        if (existing) {
          existing.fusedScore += rrfScore;
          existing.sources.add(source);
        } else {
          scoreMap.set(chunk.id, {
            chunk,
            fusedScore: rrfScore,
            sources: new Set([source]),
          });
        }
      }
    }

    // Apply multi-source boost
    // Results found by both BM25 and Vector search are more likely to be relevant
    // We consider 'bm25' and 'vector' as primary sources for cross-validation
    for (const item of scoreMap.values()) {
      const hasBM25 = item.sources.has('bm25');
      const hasVector = item.sources.has('vector');

      // Count primary sources (bm25 and vector are primary, recent is secondary)
      const primarySourceCount = (hasBM25 ? 1 : 0) + (hasVector ? 1 : 0);

      // Apply boost for each additional primary source beyond the first
      // e.g., if both BM25 and vector found this result, apply boost once
      if (primarySourceCount > 1) {
        const boostFactor = Math.pow(multiSourceBoost, primarySourceCount - 1);
        item.fusedScore *= boostFactor;
      }
    }

    // Sort by fused score descending
    const sorted = Array.from(scoreMap.values()).sort(
      (a, b) => b.fusedScore - a.fusedScore,
    );

    return sorted.map((item, index) => ({
      ...item.chunk,
      fusedScore: item.fusedScore,
      sources: Array.from(item.sources),
      rank: index + 1,
    }));
  }

  /**
   * Applies penalty to test files to demote them in search results.
   *
   * Test files often match search queries due to:
   * - They test the same functionality being searched
   * - They contain the same keywords and identifiers
   * - They may have descriptive names that match queries
   *
   * However, users typically want the implementation, not the tests.
   * This method reduces the score of test files to prioritize implementations.
   *
   * Test file patterns:
   * - *.test.ts, *.spec.ts, *.test.js, *.spec.js
   * - __tests__/*, test/*, tests/*, *_test.go
   * - *Test.java, *Tests.java, *Spec.scala
   *
   * @param results Fused results to process.
   * @param penalty Penalty factor (0-1). Lower = stronger penalty.
   * @returns Results with test files demoted.
   */
  private applyTestFilePenalty(
    results: FusedScoredChunk[],
    penalty: number = 0.6,
  ): FusedScoredChunk[] {
    // Clamp penalty to valid range
    const clampedPenalty = Math.max(0.1, Math.min(1.0, penalty));

    return results
      .map((chunk) => {
        if (this.isTestFile(chunk.filePath)) {
          return {
            ...chunk,
            fusedScore: chunk.fusedScore * clampedPenalty,
          };
        }
        return chunk;
      })
      .sort((a, b) => b.fusedScore - a.fusedScore)
      .map((chunk, index) => ({
        ...chunk,
        rank: index + 1,
      }));
  }

  /**
   * Detects if a file path corresponds to a test file.
   *
   * Checks for common test file patterns across different languages:
   * - JavaScript/TypeScript: *.test.ts, *.spec.ts, __tests__/*
   * - Python: test_*.py, *_test.py, tests/*
   * - Go: *_test.go
   * - Java: *Test.java, *Tests.java, src/test/*
   * - Ruby: *_spec.rb, spec/*
   * - Rust: tests/*, #[cfg(test)]
   *
   * @param filePath The file path to check.
   * @returns True if the file is likely a test file.
   */
  private isTestFile(filePath: string): boolean {
    const path = filePath.toLowerCase();

    // Directory patterns indicating test files
    const testDirPatterns = [
      '/__tests__/',
      '/test/',
      '/tests/',
      '/spec/',
      '/specs/',
      '\\__tests__\\',
      '\\test\\',
      '\\tests\\',
      '\\spec\\',
      '\\specs\\',
      '/src/test/', // Java/Maven convention
      '\\src\\test\\',
    ];

    for (const pattern of testDirPatterns) {
      if (path.includes(pattern)) {
        return true;
      }
    }

    // File name patterns indicating test files
    const testFilePatterns = [
      // JavaScript/TypeScript
      /\.test\.[jt]sx?$/,
      /\.spec\.[jt]sx?$/,
      /_test\.[jt]sx?$/,
      /_spec\.[jt]sx?$/,
      // Python
      /^test_.*\.py$/,
      /.*_test\.py$/,
      /test\.py$/,
      // Go
      /_test\.go$/,
      // Java/Kotlin
      /test\.java$/,
      /tests\.java$/,
      /test\.kt$/,
      /tests\.kt$/,
      // Ruby
      /_spec\.rb$/,
      // Rust
      /tests\.rs$/,
      // C#
      /test\.cs$/,
      /tests\.cs$/,
    ];

    const fileName = path.split(/[/\\]/).pop() || '';
    for (const pattern of testFilePatterns) {
      if (pattern.test(fileName)) {
        return true;
      }
    }

    return false;
  }

  /**
   * Performs retrieval with graph expansion enabled.
   * Alias for retrieve() with enableGraph: true.
   *
   * @param query Search query.
   * @param options Retrieval options.
   * @returns Retrieval response with graph data.
   */
  async retrieveWithGraph(
    query: string,
    options: Omit<RetrieveOptions, 'enableGraph'> = {},
  ): Promise<RetrievalResponse> {
    return this.retrieve(query, { ...options, enableGraph: true });
  }

  /**
   * Performs simple retrieval without graph expansion.
   * Faster than full retrieval when graph context is not needed.
   *
   * @param query Search query.
   * @param topK Number of results to return.
   * @returns Array of scored chunks.
   */
  async simpleRetrieve(
    query: string,
    topK: number = 10,
  ): Promise<ScoredChunk[]> {
    const response = await this.retrieve(query, {
      topK,
      enableGraph: false,
    });
    return response.chunks;
  }

  /**
   * Updates the context builder configuration.
   *
   * @param config Context builder configuration.
   */
  setContextBuilderConfig(config: Partial<ContextBuilderConfig>): void {
    // ContextBuilder is immutable, create new instance
    this.contextBuilder = new ContextBuilder(config);
  }
}
