/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  CompressionStatus,
  type ChatCompressionInfo,
  type LlmClient,
} from '@qwen-code/qwen-code-core';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { compressCommand } from './compressCommand.js';
import { createMockCommandContext } from '../../test-utils/mockCommandContext.js';
import { MessageType } from '../types.js';

describe('compressCommand', () => {
  let context: ReturnType<typeof createMockCommandContext>;
  let mockTryCompressChat: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockTryCompressChat = vi.fn();
    context = createMockCommandContext({
      services: {
        config: {
          getLlmClient: () =>
            ({
              tryCompressChat: mockTryCompressChat,
            }) as unknown as LlmClient,
        },
      },
    });
  });

  it('should do nothing if a compression is already pending', async () => {
    context.ui.pendingItem = {
      type: MessageType.COMPRESSION,
      compression: {
        isPending: true,
        originalTokenCount: null,
        newTokenCount: null,
        compressionStatus: null,
      },
    };
    await compressCommand.action!(context, '');
    expect(context.ui.addItem).toHaveBeenCalledWith(
      expect.objectContaining({
        type: MessageType.ERROR,
        text: 'Already compressing, wait for previous request to complete',
      }),
      expect.any(Number),
    );
    expect(context.ui.setPendingItem).not.toHaveBeenCalled();
    expect(mockTryCompressChat).not.toHaveBeenCalled();
  });

  it('should set pending item, call tryCompressChat, and add result on success', async () => {
    const compressedResult: ChatCompressionInfo = {
      originalTokenCount: 200,
      compressionStatus: CompressionStatus.COMPRESSED,
      newTokenCount: 100,
    };
    mockTryCompressChat.mockResolvedValue(compressedResult);

    await compressCommand.action!(context, '');

    expect(context.ui.setPendingItem).toHaveBeenNthCalledWith(1, {
      type: MessageType.COMPRESSION,
      compression: {
        isPending: true,
        compressionStatus: null,
        originalTokenCount: null,
        newTokenCount: null,
      },
    });

    expect(mockTryCompressChat).toHaveBeenCalledWith(
      expect.stringMatching(/^compress-\d+$/),
      true,
      undefined,
      undefined,
    );

    expect(context.ui.addItem).toHaveBeenCalledWith(
      {
        type: MessageType.COMPRESSION,
        compression: {
          isPending: false,
          compressionStatus: CompressionStatus.COMPRESSED,
          originalTokenCount: 200,
          newTokenCount: 100,
          compressionKind: 'summarize',
        },
      },
      expect.any(Number),
    );

    expect(context.ui.setPendingItem).toHaveBeenNthCalledWith(2, null);
  });

  it('should display warning when compaction model was swapped', async () => {
    const compressedResult: ChatCompressionInfo = {
      originalTokenCount: 200,
      compressionStatus: CompressionStatus.COMPRESSED,
      newTokenCount: 100,
      warning: 'Compaction model "small" context window too small',
    };
    mockTryCompressChat.mockResolvedValue(compressedResult);

    await compressCommand.action!(context, '');

    expect(context.ui.addItem).toHaveBeenCalledWith(
      {
        type: MessageType.INFO,
        text: '⚠️ Compaction model "small" context window too small',
      },
      expect.any(Number),
    );
  });

  it('should add an error message if tryCompressChat returns falsy', async () => {
    mockTryCompressChat.mockResolvedValue(null);

    await compressCommand.action!(context, '');

    expect(context.ui.addItem).toHaveBeenCalledWith(
      expect.objectContaining({
        type: MessageType.ERROR,
        text: 'Failed to compress chat history.',
      }),
      expect.any(Number),
    );
    expect(context.ui.setPendingItem).toHaveBeenCalledWith(null);
  });

  it('should keep compression failure statuses in the interactive history', async () => {
    const failedResult: ChatCompressionInfo = {
      originalTokenCount: 100000,
      newTokenCount: 100000,
      compressionStatus: CompressionStatus.COMPRESSION_FAILED_API_ERROR,
    };
    mockTryCompressChat.mockResolvedValue(failedResult);

    await compressCommand.action!(context, '');

    expect(context.ui.addItem).toHaveBeenCalledWith(
      {
        type: MessageType.COMPRESSION,
        compression: {
          isPending: false,
          compressionStatus: CompressionStatus.COMPRESSION_FAILED_API_ERROR,
          originalTokenCount: 100000,
          newTokenCount: 100000,
          compressionKind: 'summarize',
        },
      },
      expect.any(Number),
    );
  });

  // Issue #9309: after /compress-fast the summarize banner is measured on a
  // different scale (local history-only estimate vs the fast banner's
  // API-reported baseline), so the compression item must carry per-side
  // provenance for the renderer to mark estimated numbers.
  it('should pass token-count provenance to the compression item (interactive)', async () => {
    // Asymmetric flags so a swapped provenance assignment is detectable.
    mockTryCompressChat.mockResolvedValue({
      originalTokenCount: 200,
      newTokenCount: 100,
      originalTokenCountIsEstimated: true,
      newTokenCountIsEstimated: false,
      compressionStatus: CompressionStatus.COMPRESSED,
    } satisfies ChatCompressionInfo);

    await compressCommand.action!(context, '');

    expect(context.ui.addItem).toHaveBeenCalledWith(
      {
        type: MessageType.COMPRESSION,
        compression: {
          isPending: false,
          compressionStatus: CompressionStatus.COMPRESSED,
          originalTokenCount: 200,
          newTokenCount: 100,
          compressionKind: 'summarize',
          originalTokenCountIsEstimated: true,
          newTokenCountIsEstimated: false,
        },
      },
      expect.any(Number),
    );
  });

  it('should return an error in non-interactive mode for compression failure statuses', async () => {
    const failedResult: ChatCompressionInfo = {
      originalTokenCount: 100000,
      newTokenCount: 100000,
      compressionStatus: CompressionStatus.COMPRESSION_FAILED_API_ERROR,
    };
    mockTryCompressChat.mockResolvedValue(failedResult);
    const ctx = createMockCommandContext({
      executionMode: 'non_interactive',
      services: context.services,
    });

    await expect(compressCommand.action!(ctx, '')).resolves.toEqual({
      type: 'message',
      messageType: 'error',
      content: 'Could not compress chat history due to an API error.',
    });
  });

  it('should yield an ACP error for compression failure statuses', async () => {
    const failedResult: ChatCompressionInfo = {
      originalTokenCount: 100000,
      newTokenCount: 100000,
      compressionStatus: CompressionStatus.COMPRESSION_FAILED_API_ERROR,
    };
    mockTryCompressChat.mockResolvedValue(failedResult);
    const ctx = createMockCommandContext({
      executionMode: 'acp',
      services: context.services,
    });

    const result = await compressCommand.action!(ctx, '');
    expect(result?.type).toBe('stream_messages');

    const messages = [];
    if (result?.type === 'stream_messages') {
      for await (const message of result.messages) {
        messages.push(message);
      }
    }

    expect(messages).toEqual([
      { messageType: 'info', content: 'Compressing context...' },
      {
        messageType: 'error',
        content: 'Could not compress chat history due to an API error.',
      },
    ]);
  });

  it('should mark estimated counts in the non-interactive message', async () => {
    // Asymmetric flags mirror the real post-/compress-fast scenario and catch
    // a swapped flag-argument mutation at the formatTokenCount call sites.
    mockTryCompressChat.mockResolvedValue({
      originalTokenCount: 200,
      newTokenCount: 100,
      originalTokenCountIsEstimated: true,
      newTokenCountIsEstimated: false,
      compressionStatus: CompressionStatus.COMPRESSED,
    } satisfies ChatCompressionInfo);

    const ctx = createMockCommandContext({
      executionMode: 'non_interactive',
      services: {
        config: {
          getLlmClient: () =>
            ({
              tryCompressChat: mockTryCompressChat,
            }) as unknown as LlmClient,
        },
      },
    });

    const result = await compressCommand.action!(ctx, '');

    expect(result).toEqual({
      type: 'message',
      messageType: 'info',
      content: 'Context compressed (~200 -> 100).',
    });
  });

  it('should mark estimated counts in the ACP stream_messages branch', async () => {
    // Asymmetric flags mirror the real post-/compress-fast scenario and catch
    // a swapped flag-argument mutation at the ACP formatTokenCount site.
    mockTryCompressChat.mockResolvedValue({
      originalTokenCount: 200,
      newTokenCount: 100,
      originalTokenCountIsEstimated: true,
      newTokenCountIsEstimated: false,
      compressionStatus: CompressionStatus.COMPRESSED,
    } satisfies ChatCompressionInfo);

    const ctx = createMockCommandContext({
      executionMode: 'acp',
      services: {
        config: {
          getLlmClient: () =>
            ({
              tryCompressChat: mockTryCompressChat,
            }) as unknown as LlmClient,
        },
      },
    });

    const result = await compressCommand.action!(ctx, '');

    expect(result?.type).toBe('stream_messages');
    const messages = [];
    if (result?.type === 'stream_messages') {
      for await (const message of result.messages) {
        messages.push(message);
      }
    }
    expect(messages).toEqual([
      { messageType: 'info', content: 'Compressing context...' },
      { messageType: 'info', content: 'Context compressed (~200 -> 100).' },
    ]);
  });

  it('should add an error message if tryCompressChat throws', async () => {
    const error = new Error('Compression failed');
    mockTryCompressChat.mockRejectedValue(error);

    await compressCommand.action!(context, '');

    expect(context.ui.addItem).toHaveBeenCalledWith(
      expect.objectContaining({
        type: MessageType.ERROR,
        text: `Failed to compress chat history: ${error.message}`,
      }),
      expect.any(Number),
    );
    expect(context.ui.setPendingItem).toHaveBeenCalledWith(null);
  });

  it('should clear the pending item in a finally block', async () => {
    mockTryCompressChat.mockRejectedValue(new Error('some error'));
    await compressCommand.action!(context, '');
    expect(context.ui.setPendingItem).toHaveBeenCalledWith(null);
  });

  describe('custom instructions argument', () => {
    beforeEach(() => {
      mockTryCompressChat.mockResolvedValue({
        originalTokenCount: 200,
        compressionStatus: CompressionStatus.COMPRESSED,
        newTokenCount: 100,
      } satisfies ChatCompressionInfo);
    });

    it('forwards trimmed instructions as the 4th argument', async () => {
      const ctx = createMockCommandContext({
        services: {
          config: {
            getLlmClient: () =>
              ({
                tryCompressChat: mockTryCompressChat,
              }) as unknown as LlmClient,
          },
        },
        invocation: {
          raw: '/compress   focus on auth bug   ',
          name: 'compress',
          args: '  focus on auth bug  ',
        },
      });
      await compressCommand.action!(ctx, '');
      expect(mockTryCompressChat).toHaveBeenCalledWith(
        expect.stringMatching(/^compress-\d+$/),
        true,
        undefined,
        'focus on auth bug',
      );
    });

    it('passes undefined when args is empty or whitespace only', async () => {
      const ctx = createMockCommandContext({
        services: {
          config: {
            getLlmClient: () =>
              ({
                tryCompressChat: mockTryCompressChat,
              }) as unknown as LlmClient,
          },
        },
        invocation: { raw: '/compress    ', name: 'compress', args: '    ' },
      });
      await compressCommand.action!(ctx, '');
      expect(mockTryCompressChat).toHaveBeenCalledWith(
        expect.stringMatching(/^compress-\d+$/),
        true,
        undefined,
        undefined,
      );
    });

    it('caps overlong instructions at 2000 chars', async () => {
      const long = 'x'.repeat(3000);
      const ctx = createMockCommandContext({
        services: {
          config: {
            getLlmClient: () =>
              ({
                tryCompressChat: mockTryCompressChat,
              }) as unknown as LlmClient,
          },
        },
        invocation: {
          raw: `/compress ${long}`,
          name: 'compress',
          args: long,
        },
      });
      await compressCommand.action!(ctx, '');
      const call = mockTryCompressChat.mock.calls[0];
      expect(call[3]).toBeDefined();
      expect((call[3] as string).length).toBe(2000);
    });

    it('surfaces an INFO notice to the user when instructions are truncated', async () => {
      const long = 'x'.repeat(3000);
      const ctx = createMockCommandContext({
        services: {
          config: {
            getLlmClient: () =>
              ({
                tryCompressChat: mockTryCompressChat,
              }) as unknown as LlmClient,
          },
        },
        invocation: { raw: `/compress ${long}`, name: 'compress', args: long },
      });
      await compressCommand.action!(ctx, '');
      expect(ctx.ui.addItem).toHaveBeenCalledWith(
        expect.objectContaining({
          type: MessageType.INFO,
          text: expect.stringContaining('truncated'),
        }),
        expect.any(Number),
      );
    });

    it('does NOT show a truncation notice when instructions fit under the cap', async () => {
      const ctx = createMockCommandContext({
        services: {
          config: {
            getLlmClient: () =>
              ({
                tryCompressChat: mockTryCompressChat,
              }) as unknown as LlmClient,
          },
        },
        invocation: {
          raw: '/compress short',
          name: 'compress',
          args: 'short',
        },
      });
      await compressCommand.action!(ctx, '');
      const infoCalls = (
        ctx.ui.addItem as ReturnType<typeof vi.fn>
      ).mock.calls.filter(
        (c) =>
          (c[0] as { type?: MessageType }).type === MessageType.INFO &&
          typeof (c[0] as { text?: string }).text === 'string' &&
          (c[0] as { text: string }).text.includes('truncated'),
      );
      expect(infoCalls).toHaveLength(0);
    });
  });
});
