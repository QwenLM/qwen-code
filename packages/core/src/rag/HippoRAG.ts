/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { MilvusCodeStorage } from './MilvusCodeStorage.js';

export class HippoRAG {
  private milvusStorage: MilvusCodeStorage;

  constructor(milvusAddress: string, collectionName: string = 'code_chunks') {
    this.milvusStorage = new MilvusCodeStorage(milvusAddress, collectionName);
  }

  async initialize(): Promise<void> {
    await this.milvusStorage.initialize();
  }

  async addCode(filePath: string, content: string, metadata: Record<string, any> = {}): Promise<void> {
    await this.milvusStorage.storeCode(filePath, content, metadata);
  }

  async retrieveRelevantCode(query: string, limit: number = 5): Promise<any[]> {
    // In a real implementation, you would convert the query to an embedding
    // For now, we'll use a placeholder embedding
    const queryEmbedding = new Array(768).fill(0.1);
    
    // Search for relevant code chunks
    const results = await this.milvusStorage.searchCode(queryEmbedding, limit);
    
    return results;
  }

  async updateCode(filePath: string, content: string, metadata: Record<string, any> = {}): Promise<void> {
    // Delete existing chunks for this file
    await this.milvusStorage.deleteCodeByFilePath(filePath);
    
    // Add the updated code
    await this.milvusStorage.storeCode(filePath, content, metadata);
  }

  async close(): Promise<void> {
    await this.milvusStorage.close();
  }
}