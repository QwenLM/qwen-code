/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { HippoRAG } from './HippoRAG.js';

export class RAGService {
  private hippoRAG: HippoRAG;
  private initialized: boolean = false;
  private workspacePath: string;

  constructor(milvusAddress: string, workspacePath: string = process.cwd()) {
    this.workspacePath = workspacePath;
    this.hippoRAG = new HippoRAG(milvusAddress, this.getWorkspaceCollectionName());
  }

  private getWorkspaceCollectionName(): string {
    // Sanitize workspace path to create unique collection name
    const workspaceName = this.workspacePath
      .replace(/[^a-zA-Z0-9]/g, '_')
      .replace(/_+/g, '_')
      .replace(/^_|_$/g, '')
      .toLowerCase();
    
    return `rag_${workspaceName}`;
  }

  async initialize(): Promise<void> {
    if (!this.initialized) {
      await this.hippoRAG.initialize();
      this.initialized = true;
    }
  }

  async addOrUpdateCode(filePath: string, content: string): Promise<void> {
    if (!this.initialized) {
      await this.initialize();
    }
    
    // Add or update the code in the workspace-specific RAG system
    await this.hippoRAG.updateCode(filePath, content, {
      lastModified: new Date().toISOString(),
      fileSize: content.length,
    });
  }

  async retrieveRelevantCode(query: string, limit: number = 5): Promise<string> {
    if (!this.initialized) {
      await this.initialize();
    }
    
    try {
      const results = await this.hippoRAG.retrieveRelevantCode(query, limit);
      
      // Format the results as context for the LLM
      if (results.length === 0) {
        return 'No relevant code found.';
      }
      
      let context = 'Relevant code snippets:\n\n';
      for (const result of results) {
        context += `File: ${result.filePath}\n`;
        context += `Content:\n${result.content}\n\n`;
      }
      
      return context;
    } catch (error) {
      console.error('Error retrieving relevant code:', error);
      return 'Error retrieving relevant code.';
    }
  }

  async close(): Promise<void> {
    await this.hippoRAG.close();
  }

  getCollectionName(): string {
    return this.getWorkspaceCollectionName();
  }
}