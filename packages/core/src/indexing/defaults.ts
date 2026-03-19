/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { IndexConfig, RetrievalConfig } from './types.js';

/**
 * Default configuration for codebase indexing.
 */
export const DEFAULT_INDEX_CONFIG: IndexConfig = {
  enabled: true,
  autoIndex: true,
  pollIntervalMs: 10 * 60 * 1000, // 10 minutes
  chunkMaxTokens: 512,
  chunkOverlapTokens: 50,
  embeddingBatchSize: 20,
  streamThreshold: 50_000, // Use streaming for >50k files
  enableGraph: true,
};

/**
 * Default configuration for retrieval operations.
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
