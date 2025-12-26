/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { BaseLlmClient } from '../../core/baseLlmClient.js';
import { type Config } from '../../config/config.js';

export interface VectorEntry {
  id: string;
  text: string;
  metadata: Record<string, unknown>;
  embedding: number[];
}

/**
 * A simple in-memory vector store with cosine similarity search.
 * This acts as the "Long Term Memory" for the agent.
 */
export class VectorStoreService {
  private entries: VectorEntry[] = [];
  private baseLlmClient: BaseLlmClient;

  constructor(config: Config) {
    const contentGenerator = config.getContentGenerator();
    if (!contentGenerator) {
      throw new Error('Content generator is required for VectorStoreService');
    }
    this.baseLlmClient = new BaseLlmClient(contentGenerator, config);
  }

  /**
   * Adds text to the vector store.
   * Handles chunking and embedding generation.
   */
  async addText(text: string, metadata: Record<string, unknown>): Promise<void> {
    if (!text || text.trim().length === 0) {
      return;
    }
    // Simple chunking logic: split by double newline or max 1000 chars
    const chunks = this.chunkText(text, 1000);
    const embeddings = await this.baseLlmClient.generateEmbedding(chunks);

    for (let i = 0; i < chunks.length; i++) {
      this.entries.push({
        id: `${metadata['path'] ?? 'memory'}-${Date.now()}-${i}`,
        text: chunks[i],
        metadata: { ...metadata, chunk_index: i },
        embedding: embeddings[i],
      });
    }
  }

  /**
   * Searches for the most relevant entries based on a query.
   */
  async search(query: string, limit: number = 5): Promise<VectorEntry[]> {
    if (this.entries.length === 0) return [];

    const [queryEmbedding] = await this.baseLlmClient.generateEmbedding([query]);
    
    const results = this.entries.map(entry => ({
      entry,
      similarity: this.cosineSimilarity(queryEmbedding, entry.embedding)
    }));

    // Sort by similarity descending
    results.sort((a, b) => b.similarity - a.similarity);

    return results.slice(0, limit).map(r => r.entry);
  }

  private chunkText(text: string, maxChars: number): string[] {
    const chunks: string[] = [];
    let current = text;
    while (current.length > 0) {
      if (current.length <= maxChars) {
        chunks.push(current);
        break;
      }
      let splitIndex = current.lastIndexOf('\n\n', maxChars);
      if (splitIndex === -1) splitIndex = current.lastIndexOf('\n', maxChars);
      if (splitIndex === -1) splitIndex = maxChars;
      
      chunks.push(current.substring(0, splitIndex).trim());
      current = current.substring(splitIndex).trim();
    }
    return chunks;
  }

  private cosineSimilarity(vecA: number[], vecB: number[]): number {
    let dotProduct = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < vecA.length; i++) {
      dotProduct += vecA[i] * vecB[i];
      normA += vecA[i] * vecA[i];
      normB += vecB[i] * vecB[i];
    }
    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
  }

  /**
   * Clears memory.
   */
  clear(): void {
    this.entries = [];
  }
}
