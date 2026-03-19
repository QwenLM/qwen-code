/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createMockCommandContext } from '../test-utils/mockCommandContext.js';
import type { CommandContext } from '../ui/commands/types.js';
import {
  CodebaseProvider,
  CODEBASE_INJECTION_TRIGGER,
  DEFAULT_CODEBASE_PROVIDER_CONFIG,
} from './codebaseProvider.js';
import { MessageType } from '../ui/types.js';
import type { IndexService } from '@qwen-code/qwen-code-core';
import type { PartUnion } from '@google/genai';

describe('CodebaseProvider', () => {
  let context: CommandContext;

  // Helper to create mock IndexService
  const createMockIndexService = (status: string = 'done') =>
    ({
      getStatus: vi.fn().mockReturnValue({ status }),
    }) as unknown as IndexService;

  // Helper to create context with mocked IndexService
  const createContextWithService = (service: IndexService | undefined) =>
    createMockCommandContext({
      services: {
        config: service
          ? ({
              getWorkingDir: () => '/test/project',
              getIndexService: () => service,
            } as never)
          : ({
              getWorkingDir: () => '/test/project',
              getIndexService: () => undefined,
            } as never),
      },
    });

  beforeEach(() => {
    vi.clearAllMocks();
    context = createContextWithService(createMockIndexService('done'));
  });

  describe('constants', () => {
    it('should have correct injection trigger', () => {
      expect(CODEBASE_INJECTION_TRIGGER).toBe('@codebase{');
    });

    it('should have default config values', () => {
      expect(DEFAULT_CODEBASE_PROVIDER_CONFIG).toEqual({
        maxTokens: 4000,
        topK: 10,
        enableGraph: false,
      });
    });
  });

  describe('process', () => {
    it('should not change prompt if no @codebase{ trigger is present', async () => {
      const processor = new CodebaseProvider();
      const prompt: PartUnion[] = [{ text: 'This is a simple prompt.' }];

      const result = await processor.process(prompt, context);

      expect(result).toEqual(prompt);
    });

    it('should not change prompt if config service is missing', async () => {
      const processor = new CodebaseProvider();
      const prompt: PartUnion[] = [{ text: 'Query @codebase{test}' }];
      const contextWithoutConfig = createMockCommandContext({
        services: {
          config: null,
        },
      });

      const result = await processor.process(prompt, contextWithoutConfig);

      expect(result).toEqual(prompt);
    });

    it('should handle empty query gracefully', async () => {
      const processor = new CodebaseProvider();
      const prompt: PartUnion[] = [{ text: 'Query @codebase{}' }];

      const result = await processor.process(prompt, context);

      // Empty query should be skipped, leaving only prefix
      expect(result).toEqual([{ text: 'Query ' }]);
    });

    it('should throw error when index service is not initialized', async () => {
      context = createContextWithService(undefined);
      const processor = new CodebaseProvider();
      const prompt: PartUnion[] = [
        { text: 'Query @codebase{authentication flow}' },
      ];

      const result = await processor.process(prompt, context);

      // Should show error and include placeholder
      expect(context.ui.addItem).toHaveBeenCalledWith(
        {
          type: MessageType.ERROR,
          text: expect.stringContaining('not initialized'),
        },
        expect.any(Number),
      );
      expect(result).toEqual([
        { text: 'Query ' },
        { text: '[Codebase search failed: "authentication flow"]' },
      ]);
    });

    it('should throw error when index is not ready', async () => {
      context = createContextWithService(createMockIndexService('scanning'));
      const processor = new CodebaseProvider();
      const prompt: PartUnion[] = [{ text: 'Query @codebase{test query}' }];

      await processor.process(prompt, context);

      expect(context.ui.addItem).toHaveBeenCalledWith(
        {
          type: MessageType.ERROR,
          text: expect.stringContaining('not ready'),
        },
        expect.any(Number),
      );
    });

    it('should process valid query when index is done', async () => {
      context = createContextWithService(createMockIndexService('done'));
      const processor = new CodebaseProvider();
      const prompt: PartUnion[] = [{ text: 'Query @codebase{user auth}' }];

      const result = await processor.process(prompt, context);

      // Should return enhanced query result
      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({ text: 'Query ' });
      // The second part should contain context info
      expect((result[1] as { text: string }).text).toContain(
        'Codebase Context for',
      );
    });

    it('should handle multiple @codebase injections', async () => {
      context = createContextWithService(createMockIndexService('done'));
      const processor = new CodebaseProvider();
      const prompt: PartUnion[] = [
        { text: 'Compare @codebase{login} with @codebase{logout}' },
      ];

      const result = await processor.process(prompt, context);

      // Should have: prefix + result1 + middle + result2
      expect(result.length).toBeGreaterThan(2);
      expect((result[0] as { text: string }).text).toBe('Compare ');
    });

    it('should preserve text before and after injection', async () => {
      context = createContextWithService(createMockIndexService('done'));
      const processor = new CodebaseProvider();
      const prompt: PartUnion[] = [{ text: 'Prefix @codebase{query} Suffix' }];

      const result = await processor.process(prompt, context);

      expect((result[0] as { text: string }).text).toBe('Prefix ');
      expect((result[result.length - 1] as { text: string }).text).toBe(
        ' Suffix',
      );
    });
  });

  describe('configuration', () => {
    it('should use default config when no config provided', () => {
      const processor = new CodebaseProvider();
      // Access private config through any type assertion for testing
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const config = (processor as any).config;

      expect(config).toEqual(DEFAULT_CODEBASE_PROVIDER_CONFIG);
    });

    it('should merge custom config with defaults', () => {
      const processor = new CodebaseProvider({
        maxTokens: 8000,
        topK: 20,
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const config = (processor as any).config;

      expect(config.maxTokens).toBe(8000);
      expect(config.topK).toBe(20);
      expect(config.enableGraph).toBe(false); // Default value
    });
  });

  describe('UI feedback', () => {
    it('should show info message on successful retrieval', async () => {
      context = createContextWithService(createMockIndexService('done'));
      const processor = new CodebaseProvider();
      const prompt: PartUnion[] = [{ text: '@codebase{test query}' }];

      await processor.process(prompt, context);

      expect(context.ui.addItem).toHaveBeenCalledWith(
        {
          type: MessageType.INFO,
          text: expect.stringContaining('Retrieved'),
        },
        expect.any(Number),
      );
    });
  });
});
