/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  CompressionStatus,
  cloneUsage,
  type Message,
  createAssistantMessage,
  createUserMessage,
  initializeI18nService,
} from '@qwen-code/core';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { compactCommand } from './compressCommand.js';
import { createMockCommandContext } from '../../test-utils/mockCommandContext.js';
import { MessageType } from '../types.js';
import type { RunManualCompress } from '../hooks/localSession.shared.js';
import type { CommandContext } from './types.js';

describe('compactCommand', () => {
  let context: ReturnType<typeof createMockCommandContext>;
  let mockRunManualCompress: ReturnType<typeof vi.fn<RunManualCompress>>;
  let mockSetMessages: ReturnType<
    typeof vi.fn<NonNullable<CommandContext['setMessages']>>
  >;

  beforeEach(() => {
    initializeI18nService();
    mockRunManualCompress = vi.fn<RunManualCompress>();
    mockSetMessages = vi.fn<NonNullable<CommandContext['setMessages']>>();

    context = createMockCommandContext({
      services: {
        agentContext: {
          getModel: vi.fn().mockReturnValue('gemini-2.0-flash'),
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any,
      },
    });
    context.messages = [
      createUserMessage('Hello'),
      createAssistantMessage({
        messageId: 'response-1',

        model: 'test-model',
        stopReason: 'end_turn',

        blocks: [{ type: 'text', text: 'Hi there!' }],
        usage: ((value) => ({
          inputTokens: value.input_tokens,
          outputTokens: value.output_tokens,
          cacheReadInputTokens: value.cache_read_input_tokens,
          cacheCreationInputTokens: value.cache_creation_input_tokens,
        }))(cloneUsage()),
      }),
    ];
    context.setMessages = mockSetMessages;
    context.runManualCompress = mockRunManualCompress;
  });

  afterEach(() => {
    vi.restoreAllMocks();
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
    await compactCommand.action!(context, '');
    expect(context.ui.addItem).toHaveBeenCalledWith(
      expect.objectContaining({
        type: MessageType.ERROR,
        text: 'Already compressing, wait for previous request to complete',
      }),
      expect.any(Number),
    );
    expect(context.ui.setPendingItem).not.toHaveBeenCalled();
    expect(mockRunManualCompress).not.toHaveBeenCalled();
  });

  it('should delegate to runManualCompress, apply result, and add item on success', async () => {
    const compressedHistory: Message[] = [
      createUserMessage('<summary>', { isCompactSummary: true }),
      {
        type: 'attachment',
        uuid: 'att-1',
        timestamp: '2026-01-01T00:00:00Z',
        attachment: {
          type: 'post_compact_restored_files',
          files: [{ filePath: '/f.ts', content: 'body', truncated: false }],
        },
      },
    ];
    mockRunManualCompress.mockResolvedValue({
      newHistory: compressedHistory,
      info: {
        originalTokenCount: 200,
        newTokenCount: 100,
        compressionStatus: CompressionStatus.COMPRESSED,
      },
    });

    await compactCommand.action!(context, '');

    expect(context.ui.setPendingItem).toHaveBeenNthCalledWith(1, {
      type: MessageType.COMPRESSION,
      compression: {
        isPending: true,
        compressionStatus: null,
        originalTokenCount: null,
        newTokenCount: null,
      },
    });

    expect(mockRunManualCompress).toHaveBeenCalledTimes(1);

    expect(mockSetMessages).toHaveBeenCalledTimes(1);
    const updater = mockSetMessages.mock.calls[0][0];
    expect(updater([])).toEqual(compressedHistory);

    // The final "Conversation compacted …" row is now added by the
    // orchestrator's `onCompactionPersisted` callback, not by compressCommand
    // itself — so we no longer expect addItem here on the success path.
    // compressCommand only handles the internal pending marker + error rows.
    expect(context.ui.addItem).not.toHaveBeenCalled();

    expect(context.ui.setPendingItem).toHaveBeenNthCalledWith(2, null);
  });

  it('should show info when runManualCompress returns null newHistory (NOOP)', async () => {
    mockRunManualCompress.mockResolvedValue({
      newHistory: null,
      info: {
        originalTokenCount: 200,
        newTokenCount: 200,
        compressionStatus: CompressionStatus.NOOP,
      },
    });

    await compactCommand.action!(context, '');

    expect(context.ui.addItem).toHaveBeenCalledWith(
      expect.objectContaining({
        type: MessageType.INFO,
        text: expect.stringContaining(
          '/compact needs at least one model response',
        ),
      }),
      expect.any(Number),
    );
    expect(context.ui.setPendingItem).toHaveBeenCalledWith(null);
  });

  it('should report compaction model request failures directly', async () => {
    mockRunManualCompress.mockResolvedValue({
      newHistory: null,
      info: {
        originalTokenCount: 200,
        newTokenCount: 200,
        compressionStatus: CompressionStatus.COMPRESSION_FAILED_MODEL_REQUEST,
        failureReason: 'quota_exhausted',
        providerStatus: 403,
        providerCode: '112',
        providerSource: 'qoder',
      },
    });

    await compactCommand.action!(context, '');

    expect(context.ui.addItem).toHaveBeenCalledWith(
      expect.objectContaining({
        type: MessageType.INFO,
        text: expect.stringContaining(
          'credits or usage quota are exhausted',
        ),
      }),
      expect.any(Number),
    );
    expect(context.ui.addItem).not.toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining('empty summary'),
      }),
      expect.any(Number),
    );
  });

  it('should show dynamic provider text for compaction model request failures', async () => {
    mockRunManualCompress.mockResolvedValue({
      newHistory: null,
      info: {
        originalTokenCount: 200,
        newTokenCount: 200,
        compressionStatus: CompressionStatus.COMPRESSION_FAILED_MODEL_REQUEST,
        failureReason: 'provider_error',
        providerStatus: 416,
        providerCode: '406',
        providerSource: 'qoder',
        displayErrorCode: 'missing.compact.error.code',
        errorFallbackMessage:
          'This conversation contains sensitive content. Try switching models.',
      },
    });

    await compactCommand.action!(context, '');

    expect(context.ui.addItem).toHaveBeenCalledWith(
      expect.objectContaining({
        type: MessageType.INFO,
        text: 'This conversation contains sensitive content. Try switching models.',
      }),
      expect.any(Number),
    );
    expect(context.ui.addItem).not.toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining('empty summary'),
      }),
      expect.any(Number),
    );
  });

  it('preserves the empty-summary error when credits are not exhausted', async () => {
    mockRunManualCompress.mockResolvedValue({
      newHistory: null,
      info: {
        originalTokenCount: 200,
        newTokenCount: 200,
        compressionStatus: CompressionStatus.COMPRESSION_FAILED_EMPTY_SUMMARY,
      },
    });

    await compactCommand.action!(context, '');

    expect(context.ui.addItem).toHaveBeenCalledWith(
      {
        type: MessageType.INFO,
        text: 'Compression failed: the model returned an empty summary. Please try again.',
      },
      expect.any(Number),
    );
  });

  it('should add an error message if runManualCompress throws', async () => {
    const error = new Error('Compression failed');
    mockRunManualCompress.mockRejectedValue(error);

    await compactCommand.action!(context, '');

    expect(context.ui.addItem).toHaveBeenCalledWith(
      expect.objectContaining({
        type: MessageType.ERROR,
        text: expect.stringContaining(error.message),
      }),
      expect.any(Number),
    );
    expect(context.ui.setPendingItem).toHaveBeenCalledWith(null);
  });

  it('should clear the pending item in a finally block', async () => {
    mockRunManualCompress.mockRejectedValue(new Error('some error'));
    await compactCommand.action!(context, '');
    expect(context.ui.setPendingItem).toHaveBeenCalledWith(null);
  });

  it('should add error if config/messages are missing', async () => {
    const noMessagesContext = createMockCommandContext({
      services: { agentContext: null },
    });

    await compactCommand.action!(noMessagesContext, '');

    expect(noMessagesContext.ui.addItem).toHaveBeenCalledWith(
      expect.objectContaining({
        type: MessageType.ERROR,
        text: expect.stringContaining('Failed to compress'),
      }),
      expect.any(Number),
    );
  });

  it('should add error if runManualCompress is missing', async () => {
    context.runManualCompress = undefined;

    await compactCommand.action!(context, '');

    expect(context.ui.addItem).toHaveBeenCalledWith(
      expect.objectContaining({
        type: MessageType.ERROR,
        text: expect.stringContaining('not available'),
      }),
      expect.any(Number),
    );
  });

  it('forwards args from /compact <text> to runManualCompress as customInstructions', async () => {
    mockRunManualCompress.mockResolvedValue({
      newHistory: null,
      info: {
        originalTokenCount: 50,
        newTokenCount: 50,
        compressionStatus: CompressionStatus.NOOP,
      },
    });

    await compactCommand.action!(context, '  keep API details  ');

    expect(mockRunManualCompress).toHaveBeenCalledWith('keep API details');
  });

  it('passes undefined when /compact is called with no args', async () => {
    mockRunManualCompress.mockResolvedValue({
      newHistory: null,
      info: {
        originalTokenCount: 50,
        newTokenCount: 50,
        compressionStatus: CompressionStatus.NOOP,
      },
    });

    await compactCommand.action!(context, '');

    expect(mockRunManualCompress).toHaveBeenCalledWith(undefined);
  });

  it('renders an ERROR item with blockReason and does not replace messages when PreCompact blocked', async () => {
    mockRunManualCompress.mockResolvedValue({
      newHistory: null,
      info: {
        originalTokenCount: 100,
        newTokenCount: 100,
        compressionStatus:
          CompressionStatus.COMPRESSION_FAILED_PRECOMPACT_BLOCKED,
        blockReason: 'nope — release freeze',
      },
    });

    await compactCommand.action!(context, '');

    expect(mockSetMessages).not.toHaveBeenCalled();
    expect(context.ui.addItem).toHaveBeenCalledWith(
      expect.objectContaining({
        type: MessageType.ERROR,
        text: 'nope — release freeze',
      }),
      expect.any(Number),
    );
    expect(context.ui.setPendingItem).toHaveBeenCalledWith(null);
  });

  describe('metadata', () => {
    it('should have the correct name and aliases', () => {
      expect(compactCommand.name).toBe('compact');
      expect(compactCommand.altNames).toContain('summarize');
      expect(compactCommand.altNames).toContain('compress');
    });
  });
});
