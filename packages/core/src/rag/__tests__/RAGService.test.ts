/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { RAGService } from '../RAGService.js';
import { HippoRAG } from '../HippoRAG.js';
import { vi, describe, it, expect, beforeEach } from 'vitest';

vi.mock('../HippoRAG');

describe('RAGService', () => {
  let ragService: RAGService;
  let mockHippoRAG: any;

  beforeEach(() => {
    ragService = new RAGService('localhost:19530');
    mockHippoRAG = HippoRAG.prototype;
  });

  it('should initialize the HippoRAG instance', async () => {
    await ragService.initialize();
    expect(mockHippoRAG.initialize).toHaveBeenCalled();
  });

  it('should add or update code in the RAG system', async () => {
    await ragService.addOrUpdateCode('test.ts', 'const a = 1;');
    expect(mockHippoRAG.updateCode).toHaveBeenCalledWith('test.ts', 'const a = 1;', expect.any(Object));
  });

  it('should retrieve relevant code from the RAG system', async () => {
    mockHippoRAG.retrieveRelevantCode.mockResolvedValue([]);
    const context = await ragService.retrieveRelevantCode('test query');
    expect(mockHippoRAG.retrieveRelevantCode).toHaveBeenCalledWith('test query', 5);
    expect(context).toBe('No relevant code found.');
  });

  it('should format the retrieved code as context', async () => {
    const mockResults = [
      {
        filePath: 'test1.ts',
        content: 'const a = 1;',
      },
      {
        filePath: 'test2.ts',
        content: 'const b = 2;',
      },
    ];
    mockHippoRAG.retrieveRelevantCode.mockResolvedValue(mockResults);
    const context = await ragService.retrieveRelevantCode('test query');
    expect(context).toContain('File: test1.ts');
    expect(context).toContain('Content:\nconst a = 1;');
    expect(context).toContain('File: test2.ts');
    expect(context).toContain('Content:\nconst b = 2;');
  });
});
