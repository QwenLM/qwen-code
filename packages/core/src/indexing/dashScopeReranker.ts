/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * DashScope Reranker - Aliyun Bailian Text Rerank API Integration
 *
 * Implements the IReranker interface using Aliyun's DashScope Rerank API.
 * Supports multiple models:
 * - qwen3-rerank: Up to 500 documents, 4K tokens per doc, 30K total tokens
 * - gte-rerank-v2: Similar capacity, multi-language support
 * - qwen3-vl-rerank: Multi-modal support (images/videos)
 *
 * @see https://help.aliyun.com/zh/model-studio/text-rerank-api
 */

import type { IReranker } from './retrievalService.js';

/**
 * Supported rerank models from DashScope.
 */
export type DashScopeRerankModel =
  | 'qwen3-rerank'
  | 'gte-rerank-v2'
  | 'qwen3-vl-rerank';

/**
 * Configuration for DashScopeReranker.
 */
export interface DashScopeRerankerConfig {
  /**
   * DashScope API Key.
   * Can also be set via DASHSCOPE_API_KEY environment variable.
   */
  apiKey?: string;

  /**
   * Rerank model to use.
   * @default 'qwen3-rerank'
   */
  model?: DashScopeRerankModel;

  /**
   * Base URL for the DashScope API.
   * @default 'https://dashscope.aliyuncs.com/compatible-api/v1'
   */
  baseUrl?: string;

  /**
   * Maximum number of top results to return from the reranker.
   * If not specified, returns all documents.
   */
  topN?: number;

  /**
   * Custom instruction for the reranker.
   * Only supported by qwen3-rerank and qwen3-vl-rerank.
   * @example "Given a code search query, retrieve relevant code snippets that implement the functionality."
   */
  instruct?: string;

  /**
   * Request timeout in milliseconds.
   * @default 30000
   */
  timeout?: number;

  /**
   * Maximum number of documents to send per request.
   * Documents exceeding this limit will be processed in batches.
   * @default 100 (conservative limit for all models)
   */
  maxDocsPerRequest?: number;

  /**
   * Whether to include document content in the response.
   * @default false
   */
  returnDocuments?: boolean;
}

/**
 * DashScope Rerank API request body structure.
 */
interface DashScopeRerankRequest {
  model: string;
  input: {
    query: string;
    documents: string[];
  };
  parameters?: {
    top_n?: number;
    return_documents?: boolean;
    instruct?: string;
  };
}

/**
 * DashScope Rerank API response structure.
 */
interface DashScopeRerankResponse {
  request_id: string;
  output: {
    results: Array<{
      index: number;
      relevance_score: number;
      document?: {
        text: string;
      };
    }>;
  };
  usage: {
    total_tokens: number;
  };
  code?: string;
  message?: string;
}

/**
 * Error response from DashScope API.
 */
interface DashScopeErrorResponse {
  code: string;
  message: string;
  request_id?: string;
}

/**
 * DashScope Reranker implementation.
 *
 * Uses Aliyun Bailian's text rerank API to reorder documents by relevance.
 * This is a cross-encoder based reranker that provides more accurate
 * relevance scoring than bi-encoder approaches at the cost of higher latency.
 *
 * @example
 * ```typescript
 * const reranker = new DashScopeReranker({
 *   apiKey: 'sk-xxxx',
 *   model: 'qwen3-rerank',
 *   instruct: 'Given a code search query, retrieve relevant code snippets.',
 * });
 *
 * const results = await reranker.rerank(
 *   'how to parse JSON in TypeScript',
 *   [
 *     { id: '1', content: 'function parseJson(str) { return JSON.parse(str); }' },
 *     { id: '2', content: 'const x = 1 + 2;' },
 *   ]
 * );
 * // Results sorted by relevance_score
 * ```
 */
export class DashScopeReranker implements IReranker {
  private readonly apiKey: string;
  private readonly model: DashScopeRerankModel;
  private readonly baseUrl: string;
  private readonly topN?: number;
  private readonly instruct?: string;
  private readonly timeout: number;
  private readonly maxDocsPerRequest: number;
  private readonly returnDocuments: boolean;

  /**
   * Total tokens consumed by rerank operations.
   * Reset manually if needed for tracking.
   */
  totalTokensUsed: number = 0;

  /**
   * Creates a new DashScopeReranker instance.
   *
   * @param config Configuration options.
   * @throws Error if API key is not provided and not in environment.
   */
  constructor(config: DashScopeRerankerConfig = {}) {
    this.apiKey = config.apiKey ?? process.env['DASHSCOPE_API_KEY'] ?? '';
    if (!this.apiKey) {
      throw new Error(
        'DashScope API key is required. Set via config.apiKey or DASHSCOPE_API_KEY environment variable.',
      );
    }

    this.model = config.model ?? 'qwen3-rerank';
    this.baseUrl =
      config.baseUrl ??
      'https://dashscope.aliyuncs.com/api/v1/services/rerank/text-rerank';
    this.topN = config.topN;
    this.instruct = config.instruct;
    this.timeout = config.timeout ?? 30000;
    this.maxDocsPerRequest = config.maxDocsPerRequest ?? 100;
    this.returnDocuments = config.returnDocuments ?? false;
  }

  /**
   * Reranks documents based on their relevance to the query.
   *
   * @param query The search query.
   * @param documents Documents to rerank, each with an id and content.
   * @returns Reranked documents with updated scores, sorted by relevance.
   */
  async rerank(
    query: string,
    documents: Array<{ id: string; content: string }>,
  ): Promise<Array<{ id: string; score: number }>> {
    if (documents.length === 0) {
      return [];
    }

    // Handle batching if documents exceed max limit
    if (documents.length > this.maxDocsPerRequest) {
      return this.rerankInBatches(query, documents);
    }

    return this.rerankBatch(query, documents);
  }

  /**
   * Reranks a single batch of documents.
   */
  private async rerankBatch(
    query: string,
    documents: Array<{ id: string; content: string }>,
  ): Promise<Array<{ id: string; score: number }>> {
    const requestBody: DashScopeRerankRequest = {
      model: this.model,
      input: {
        query,
        documents: documents.map((d) => d.content),
      },
      parameters: {},
    };

    // Add optional parameters
    if (this.topN !== undefined) {
      requestBody.parameters!.top_n = this.topN;
    }
    if (this.returnDocuments) {
      requestBody.parameters!.return_documents = true;
    }
    if (
      this.instruct &&
      (this.model === 'qwen3-rerank' || this.model === 'qwen3-vl-rerank')
    ) {
      requestBody.parameters!.instruct = this.instruct;
    }

    // Clean up empty parameters object
    if (Object.keys(requestBody.parameters!).length === 0) {
      delete requestBody.parameters;
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await fetch(`${this.baseUrl}/text-rerank`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorBody = (await response
          .json()
          .catch(() => ({}))) as DashScopeErrorResponse;
        throw new Error(
          `DashScope Rerank API error: ${response.status} ${response.statusText}` +
            (errorBody.message ? ` - ${errorBody.message}` : ''),
        );
      }

      const result = (await response.json()) as DashScopeRerankResponse;

      // Check for API-level errors
      if (result.code) {
        throw new Error(
          `DashScope Rerank API error: ${result.code} - ${result.message}`,
        );
      }

      // Track token usage
      if (result.usage?.total_tokens) {
        this.totalTokensUsed += result.usage.total_tokens;
      }

      // Map results back to document IDs
      return result.output.results.map((r) => ({
        id: documents[r.index].id,
        score: r.relevance_score,
      }));
    } catch (error) {
      clearTimeout(timeoutId);

      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error(`DashScope Rerank API timeout after ${this.timeout}ms`);
      }
      throw error;
    }
  }

  /**
   * Reranks documents in batches when count exceeds maxDocsPerRequest.
   *
   * Strategy: Process in batches, then merge results.
   * Since cross-encoder scores are query-dependent, scores are comparable across batches.
   */
  private async rerankInBatches(
    query: string,
    documents: Array<{ id: string; content: string }>,
  ): Promise<Array<{ id: string; score: number }>> {
    const batches: Array<Array<{ id: string; content: string }>> = [];

    // Split into batches
    for (let i = 0; i < documents.length; i += this.maxDocsPerRequest) {
      batches.push(documents.slice(i, i + this.maxDocsPerRequest));
    }

    // Process batches in parallel (with reasonable concurrency)
    const batchResults = await Promise.all(
      batches.map((batch) => this.rerankBatch(query, batch)),
    );

    // Merge all results
    const allResults = batchResults.flat();

    // Sort by score descending
    allResults.sort((a, b) => b.score - a.score);

    // Apply topN if specified
    if (this.topN !== undefined && allResults.length > this.topN) {
      return allResults.slice(0, this.topN);
    }

    return allResults;
  }

  /**
   * Resets the token usage counter.
   */
  resetTokenCount(): void {
    this.totalTokensUsed = 0;
  }

  /**
   * Gets the current model being used.
   */
  getModel(): DashScopeRerankModel {
    return this.model;
  }
}

/**
 * Default code search instruction for the reranker.
 * Optimized for code search use cases.
 */
export const CODE_SEARCH_INSTRUCT = `Given a code search query, retrieve relevant code snippets that:
1. Directly implement or demonstrate the requested functionality
2. Show the API usage or function signature being searched for
3. Contain relevant documentation or comments explaining the concept

** Note that you can distinguish test code by its filename and content. Prioritize implementation code(file) over test code(file) unless the query specifically asks for tests **.
`;

/**
 * Creates a DashScopeReranker optimized for code search.
 *
 * @param config Optional configuration overrides.
 * @returns Configured DashScopeReranker instance.
 */
export function createCodeSearchReranker(
  config: Partial<DashScopeRerankerConfig> = {},
): DashScopeReranker {
  return new DashScopeReranker({
    model: 'qwen3-rerank',
    instruct: CODE_SEARCH_INSTRUCT,
    topN: 20, // Reasonable default for RAG
    ...config,
  });
}
