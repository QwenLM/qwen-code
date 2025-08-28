/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { HippoRAG } from '../HippoRAG.js';
import { MilvusCodeStorage } from '../MilvusCodeStorage.js';
import { vi, describe, it, expect, beforeEach } from 'vitest';

vi.mock('../MilvusCodeStorage');

describe('HippoRAG', () => {
  let hippoRAG: HippoRAG;
  let mockMilvusCodeStorage: any;

  beforeEach(() => {
    hippoRAG = new HippoRAG('localhost:19530');
    mockMilvusCodeStorage = MilvusCodeStorage.prototype;
  });

  it('should initialize the MilvusCodeStorage', async () => {
    await hippoRAG.initialize();
    expect(mockMilvusCodeStorage.initialize).toHaveBeenCalled();
  });

  it('should add code to the RAG system', async () => {
    await hippoRAG.addCode('test.ts', 'const a = 1;');
    expect(mockMilvusCodeStorage.storeCode).toHaveBeenCalledWith('test.ts', 'const a = 1;', {});
  });

  it('should retrieve relevant code from the RAG system', async () => {
    mockMilvusCodeStorage.searchCode.mockResolvedValue([]);
    const results = await hippoRAG.retrieveRelevantCode('test query');
    expect(mockMilvusCodeStorage.searchCode).toHaveBeenCalled();
    expect(results).toEqual([]);
  });

  it('should update code in the RAG system', async () => {
    await hippoRAG.updateCode('test.ts', 'const a = 2;');
    expect(mockMilvusCodeStorage.deleteCodeByFilePath).toHaveBeenCalledWith('test.ts');
    expect(mockMilvusCodeStorage.storeCode).toHaveBeenCalledWith('test.ts', 'const a = 2;', {});
  });
});
