/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  CompressionStatus,
  type ChatCompressionInfo,
  type GeminiClient,
} from '@qwen-code/qwen-code-core';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { compressFastCommand } from './compressFastCommand.js';
import { createMockCommandContext } from '../../test-utils/mockCommandContext.js';
import { MessageType } from '../types.js';

describe('compressFastCommand', () => {
  let context: ReturnType<typeof createMockCommandContext>;
  let mockTryCompressChatFast: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockTryCompressChatFast = vi.fn();
    context = createMockCommandContext({
      services: {
        config: {
          getGeminiClient: () =>
            ({
              tryCompressChatFast: mockTryCompressChatFast,
            }) as unknown as GeminiClient,
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
    await compressFastCommand.action!(context, '');
    expect(context.ui.addItem).toHaveBeenCalledWith(
      expect.objectContaining({
        type: MessageType.ERROR,
        text: 'Already compressing, wait for previous request to complete',
      }),
      expect.any(Number),
    );
    expect(mockTryCompressChatFast).not.toHaveBeenCalled();
  });

  it('should call tryCompressChatFast without arguments', async () => {
    mockTryCompressChatFast.mockResolvedValue({
      originalTokenCount: 200,
      newTokenCount: 100,
      compressionStatus: CompressionStatus.COMPRESSED,
    } satisfies ChatCompressionInfo);

    await compressFastCommand.action!(context, '');

    expect(mockTryCompressChatFast).toHaveBeenCalledWith();
  });

  it('should display compression result on success (interactive)', async () => {
    mockTryCompressChatFast.mockResolvedValue({
      originalTokenCount: 200,
      newTokenCount: 100,
      compressionStatus: CompressionStatus.COMPRESSED,
    } satisfies ChatCompressionInfo);

    await compressFastCommand.action!(context, '');

    expect(context.ui.addItem).toHaveBeenCalledWith(
      {
        type: MessageType.COMPRESSION,
        compression: {
          isPending: false,
          originalTokenCount: 200,
          newTokenCount: 100,
          compressionStatus: CompressionStatus.COMPRESSED,
        },
      },
      expect.any(Number),
    );
    expect(context.ui.setPendingItem).toHaveBeenLastCalledWith(null);
  });

  it('should show "No compression needed" when tokens unchanged', async () => {
    mockTryCompressChatFast.mockResolvedValue({
      originalTokenCount: 100,
      newTokenCount: 100,
      compressionStatus: CompressionStatus.NOOP,
    } satisfies ChatCompressionInfo);

    await compressFastCommand.action!(context, '');

    expect(context.ui.addItem).toHaveBeenCalledWith(
      expect.objectContaining({
        type: MessageType.INFO,
        text: 'No compression needed.',
      }),
      expect.any(Number),
    );
  });

  it('should handle errors gracefully', async () => {
    const error = new Error('Compression failed');
    mockTryCompressChatFast.mockRejectedValue(error);

    await compressFastCommand.action!(context, '');

    expect(context.ui.addItem).toHaveBeenCalledWith(
      expect.objectContaining({
        type: MessageType.ERROR,
        text: `Failed to compress chat history: ${error.message}`,
      }),
      expect.any(Number),
    );
    expect(context.ui.setPendingItem).toHaveBeenCalledWith(null);
  });

  it('should return error message in non-interactive mode', async () => {
    const error = new Error('Compression failed');
    mockTryCompressChatFast.mockRejectedValue(error);

    const ctx = createMockCommandContext({
      executionMode: 'non_interactive',
      services: {
        config: {
          getGeminiClient: () =>
            ({
              tryCompressChatFast: mockTryCompressChatFast,
            }) as unknown as GeminiClient,
        },
      },
    });

    const result = await compressFastCommand.action!(ctx, '');

    expect(result).toEqual({
      type: 'message',
      messageType: 'error',
      content: `Failed to compress chat history: ${error.message}`,
    });
  });

  it('should return info message in non-interactive mode on success', async () => {
    mockTryCompressChatFast.mockResolvedValue({
      originalTokenCount: 200,
      newTokenCount: 100,
      compressionStatus: CompressionStatus.COMPRESSED,
    } satisfies ChatCompressionInfo);

    const ctx = createMockCommandContext({
      executionMode: 'non_interactive',
      services: {
        config: {
          getGeminiClient: () =>
            ({
              tryCompressChatFast: mockTryCompressChatFast,
            }) as unknown as GeminiClient,
        },
      },
    });

    const result = await compressFastCommand.action!(ctx, '');

    expect(result).toEqual({
      type: 'message',
      messageType: 'info',
      content: 'Context compressed (200 -> 100).',
    });
  });
});
