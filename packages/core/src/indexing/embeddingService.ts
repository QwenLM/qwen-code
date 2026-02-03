/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as crypto from 'node:crypto';
import pMap from 'p-map';
import type { Chunk, IEmbeddingService } from './types.js';
import type { EmbeddingCache } from './embeddingCache.js';

/**
 * Interface for LLM client that can generate embeddings.
 */
export interface ILlmClient {
  generateEmbedding(texts: string[]): Promise<number[][]>;
}

/**
 * Configuration for EmbeddingService.
 */
export interface EmbeddingServiceConfig {
  /** Batch size for embedding API calls. Default: 20. */
  batchSize: number;
  /** Maximum concurrent API requests. Default: 10. */
  maxConcurrency: number;
  /** Request timeout in ms. Default: 30000 (30s). */
  requestTimeoutMs: number;
  /** Maximum retries for failed batches. Default: 3. */
  maxRetries: number;
  /** Initial retry delay in ms. Default: 1000. */
  retryDelayMs: number;
}

/**
 * Default configuration.
 */
export const DEFAULT_EMBEDDING_SERVICE_CONFIG: EmbeddingServiceConfig = {
  batchSize: 20,
  maxConcurrency: 10, // With 30 QPS and ~300ms avg latency, 10 concurrent is safe
  requestTimeoutMs: 30000,
  maxRetries: 3,
  retryDelayMs: 1000,
};

/**
 * Result of embedding a single chunk.
 */
export interface ChunkEmbedding {
  chunk: Chunk;
  embedding: number[];
}

/**
 * Internal type for batch processing.
 */
interface BatchTask {
  batchIndex: number;
  chunks: Chunk[];
  texts: string[];
}

/**
 * Service for generating embeddings for code chunks.
 *
 * Features:
 * - Two-level caching (memory + SQLite)
 * - Concurrent batch processing with rate limiting
 * - Automatic retry with exponential backoff
 * - Request timeout handling
 * - Failed chunk collection for unified retry
 */
export class EmbeddingService implements IEmbeddingService {
  private llmClient: ILlmClient;
  private cache: EmbeddingCache;
  private config: EmbeddingServiceConfig;

  // Statistics
  private stats = {
    totalChunks: 0,
    cachedChunks: 0,
    generatedChunks: 0,
    failedChunks: 0,
    totalApiCalls: 0,
    retriedCalls: 0,
  };

  constructor(
    llmClient: ILlmClient,
    cache: EmbeddingCache,
    config: Partial<EmbeddingServiceConfig> = {},
  ) {
    this.llmClient = llmClient;
    this.cache = cache;
    this.config = { ...DEFAULT_EMBEDDING_SERVICE_CONFIG, ...config };
  }

  /**
   * Generate embeddings for multiple chunks.
   * Uses concurrent processing for improved performance.
   *
   * @param chunks - Array of chunks to embed
   * @returns Array of chunk-embedding pairs
   */
  async embedChunks(
    chunks: Chunk[],
    batchCallback?: (finishedChunks: number) => void,
  ): Promise<ChunkEmbedding[]> {
    if (chunks.length === 0) {
      return [];
    }

    this.stats.totalChunks += chunks.length;
    const results: ChunkEmbedding[] = [];

    // Separate cached and uncached chunks
    const uncachedChunks: Chunk[] = [];

    for (const chunk of chunks) {
      const cacheKey = this.computeEmbeddingCacheKey(chunk);
      const cachedEmbedding = this.cache.getByKey(cacheKey);

      if (cachedEmbedding) {
        results.push({ chunk, embedding: cachedEmbedding });
        this.stats.cachedChunks++;
      } else {
        uncachedChunks.push(chunk);
      }
    }

    // Generate embeddings for uncached chunks with concurrency
    if (uncachedChunks.length > 0) {
      const { batchSize, maxConcurrency } = this.config;
      const embedResults: Array<number[] | null> = new Array(
        uncachedChunks.length,
      ).fill(null);

      const turnSize = batchSize * maxConcurrency;
      for (let i = 0; i < uncachedChunks.length; i += turnSize) {
        await withMinTime(async () => {
          const turnChunks = uncachedChunks.slice(i, i + turnSize);
          // Create batch tasks
          const batches: BatchTask[] = [];
          for (let j = 0; j < turnChunks.length; j += batchSize) {
            const batchChunks = turnChunks.slice(j, j + batchSize);
            batches.push({
              batchIndex: j,
              chunks: batchChunks,
              texts: batchChunks.map((c) => this.buildEmbeddingInput(c)),
            });
          }
          // Track failed batches for retry
          const failedBatches: BatchTask[] = [];
          // Process batches concurrently using p-map
          await pMap(
            batches,
            async (batch) => {
              try {
                const embeddings = await this.generateWithRetryAndTimeout(
                  batch.texts,
                );
                for (let k = 0; k < embeddings.length; k++) {
                  embedResults[i + batch.batchIndex + k] = embeddings[k];
                }
              } catch (error) {
                console.warn(
                  `Batch ${batch.batchIndex / batchSize} failed: ${error}`,
                );
                failedBatches.push(batch);
              }
            },
            { concurrency: maxConcurrency },
          );

          // Retry failed batches sequentially
          if (failedBatches.length > 0) {
            console.log(`Retrying ${failedBatches.length} failed batches...`);
            this.stats.retriedCalls += failedBatches.length;

            for (const batch of failedBatches) {
              try {
                const embeddings = await this.generateWithRetryAndTimeout(
                  batch.texts,
                );
                for (let p = 0; p < embeddings.length; p++) {
                  embedResults[i + batch.batchIndex + p] = embeddings[p];
                }
              } catch (error) {
                console.error(`Final retry failed for batch: ${error}`);
              }
            }
          }
        }, 1000)();

        if (batchCallback) {
          batchCallback(
            i + turnSize <= uncachedChunks.length
              ? i + turnSize
              : uncachedChunks.length,
          );
        }
      }

      for (let i = 0; i < embedResults.length; i++) {
        const embedding = embedResults[i];
        const chunk = uncachedChunks[i];

        if (embedding) {
          const cacheKey = this.computeEmbeddingCacheKey(chunk);
          this.cache.setByKey(cacheKey, embedding);
          results.push({ chunk, embedding });
          this.stats.generatedChunks++;
        } else {
          this.stats.failedChunks++;
        }
      }
    }

    return results;
  }

  /**
   * Generate embeddings with retry logic and timeout.
   */
  private async generateWithRetryAndTimeout(
    texts: string[],
  ): Promise<number[][]> {
    const { maxRetries, retryDelayMs, requestTimeoutMs } = this.config;
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        this.stats.totalApiCalls++;

        // Create timeout promise
        const timeoutPromise = new Promise<never>((_, reject) => {
          setTimeout(
            () =>
              reject(new Error(`Request timeout after ${requestTimeoutMs}ms`)),
            requestTimeoutMs,
          );
        });

        // Race between API call and timeout
        const result = await Promise.race([
          this.llmClient.generateEmbedding(texts),
          timeoutPromise,
        ]);

        return result;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        // Exponential backoff for retries
        if (attempt < maxRetries - 1) {
          const delay = retryDelayMs * Math.pow(2, attempt);
          console.warn(
            `Embedding attempt ${attempt + 1} failed, retrying in ${delay}ms: ${lastError.message}`,
          );
          await this.delay(delay);
        }
      }
    }

    throw (
      lastError || new Error('Failed to generate embeddings after all retries')
    );
  }

  /**
   * Builds the embedding input text with metadata prefix.
   * This enhances the embedding quality by providing context about the code.
   *
   * @param chunk - The chunk to build input for
   * @returns Formatted input string with metadata
   */
  private buildEmbeddingInput(chunk: Chunk): string {
    const parts: string[] = [];

    // Add file path for context
    parts.push(`File: ${chunk.filepath}`);

    // Add chunk type
    parts.push(`Type: ${chunk.type}`);

    // Add function/class metadata if available
    if (chunk.metadata.functionName) {
      parts.push(`Function: ${chunk.metadata.functionName}`);
    }
    if (chunk.metadata.className) {
      parts.push(`Class: ${chunk.metadata.className}`);
    }
    if (chunk.metadata.signature) {
      parts.push(`Signature: ${chunk.metadata.signature}`);
    }

    // Add separator and content
    parts.push('');
    parts.push(chunk.content);

    return parts.join('\n');
  }

  /**
   * Computes the cache key for an embedding.
   * Uses filepath + type + contentHash to ensure cache correctness.
   *
   * Note: Line numbers are excluded to allow cache reuse after code refactoring
   * that moves code to different lines without changing content.
   *
   * @param chunk - The chunk to compute cache key for
   * @returns SHA-256 hash (first 32 chars) as cache key
   */
  private computeEmbeddingCacheKey(chunk: Chunk): string {
    const input = [
      chunk.filepath, // File path affects context understanding
      chunk.type, // Chunk type affects metadata prefix
      chunk.contentHash, // Content itself
    ].join('|');

    return crypto.createHash('sha256').update(input).digest('hex').slice(0, 32);
  }

  /**
   * Helper function to create a delay.
   */
  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Get service statistics.
   */
  getStats(): {
    totalChunks: number;
    cachedChunks: number;
    generatedChunks: number;
    failedChunks: number;
    totalApiCalls: number;
    retriedCalls: number;
    cacheHitRate: number;
  } {
    const cacheHitRate =
      this.stats.totalChunks > 0
        ? this.stats.cachedChunks / this.stats.totalChunks
        : 0;

    return {
      ...this.stats,
      cacheHitRate,
    };
  }

  /**
   * Reset statistics.
   */
  resetStats(): void {
    this.stats = {
      totalChunks: 0,
      cachedChunks: 0,
      generatedChunks: 0,
      failedChunks: 0,
      totalApiCalls: 0,
      retriedCalls: 0,
    };
  }

  /**
   * Get the underlying cache for direct access.
   */
  getCache(): EmbeddingCache {
    return this.cache;
  }
}

export function withMinTime<TArgs extends unknown[], TReturn>(
  fn: (...args: TArgs) => Promise<TReturn> | TReturn,
  minMs: number = 1000,
): (...args: TArgs) => Promise<TReturn> {
  return async (...args: TArgs): Promise<TReturn> => {
    const start = Date.now();
    const result = await fn(...args);
    const took = Date.now() - start;
    if (took < minMs) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, minMs - took);
      });
    }
    return result;
  };
}
