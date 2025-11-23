/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { GenerateContentParameters } from '@google/genai';

/**
 * Interface for tracking API request statistics
 */
export interface RequestStats {
  totalRequests: number;
  cachedRequests: number;
  requestQueueDepth: number;
  avgResponseTime: number;
  lastRequestTime: number;
}

/**
 * A batch item for grouping similar requests
 */
export interface RequestBatchItem {
  request: GenerateContentParameters;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  timestamp: number;
}

/**
 * Optimizes API requests by batching similar requests together
 * and implementing rate limiting to prevent API abuse
 */
export class RequestOptimizer {
  private requestCache: Map<string, { response: unknown; timestamp: number }> =
    new Map();
  private requestBatch: Map<string, RequestBatchItem[]> = new Map();
  private readonly cacheTTL = 5 * 60 * 1000; // 5 minutes cache TTL
  private readonly batchTimeout = 50; // 50ms batch window
  private readonly maxConcurrentRequests = 5;
  private activeRequests = 0;
  private stats: RequestStats = {
    totalRequests: 0,
    cachedRequests: 0,
    requestQueueDepth: 0,
    avgResponseTime: 0,
    lastRequestTime: 0,
  };

  /**
   * Generates a unique key for a request to use for caching and batching
   * This key should represent the semantic meaning of the request, not just the exact content
   */
  private generateRequestKey(request: GenerateContentParameters): string {
    // For content generation, the key should be based on the prompt and system instructions
    // We'll use just the first 200 chars of each text part to keep the key manageable
    let contentKey = '';

    // If contents exist, process them
    if (request.contents) {
      const contentsArray = Array.isArray(request.contents)
        ? (request.contents as Array<{ parts?: unknown } | string>)
        : [request.contents as { parts?: unknown } | string];

      for (const content of contentsArray) {
        if (typeof content === 'string') {
          // If it's a string, add it directly
          contentKey += content.substring(0, 200);
        } else if (
          content &&
          typeof content === 'object' &&
          'parts' in content &&
          content.parts
        ) {
          // If it has parts, process the parts
          const partsArray = Array.isArray(content.parts)
            ? (content.parts as Array<{ text?: string } | string>)
            : [content.parts as { text?: string } | string];

          for (const part of partsArray) {
            if (typeof part === 'string') {
              contentKey += part.substring(0, 200);
            } else if (
              part &&
              typeof part === 'object' &&
              part.text &&
              typeof part.text === 'string'
            ) {
              contentKey += part.text.substring(0, 200);
            }
          }
        }
      }
    }

    // Add model and generation config to the key
    const model = request.model || 'default';
    // Safely access generationConfig via type assertion since it might not be in the official API
    const config = JSON.stringify(
      (
        request as GenerateContentParameters & {
          generationConfig?: Record<string, unknown>;
        }
      ).generationConfig || {},
    );

    // Create a hash-like key using the content and config
    return `${model}:${contentKey}:${config}`;
  }

  /**
   * Checks if a request result is available in the cache
   */
  getCachedResponse(request: GenerateContentParameters): unknown | null {
    const key = this.generateRequestKey(request);
    const cached = this.requestCache.get(key);

    if (cached && Date.now() - cached.timestamp < this.cacheTTL) {
      this.stats.cachedRequests++;
      return cached.response;
    }

    // Clean up expired cache entries
    if (cached && Date.now() - cached.timestamp >= this.cacheTTL) {
      this.requestCache.delete(key);
    }

    return null;
  }

  /**
   * Stores a response in the cache
   */
  setCachedResponse(
    request: GenerateContentParameters,
    response: unknown,
  ): void {
    const key = this.generateRequestKey(request);
    this.requestCache.set(key, {
      response,
      timestamp: Date.now(),
    });
  }

  /**
   * Batch requests that are similar within a time window
   */
  async batchRequest(
    request: GenerateContentParameters,
    executeRequest: (req: GenerateContentParameters) => Promise<unknown>,
  ): Promise<unknown> {
    const key = this.generateRequestKey(request);
    const cachedResponse = this.getCachedResponse(request);

    if (cachedResponse) {
      return cachedResponse;
    }

    this.stats.totalRequests++;
    this.stats.requestQueueDepth++;

    return new Promise<unknown>((resolve, reject) => {
      // If we're below the concurrent request limit and no batch exists, execute directly
      if (
        this.activeRequests < this.maxConcurrentRequests &&
        !this.requestBatch.has(key)
      ) {
        this.executeRequestDirectly(request, executeRequest, resolve, reject);
        return;
      }

      // Add to batch if one exists or create a new batch
      if (!this.requestBatch.has(key)) {
        this.requestBatch.set(key, []);

        // After the batch timeout, execute the batched request
        setTimeout(() => {
          this.executeBatch(key, executeRequest);
        }, this.batchTimeout);
      }

      // Add to the batch
      this.requestBatch.get(key)!.push({
        request,
        resolve,
        reject,
        timestamp: Date.now(),
      });
    });
  }

  /**
   * Execute a request directly without batching
   */
  private async executeRequestDirectly(
    request: GenerateContentParameters,
    executeRequest: (req: GenerateContentParameters) => Promise<unknown>,
    resolve: (value: unknown) => void,
    reject: (reason: unknown) => void,
  ): Promise<void> {
    const startTime = Date.now();
    this.activeRequests++;

    try {
      const response = await executeRequest(request);
      this.setCachedResponse(request, response);
      resolve(response);

      // Update stats
      const responseTime = Date.now() - startTime;
      this.stats.avgResponseTime =
        (this.stats.avgResponseTime + responseTime) / 2;
      this.stats.lastRequestTime = Date.now();
    } catch (error) {
      reject(error);
    } finally {
      this.activeRequests--;
      this.stats.requestQueueDepth--;
    }
  }

  /**
   * Execute all requests in a batch using a single API call
   */
  private async executeBatch(
    key: string,
    executeRequest: (req: GenerateContentParameters) => Promise<unknown>,
  ): Promise<void> {
    const batch = this.requestBatch.get(key);
    if (!batch || batch.length === 0) {
      return;
    }

    // Execute the first request in the batch (they are semantically similar)
    const firstRequest = batch[0].request;
    const startTime = Date.now();
    this.activeRequests++;

    try {
      const response = await executeRequest(firstRequest);
      this.setCachedResponse(firstRequest, response);

      // Resolve all promises in the batch with the same response
      for (const item of batch) {
        item.resolve(response);
      }

      // Update stats
      const responseTime = Date.now() - startTime;
      this.stats.avgResponseTime =
        (this.stats.avgResponseTime + responseTime) / 2;
      this.stats.lastRequestTime = Date.now();
    } catch (error) {
      // Reject all promises in the batch with the same error
      for (const item of batch) {
        item.reject(error);
      }
    } finally {
      this.activeRequests--;
      this.stats.requestQueueDepth = Math.max(
        0,
        this.stats.requestQueueDepth - batch.length,
      );
      this.requestBatch.delete(key);
    }
  }

  /**
   * Get current request statistics
   */
  getStats(): RequestStats {
    return { ...this.stats };
  }

  /**
   * Clear the cache (useful for testing or when needed)
   */
  clearCache(): void {
    this.requestCache.clear();
    this.stats.cachedRequests = 0;
  }
}
