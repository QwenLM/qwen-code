/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { vi, describe, it, expect, beforeEach } from 'vitest';
import { clearCommand } from './clearCommand.js';
import { type CommandContext } from './types.js';
import { createMockCommandContext } from '../../test-utils/mockCommandContext.js';

// Mock the telemetry service
vi.mock('@qwen-code/qwen-code-core', async () => {
  const actual = await vi.importActual('@qwen-code/qwen-code-core');
  return {
    ...actual,
    uiTelemetryService: {
      reset: vi.fn(),
    },
  };
});

import type { GeminiClient } from '@qwen-code/qwen-code-core';

describe('clearCommand', () => {
  let mockContext: CommandContext;
  let mockResetChat: ReturnType<typeof vi.fn>;
  let mockStartNewSession: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockResetChat = vi.fn().mockResolvedValue(undefined);
    mockStartNewSession = vi.fn().mockReturnValue('new-session-id');
    vi.clearAllMocks();

    mockContext = createMockCommandContext({
      services: {
        config: {
          getGeminiClient: () =>
            ({
              resetChat: mockResetChat,
            }) as unknown as GeminiClient,
          startNewSession: mockStartNewSession,
        },
      },
      session: {
        startNewSession: vi.fn(),
      },
    });
  });

  it('should set debug message, start a new session, reset chat, and clear UI when config is available', async () => {
    if (!clearCommand.action) {
      throw new Error('clearCommand must have an action.');
    }

    await clearCommand.action(mockContext, '');

    expect(mockContext.ui.setDebugMessage).toHaveBeenCalledWith(
      'Starting a new session, resetting chat, and clearing terminal.',
    );
    expect(mockContext.ui.setDebugMessage).toHaveBeenCalledTimes(1);

    expect(mockStartNewSession).toHaveBeenCalledTimes(1);
    expect(mockContext.session.startNewSession).toHaveBeenCalledWith(
      'new-session-id',
    );
    expect(mockResetChat).toHaveBeenCalledTimes(1);
    expect(mockContext.ui.clear).toHaveBeenCalledTimes(1);

    // Check that all expected operations were called
    expect(mockContext.ui.setDebugMessage).toHaveBeenCalled();
    expect(mockStartNewSession).toHaveBeenCalled();
    expect(mockContext.session.startNewSession).toHaveBeenCalled();
    expect(mockResetChat).toHaveBeenCalled();
    expect(mockContext.ui.clear).toHaveBeenCalled();
  });

  it('should not attempt to reset chat if config service is not available', async () => {
    if (!clearCommand.action) {
      throw new Error('clearCommand must have an action.');
    }

    const nullConfigContext = createMockCommandContext({
      services: {
        config: null,
      },
      session: {
        startNewSession: vi.fn(),
      },
    });

    await clearCommand.action(nullConfigContext, '');

    expect(nullConfigContext.ui.setDebugMessage).toHaveBeenCalledWith(
      'Starting a new session and clearing.',
    );
    expect(mockResetChat).not.toHaveBeenCalled();
    expect(nullConfigContext.ui.clear).toHaveBeenCalledTimes(1);
  });
});
