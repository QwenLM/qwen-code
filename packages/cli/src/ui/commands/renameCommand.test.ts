/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renameCommand } from './renameCommand.js';
import { type CommandContext } from './types.js';
import { createMockCommandContext } from '../../test-utils/mockCommandContext.js';

describe('renameCommand', () => {
  let mockContext: CommandContext;

  beforeEach(() => {
    mockContext = createMockCommandContext();
  });

  it('should have the correct name and description', () => {
    expect(renameCommand.name).toBe('rename');
    expect(renameCommand.description).toBe('Rename the current conversation');
  });

  it('should return error when config is not available', async () => {
    mockContext.services.config = null;

    const result = await renameCommand.action!(mockContext, 'my-feature');

    expect(result).toEqual({
      type: 'message',
      messageType: 'error',
      content: 'Config is not available.',
    });
  });

  it('should return error when no name is provided', async () => {
    const mockConfig = {
      getChatRecordingService: vi.fn().mockReturnValue(undefined),
      getSessionId: vi.fn().mockReturnValue('test-session-id'),
      getSessionService: vi.fn().mockReturnValue({
        renameSession: vi.fn().mockResolvedValue(true),
      }),
    };
    mockContext = createMockCommandContext({
      services: { config: mockConfig as never },
    });

    const result = await renameCommand.action!(mockContext, '');

    expect(result).toEqual({
      type: 'message',
      messageType: 'error',
      content: 'Please provide a name. Usage: /rename <name>',
    });
  });

  it('should return error when only whitespace is provided', async () => {
    const mockConfig = {
      getChatRecordingService: vi.fn().mockReturnValue(undefined),
      getSessionId: vi.fn().mockReturnValue('test-session-id'),
      getSessionService: vi.fn().mockReturnValue({
        renameSession: vi.fn().mockResolvedValue(true),
      }),
    };
    mockContext = createMockCommandContext({
      services: { config: mockConfig as never },
    });

    const result = await renameCommand.action!(mockContext, '   ');

    expect(result).toEqual({
      type: 'message',
      messageType: 'error',
      content: 'Please provide a name. Usage: /rename <name>',
    });
  });

  it('should rename via ChatRecordingService when available', async () => {
    const mockRecordCustomTitle = vi.fn();
    const mockConfig = {
      getChatRecordingService: vi.fn().mockReturnValue({
        recordCustomTitle: mockRecordCustomTitle,
      }),
      getSessionId: vi.fn().mockReturnValue('test-session-id'),
      getSessionService: vi.fn().mockReturnValue({
        renameSession: vi.fn().mockResolvedValue(true),
      }),
    };

    mockContext = createMockCommandContext({
      services: { config: mockConfig as never },
    });

    const result = await renameCommand.action!(mockContext, 'my-feature');

    expect(mockRecordCustomTitle).toHaveBeenCalledWith('my-feature');
    expect(result).toEqual({
      type: 'message',
      messageType: 'info',
      content: 'Session renamed to "my-feature"',
    });
  });

  it('should fall back to SessionService when ChatRecordingService is unavailable', async () => {
    const mockRenameSession = vi.fn().mockResolvedValue(true);
    const mockConfig = {
      getChatRecordingService: vi.fn().mockReturnValue(undefined),
      getSessionId: vi.fn().mockReturnValue('test-session-id'),
      getSessionService: vi.fn().mockReturnValue({
        renameSession: mockRenameSession,
      }),
    };

    mockContext = createMockCommandContext({
      services: { config: mockConfig as never },
    });

    const result = await renameCommand.action!(mockContext, 'my-feature');

    expect(mockRenameSession).toHaveBeenCalledWith(
      'test-session-id',
      'my-feature',
    );
    expect(result).toEqual({
      type: 'message',
      messageType: 'info',
      content: 'Session renamed to "my-feature"',
    });
  });

  it('should return error when SessionService fallback fails', async () => {
    const mockConfig = {
      getChatRecordingService: vi.fn().mockReturnValue(undefined),
      getSessionId: vi.fn().mockReturnValue('test-session-id'),
      getSessionService: vi.fn().mockReturnValue({
        renameSession: vi.fn().mockResolvedValue(false),
      }),
    };

    mockContext = createMockCommandContext({
      services: { config: mockConfig as never },
    });

    const result = await renameCommand.action!(mockContext, 'my-feature');

    expect(result).toEqual({
      type: 'message',
      messageType: 'error',
      content: 'Failed to rename session.',
    });
  });
});
