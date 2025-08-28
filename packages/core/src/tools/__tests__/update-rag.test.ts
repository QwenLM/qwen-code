/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { UpdateRAGTool } from '../update-rag.js';
import { RAGService } from '../../rag/RAGService.js';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'fs';

vi.mock('fs');
vi.mock('../../rag/RAGService');

describe('UpdateRAGTool', () => {
  let updateRAGTool: UpdateRAGTool;
  let mockRAGService: any;

  beforeEach(() => {
    updateRAGTool = new UpdateRAGTool();
    mockRAGService = RAGService.prototype;
  });

  it('should update a file in the RAG system', async () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    vi.spyOn(fs, 'statSync').mockReturnValue({ isFile: () => true } as any);
    vi.spyOn(fs, 'readFileSync').mockReturnValue('file content');

    const result = await updateRAGTool.execute({ file_path: 'test.ts' });

    expect(mockRAGService.addOrUpdateCode).toHaveBeenCalledWith(expect.stringContaining('test.ts'), 'file content');
    expect(result.llmContent).toContain('Successfully updated RAG system');
  });

  it('should update a directory in the RAG system', async () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    vi.spyOn(fs, 'statSync').mockReturnValue({ isDirectory: () => true } as any);
    vi.spyOn(fs, 'readdirSync').mockReturnValue(['test.ts'] as any);

    const result = await updateRAGTool.execute({ directory_path: 'test_dir' });

    expect(result.llmContent).toContain('Successfully updated RAG system');
  });
});
