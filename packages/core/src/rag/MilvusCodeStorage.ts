/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { MilvusClient, DataType, IndexType, MetricType } from '@zilliz/milvus2-sdk-node';
import { SimpleCodeChunker } from './SimpleCodeChunker.js';

export interface CodeDocument {
  id: string;
  filePath: string;
  content: string;
  embedding: number[];
  metadata: Record<string, any>;
}

export class MilvusCodeStorage {
  private client: MilvusClient;
  private collectionName: string;
  private chunker: SimpleCodeChunker;

  constructor(
    milvusAddress: string,
    collectionName: string = 'code_chunks'
  ) {
    this.client = new MilvusClient({ address: milvusAddress });
    this.collectionName = collectionName;
    this.chunker = new SimpleCodeChunker(1000);
  }

  async initialize(): Promise<void> {
    // Create the collection if it doesn't exist
    const collectionExists = await this.client.hasCollection({
      collection_name: this.collectionName,
    });

    if (!collectionExists.value) {
      const fields: any[] = [
        {
          name: 'id',
          data_type: DataType.VarChar as any,
          is_primary_key: true,
          max_length: 65535,
        },
        {
          name: 'filePath',
          data_type: DataType.VarChar as any,
          max_length: 65535,
        },
        {
          name: 'content',
          data_type: DataType.VarChar as any,
          max_length: 65535,
        },
        {
          name: 'embedding',
          data_type: DataType.FloatVector as any,
          dim: 768, // Default embedding dimension
        },
        {
          name: 'metadata',
          data_type: DataType.JSON as any,
        },
      ];

      await this.client.createCollection({
        collection_name: this.collectionName,
        fields: fields,
      });

      // Create index for the embedding field
      await this.client.createIndex({
        collection_name: this.collectionName,
        field_name: 'embedding',
        index_type: IndexType.AUTOINDEX,
        metric_type: MetricType.COSINE,
      });

      // Load the collection
      await this.client.loadCollection({
        collection_name: this.collectionName,
      });
    }
  }

  async storeCode(filePath: string, content: string, metadata: Record<string, any> = {}): Promise<void> {
    // Chunk the code content
    const chunks = this.chunker.chunk(content);
    
    // Create documents with embeddings (in a real implementation, you would use an embedding model)
    const documents: any[] = chunks.map((chunk: any, index: number) => ({
      id: `${filePath}-${index}`,
      filePath,
      content: chunk.content,
      embedding: new Array(768).fill(0), // Placeholder - in real implementation, generate actual embeddings
      metadata: {
        ...metadata,
        chunkIndex: index,
        startLine: chunk.startLine,
        endLine: chunk.endLine,
      }
    }));

    // Insert documents into Milvus
    await this.client.insert({
      collection_name: this.collectionName,
      data: documents,
    });
  }

  async searchCode(queryEmbedding: number[], limit: number = 10): Promise<any[]> {
    const searchResult = await this.client.search({
      collection_name: this.collectionName,
      data: [queryEmbedding],
      limit: limit,
      output_fields: ['id', 'filePath', 'content', 'metadata'],
    });

    return searchResult.results;
  }

  async deleteCodeByFilePath(filePath: string): Promise<void> {
    await this.client.delete({
      collection_name: this.collectionName,
      filter: `filePath == '${filePath}'`,
    });
  }

  async close(): Promise<void> {
    await this.client.closeConnection();
  }
}