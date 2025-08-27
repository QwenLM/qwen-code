/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { FileWatcherService } from '../FileWatcherService.js';
import { RAGService } from '../../rag/RAGService.js';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'fs';

vi.mock('fs');
vi.mock('../../rag/RAGService');

describe('FileWatcherService', () => {
  let fileWatcherService: FileWatcherService;
  let mockRAGService: any;

  beforeEach(() => {
    fileWatcherService = new FileWatcherService();
    mockRAGService = RAGService.prototype;
  });

  it('should watch a file and update the RAG system on change', () => {
    const mockWatcher = { close: vi.fn() };
    vi.spyOn(fs, 'watch').mockReturnValue(mockWatcher as any);
    vi.spyOn(fs, 'readFileSync').mockReturnValue('new content');

    fileWatcherService.watchFile('test.ts');

    // Simulate a file change
    const watchCallback = (fs.watch as any).mock.calls[0][1];
    watchCallback('change');

    expect(fs.watch).toHaveBeenCalledWith('test.ts', expect.any(Function));
    expect(fs.readFileSync).toHaveBeenCalledWith('test.ts', 'utf8');
    expect(mockRAGService.addOrUpdateCode).toHaveBeenCalledWith('test.ts', 'new content');
  });

  it('should unwatch a file', () => {
    const mockWatcher = { close: vi.fn() };
    vi.spyOn(fs, 'watch').mockReturnValue(mockWatcher as any);

    fileWatcherService.watchFile('test.ts');
    fileWatcherService.unwatchFile('test.ts');

    expect(mockWatcher.close).toHaveBeenCalled();
  });
});
