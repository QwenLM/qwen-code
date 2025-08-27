/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { RetrieveCodeTool } from '../retrieve-code';
import { RAGService } from '../../rag/RAGService';
import { Config } from '../../config/config';
import { vi, describe, it, expect, beforeEach } from 'vitest';

vi.mock('../../rag/RAGService');

describe('RetrieveCodeTool', () => {
  let retrieveCodeTool: RetrieveCodeTool;
  let mockRAGService: any;

  beforeEach(() => {
    const config = new Config({} as any);
    retrieveCodeTool = new RetrieveCodeTool(config);
    mockRAGService = RAGService.prototype;
  });

  it('should retrieve relevant code from the RAG system', async () => {
    mockRAGService.retrieveRelevantCode.mockResolvedValue('relevant code');
    const result = await retrieveCodeTool.execute({ query: 'test query' });
    expect(mockRAGService.retrieveRelevantCode).toHaveBeenCalledWith('test query', 5);
    expect(result.llmContent).toBe('relevant code');
  });
});
