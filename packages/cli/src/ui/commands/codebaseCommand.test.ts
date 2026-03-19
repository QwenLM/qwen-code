/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { codebaseCommand } from './codebaseCommand.js';
import type { CommandContext } from './types.js';
import { createMockCommandContext } from '../../test-utils/mockCommandContext.js';
import { MessageType } from '../types.js';
import type { IndexingProgress, IndexService } from '@qwen-code/qwen-code-core';

describe('codebaseCommand', () => {
  let mockContext: CommandContext;

  // Helper to create mock IndexService
  const createMockIndexService = (progress: Partial<IndexingProgress> = {}) => {
    const defaultProgress: IndexingProgress = {
      status: 'idle',
      phase: 0,
      phaseProgress: 0,
      overallProgress: 0,
      totalFiles: 0,
      scannedFiles: 0,
      chunkedFiles: 0,
      totalChunks: 0,
      embeddedChunks: 0,
      storedChunks: 0,
      startTime: 0,
      estimatedTimeRemaining: 0,
      error: undefined,
    };

    return {
      getStatus: vi.fn().mockReturnValue({ ...defaultProgress, ...progress }),
      startBuild: vi.fn().mockResolvedValue(undefined),
      pause: vi.fn(),
      resume: vi.fn(),
    } as unknown as IndexService;
  };

  // Helper to create context with mocked IndexService
  const createContextWithService = (service: IndexService | undefined) =>
    createMockCommandContext({
      services: {
        config: service
          ? ({
              getIndexService: () => service,
            } as never)
          : null,
      },
    });

  beforeEach(() => {
    mockContext = createMockCommandContext();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('main action', () => {
    it('should show warning when service is not initialized', async () => {
      mockContext = createContextWithService(undefined);

      await codebaseCommand.action!(mockContext, '');

      expect(mockContext.ui.addItem).toHaveBeenCalledWith(
        {
          type: MessageType.WARNING,
          text: expect.stringContaining('not available'),
        },
        expect.any(Number),
      );
    });

    it('should show status when service is initialized', async () => {
      const mockService = createMockIndexService({
        status: 'embedding',
        overallProgress: 50,
        totalFiles: 100,
        scannedFiles: 80,
        totalChunks: 500,
        embeddedChunks: 250,
      });
      mockContext = createContextWithService(mockService);

      await codebaseCommand.action!(mockContext, '');

      expect(mockContext.ui.addItem).toHaveBeenCalledWith(
        {
          type: MessageType.INFO,
          text: expect.stringContaining('Status:'),
        },
        expect.any(Number),
      );
    });
  });

  describe('status subcommand', () => {
    const statusCommand = codebaseCommand.subCommands?.find(
      (sc) => sc.name === 'status',
    );

    it('should show warning when service is not initialized', async () => {
      mockContext = createContextWithService(undefined);

      await statusCommand!.action!(mockContext, '');

      expect(mockContext.ui.addItem).toHaveBeenCalledWith(
        {
          type: MessageType.WARNING,
          text: expect.stringContaining('not initialized'),
        },
        expect.any(Number),
      );
    });

    it('should show detailed status information', async () => {
      const mockService = createMockIndexService({
        status: 'embedding',
        overallProgress: 75,
        totalFiles: 200,
        scannedFiles: 200,
        chunkedFiles: 180,
        totalChunks: 1000,
        embeddedChunks: 750,
        storedChunks: 700,
        startTime: Date.now() - 60000, // 1 minute ago
        estimatedTimeRemaining: 20000,
      });
      mockContext = createContextWithService(mockService);

      await statusCommand!.action!(mockContext, '');

      expect(mockContext.ui.addItem).toHaveBeenCalledWith(
        {
          type: MessageType.INFO,
          text: expect.stringMatching(/Index Status.*Generating embeddings/s),
        },
        expect.any(Number),
      );
    });

    it('should show error message when status contains error', async () => {
      const mockService = createMockIndexService({
        status: 'error',
        error: 'API rate limit exceeded',
      });
      mockContext = createContextWithService(mockService);

      await statusCommand!.action!(mockContext, '');

      expect(mockContext.ui.addItem).toHaveBeenCalledWith(
        {
          type: MessageType.INFO,
          text: expect.stringContaining('API rate limit exceeded'),
        },
        expect.any(Number),
      );
    });
  });

  describe('rebuild subcommand', () => {
    const rebuildCommand = codebaseCommand.subCommands?.find(
      (sc) => sc.name === 'rebuild',
    );

    it('should show error when service is not available', async () => {
      mockContext = createContextWithService(undefined);

      await rebuildCommand!.action!(mockContext, '');

      expect(mockContext.ui.addItem).toHaveBeenCalledWith(
        {
          type: MessageType.ERROR,
          text: expect.stringContaining('not available'),
        },
        expect.any(Number),
      );
    });

    it('should show warning when build is already in progress', async () => {
      const mockService = createMockIndexService({
        status: 'embedding',
        overallProgress: 50,
      });
      mockContext = createContextWithService(mockService);

      await rebuildCommand!.action!(mockContext, '');

      expect(mockContext.ui.addItem).toHaveBeenCalledWith(
        {
          type: MessageType.WARNING,
          text: expect.stringContaining('already in progress'),
        },
        expect.any(Number),
      );
    });

    it('should start build when status is idle', async () => {
      const mockService = createMockIndexService({ status: 'idle' });
      mockContext = createContextWithService(mockService);

      await rebuildCommand!.action!(mockContext, '');

      expect(mockService.startBuild).toHaveBeenCalled();
      expect(mockContext.ui.addItem).toHaveBeenCalledWith(
        {
          type: MessageType.INFO,
          text: expect.stringContaining('Starting'),
        },
        expect.any(Number),
      );
    });

    it('should start build when previous build is done', async () => {
      const mockService = createMockIndexService({ status: 'done' });
      mockContext = createContextWithService(mockService);

      await rebuildCommand!.action!(mockContext, '');

      expect(mockService.startBuild).toHaveBeenCalled();
    });

    it('should handle build errors', async () => {
      const mockService = createMockIndexService({ status: 'idle' });
      vi.mocked(mockService.startBuild).mockRejectedValue(
        new Error('Build failed'),
      );
      mockContext = createContextWithService(mockService);

      await rebuildCommand!.action!(mockContext, '');

      expect(mockContext.ui.addItem).toHaveBeenCalledWith(
        {
          type: MessageType.ERROR,
          text: expect.stringContaining('Failed to start'),
        },
        expect.any(Number),
      );
    });
  });

  describe('pause subcommand', () => {
    const pauseCommand = codebaseCommand.subCommands?.find(
      (sc) => sc.name === 'pause',
    );

    it('should show error when service is not available', async () => {
      mockContext = createContextWithService(undefined);

      await pauseCommand!.action!(mockContext, '');

      expect(mockContext.ui.addItem).toHaveBeenCalledWith(
        {
          type: MessageType.ERROR,
          text: expect.stringContaining('not available'),
        },
        expect.any(Number),
      );
    });

    it('should show warning when already paused', async () => {
      const mockService = createMockIndexService({ status: 'paused' });
      mockContext = createContextWithService(mockService);

      await pauseCommand!.action!(mockContext, '');

      expect(mockContext.ui.addItem).toHaveBeenCalledWith(
        {
          type: MessageType.WARNING,
          text: expect.stringContaining('already paused'),
        },
        expect.any(Number),
      );
    });

    it('should show warning when no operation in progress', async () => {
      const mockService = createMockIndexService({ status: 'idle' });
      mockContext = createContextWithService(mockService);

      await pauseCommand!.action!(mockContext, '');

      expect(mockContext.ui.addItem).toHaveBeenCalledWith(
        {
          type: MessageType.WARNING,
          text: expect.stringContaining('No indexing operation'),
        },
        expect.any(Number),
      );
    });

    it('should pause when indexing is in progress', async () => {
      const mockService = createMockIndexService({ status: 'embedding' });
      mockContext = createContextWithService(mockService);

      await pauseCommand!.action!(mockContext, '');

      expect(mockService.pause).toHaveBeenCalled();
      expect(mockContext.ui.addItem).toHaveBeenCalledWith(
        {
          type: MessageType.INFO,
          text: expect.stringContaining('paused'),
        },
        expect.any(Number),
      );
    });
  });

  describe('resume subcommand', () => {
    const resumeCommand = codebaseCommand.subCommands?.find(
      (sc) => sc.name === 'resume',
    );

    it('should show error when service is not available', async () => {
      mockContext = createContextWithService(undefined);

      await resumeCommand!.action!(mockContext, '');

      expect(mockContext.ui.addItem).toHaveBeenCalledWith(
        {
          type: MessageType.ERROR,
          text: expect.stringContaining('not available'),
        },
        expect.any(Number),
      );
    });

    it('should show warning when not paused', async () => {
      const mockService = createMockIndexService({ status: 'embedding' });
      mockContext = createContextWithService(mockService);

      await resumeCommand!.action!(mockContext, '');

      expect(mockContext.ui.addItem).toHaveBeenCalledWith(
        {
          type: MessageType.WARNING,
          text: expect.stringContaining('not paused'),
        },
        expect.any(Number),
      );
    });

    it('should resume when paused', async () => {
      const mockService = createMockIndexService({ status: 'paused' });
      mockContext = createContextWithService(mockService);

      await resumeCommand!.action!(mockContext, '');

      expect(mockService.resume).toHaveBeenCalled();
      expect(mockContext.ui.addItem).toHaveBeenCalledWith(
        {
          type: MessageType.INFO,
          text: expect.stringContaining('resumed'),
        },
        expect.any(Number),
      );
    });
  });

  describe('completion', () => {
    it('should return all subcommands when no partial arg', async () => {
      const completions = await codebaseCommand.completion!(mockContext, '');

      expect(completions).toEqual(['status', 'rebuild', 'pause', 'resume']);
    });

    it('should filter subcommands by partial arg', async () => {
      const completions = await codebaseCommand.completion!(mockContext, 're');

      expect(completions).toEqual(['rebuild', 'resume']);
    });

    it('should return empty array when no matches', async () => {
      const completions = await codebaseCommand.completion!(mockContext, 'xyz');

      expect(completions).toEqual([]);
    });
  });

  describe('command metadata', () => {
    it('should have correct name', () => {
      expect(codebaseCommand.name).toBe('codebase');
    });

    it('should have alternative name "index"', () => {
      expect(codebaseCommand.altNames).toContain('index');
    });

    it('should have description', () => {
      expect(codebaseCommand.description).toBeTruthy();
      expect(codebaseCommand.description).toContain('indexing');
    });

    it('should have 4 subcommands', () => {
      expect(codebaseCommand.subCommands).toHaveLength(4);
    });
  });
});
