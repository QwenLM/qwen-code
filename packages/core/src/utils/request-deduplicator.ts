/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Request deduplicator to prevent multiple concurrent requests to the same endpoint
 * This is useful for reducing redundant API calls when multiple parts of the application
 * request the same data simultaneously
 */
export class RequestDeduplicator {
  private readonly pendingRequests = new Map<string, Promise<unknown>>();

  /**
   * Execute a request function, but deduplicate if an identical request is already in progress
   * @param key A unique key identifying the request (e.g. URL + parameters)
   * @param requestFn The function to execute if no duplicate is in progress
   * @returns The result of the request
   */
  async execute<T>(key: string, requestFn: () => Promise<T>): Promise<T> {
    // Check if there's already a pending request with this key
    const existingRequest = this.pendingRequests.get(key);
    if (existingRequest) {
      // If there's already a pending request, wait for it instead of making a new one
      try {
        return (await existingRequest) as Promise<T>;
      } finally {
        // Clean up the map after the request completes (regardless of success or failure)
        this.pendingRequests.delete(key);
      }
    }

    // If no pending request exists, create a new one
    const requestPromise = (async () => {
      try {
        return await requestFn();
      } finally {
        // Clean up the map after the request completes
        this.pendingRequests.delete(key);
      }
    })();

    // Store the pending request
    this.pendingRequests.set(key, requestPromise as Promise<unknown>);

    try {
      return await requestPromise;
    } finally {
      // Ensure cleanup in case the promise rejects immediately
      this.pendingRequests.delete(key);
    }
  }

  /**
   * Get the number of currently pending deduplicated requests
   */
  getPendingRequestCount(): number {
    return this.pendingRequests.size;
  }

  /**
   * Clear all pending requests (useful for testing or when context changes)
   */
  clear(): void {
    this.pendingRequests.clear();
  }
}

// Global instance for application-wide deduplication
export const requestDeduplicator = new RequestDeduplicator();
