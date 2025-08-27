/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { MilvusClient } from '@zilliz/milvus2-sdk-node';
import { MilvusCodeStorage } from '../MilvusCodeStorage.js';
import { vi, describe, it, expect, beforeEach } from 'vitest';

vi.mock('@zilliz/milvus2-sdk-node', () => {
  const mockMilvusClient = {
    hasCollection: vi.fn(),
    createCollection: vi.fn(),
    createIndex: vi.fn(),
    loadCollection: vi.fn(),
    insert: vi.fn(),
    search: vi.fn(),
    delete: vi.fn(),
    closeConnection: vi.fn(),
  };
  
  return {
    MilvusClient: vi.fn(() => mockMilvusClient),
    DataType: {
      VarChar: 21,
      FloatVector: 101,
      JSON: 23,
    },
    IndexType: {
      AUTOINDEX: 'AUTOINDEX',
    },
    MetricType: {
      COSINE: 'COSINE',
    },
  };
});

vi.mock('chonkie/chunker/code', () => {
  return {
    CodeChunker: {
      create: vi.fn().mockResolvedValue({
        chunk: vi.fn().mockResolvedValue([
          {
            content: 'chunk1',
            startLine: 1,
            endLine: 10,
          },
          {
            content: 'chunk2',
            startLine: 11,
            endLine: 20,
          },
        ]),
      }),
    },
  };
});

describe('MilvusCodeStorage', () => {
  let milvusCodeStorage: MilvusCodeStorage;
  let mockMilvusClient: any;

  beforeEach(() => {
    // Reset all mocks before each test
    vi.clearAllMocks();
    mockMilvusClient = {
      hasCollection: vi.fn(),
      createCollection: vi.fn(),
      createIndex: vi.fn(),
      loadCollection: vi.fn(),
      insert: vi.fn(),
      search: vi.fn(),
      delete: vi.fn(),
      closeConnection: vi.fn(),
    };
    vi.mocked(MilvusClient).mockReturnValue(mockMilvusClient);
    milvusCodeStorage = new MilvusCodeStorage('localhost:19530');
  });

  it('should initialize and create a new collection if it does not exist', async () => {
    mockMilvusClient.hasCollection.mockResolvedValue({ value: false });
    await milvusCodeStorage.initialize();
    expect(mockMilvusClient.hasCollection).toHaveBeenCalledWith({ collection_name: 'code_chunks' });
    expect(mockMilvusClient.createCollection).toHaveBeenCalled();
    expect(mockMilvusClient.createIndex).toHaveBeenCalled();
    expect(mockMilvusClient.loadCollection).toHaveBeenCalled();
  });

  it('should initialize without creating a new collection if it already exists', async () => {
    mockMilvusClient.hasCollection.mockResolvedValue({ value: true });
    await milvusCodeStorage.initialize();
    expect(mockMilvusClient.hasCollection).toHaveBeenCalledWith({ collection_name: 'code_chunks' });
    expect(mockMilvusClient.createCollection).not.toHaveBeenCalled();
  });

  it('should store code chunks in Milvus', async () => {
    mockMilvusClient.hasCollection.mockResolvedValue({ value: true });
    await milvusCodeStorage.initialize();
    await milvusCodeStorage.storeCode('test.ts', 'const a = 1;');
    expect(mockMilvusClient.insert).toHaveBeenCalled();
  });

  it('should search for code chunks in Milvus', async () => {
    mockMilvusClient.hasCollection.mockResolvedValue({ value: true });
    mockMilvusClient.search.mockResolvedValue({ results: [] });
    await milvusCodeStorage.initialize();
    const results = await milvusCodeStorage.searchCode([0.1, 0.2, 0.3]);
    expect(mockMilvusClient.search).toHaveBeenCalled();
    expect(results).toEqual([]);
  });

  it('should delete code chunks from Milvus', async () => {
    mockMilvusClient.hasCollection.mockResolvedValue({ value: true });
    await milvusCodeStorage.initialize();
    await milvusCodeStorage.deleteCodeByFilePath('test.ts');
    expect(mockMilvusClient.delete).toHaveBeenCalledWith({ collection_name: 'code_chunks', filter: "filePath == 'test.ts'" });
  });
});
