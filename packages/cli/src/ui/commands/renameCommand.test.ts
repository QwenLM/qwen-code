/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renameCommand } from './renameCommand.js';
import { type CommandContext } from './types.js';
import { createMockCommandContext } from '../../test-utils/mockCommandContext.js';

const tryGenerateSessionTitleMock = vi.fn();

vi.mock('@qwen-code/qwen-code-core', async (importOriginal) => {
  const original =
    (await importOriginal()) as typeof import('@qwen-code/qwen-code-core');
  return {
    ...original,
    tryGenerateSessionTitle: (...args: unknown[]) =>
      tryGenerateSessionTitleMock(...args),
  };
});

describe('renameCommand', () => {
  let mockContext: CommandContext;

  beforeEach(() => {
    mockContext = createMockCommandContext();
    tryGenerateSessionTitleMock.mockReset();
  });

  it('should have the correct name and description', () => {
    expect(renameCommand.name).toBe('rename');
    expect(renameCommand.description).toBe(
      'Rename the current conversation. --auto lets the fast model pick a title.',
    );
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

  it('should return error when no name is provided and auto-generate fails', async () => {
    const mockConfig = {
      getChatRecordingService: vi.fn().mockReturnValue(undefined),
      getSessionId: vi.fn().mockReturnValue('test-session-id'),
      getSessionService: vi.fn().mockReturnValue({
        renameSession: vi.fn().mockResolvedValue(true),
      }),
      getGeminiClient: vi.fn().mockReturnValue({
        getHistory: vi.fn().mockReturnValue([]),
      }),
      getContentGenerator: vi.fn(),
      getModel: vi.fn(),
    };
    mockContext = createMockCommandContext({
      services: { config: mockConfig as never },
    });

    const result = await renameCommand.action!(mockContext, '');

    expect(result).toEqual({
      type: 'message',
      messageType: 'error',
      content: 'Could not generate a title. Usage: /rename <name>',
    });
  });

  it('should return error when only whitespace is provided and auto-generate fails', async () => {
    const mockConfig = {
      getChatRecordingService: vi.fn().mockReturnValue(undefined),
      getSessionId: vi.fn().mockReturnValue('test-session-id'),
      getSessionService: vi.fn().mockReturnValue({
        renameSession: vi.fn().mockResolvedValue(true),
      }),
      getGeminiClient: vi.fn().mockReturnValue({
        getHistory: vi.fn().mockReturnValue([]),
      }),
      getContentGenerator: vi.fn(),
      getModel: vi.fn(),
    };
    mockContext = createMockCommandContext({
      services: { config: mockConfig as never },
    });

    const result = await renameCommand.action!(mockContext, '   ');

    expect(result).toEqual({
      type: 'message',
      messageType: 'error',
      content: 'Could not generate a title. Usage: /rename <name>',
    });
  });

  it('should rename via ChatRecordingService when available', async () => {
    const mockRecordCustomTitle = vi.fn().mockReturnValue(true);
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

    expect(mockRecordCustomTitle).toHaveBeenCalledWith('my-feature', 'manual');
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
      'manual',
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

  describe('--auto flag', () => {
    it('refuses --auto when no fast model is configured', async () => {
      const mockConfig = {
        getChatRecordingService: vi.fn().mockReturnValue({
          recordCustomTitle: vi.fn(),
        }),
        getFastModel: vi.fn().mockReturnValue(undefined),
      };
      mockContext = createMockCommandContext({
        services: { config: mockConfig as never },
      });

      const result = await renameCommand.action!(mockContext, '--auto');

      expect(result).toEqual({
        type: 'message',
        messageType: 'error',
        content:
          '/rename --auto requires a fast model. Configure one with `/model --fast <model>`.',
      });
      expect(tryGenerateSessionTitleMock).not.toHaveBeenCalled();
    });

    it('refuses --auto combined with a positional name', async () => {
      const mockConfig = {
        getChatRecordingService: vi.fn().mockReturnValue({
          recordCustomTitle: vi.fn(),
        }),
        getFastModel: vi.fn().mockReturnValue('qwen-turbo'),
      };
      mockContext = createMockCommandContext({
        services: { config: mockConfig as never },
      });

      const result = await renameCommand.action!(mockContext, '--auto my-name');

      expect(result).toEqual({
        type: 'message',
        messageType: 'error',
        content:
          '/rename --auto does not take a name. Use `/rename <name>` to set a name yourself.',
      });
      expect(tryGenerateSessionTitleMock).not.toHaveBeenCalled();
    });

    it('writes an auto-sourced title on --auto success', async () => {
      tryGenerateSessionTitleMock.mockResolvedValue({
        ok: true,
        title: 'Fix login button on mobile',
        modelUsed: 'qwen-turbo',
      });
      const mockRecordCustomTitle = vi.fn().mockReturnValue(true);
      const mockConfig = {
        getChatRecordingService: vi.fn().mockReturnValue({
          recordCustomTitle: mockRecordCustomTitle,
        }),
        getFastModel: vi.fn().mockReturnValue('qwen-turbo'),
      };
      mockContext = createMockCommandContext({
        services: { config: mockConfig as never },
      });

      const result = await renameCommand.action!(mockContext, '--auto');

      expect(tryGenerateSessionTitleMock).toHaveBeenCalledOnce();
      expect(mockRecordCustomTitle).toHaveBeenCalledWith(
        'Fix login button on mobile',
        'auto',
      );
      expect(result).toEqual({
        type: 'message',
        messageType: 'info',
        content: 'Session renamed to "Fix login button on mobile"',
      });
    });

    it('surfaces empty_history reason with actionable hint', async () => {
      tryGenerateSessionTitleMock.mockResolvedValue({
        ok: false,
        reason: 'empty_history',
      });
      const mockConfig = {
        getChatRecordingService: vi.fn().mockReturnValue({
          recordCustomTitle: vi.fn(),
        }),
        getFastModel: vi.fn().mockReturnValue('qwen-turbo'),
      };
      mockContext = createMockCommandContext({
        services: { config: mockConfig as never },
      });

      const result = await renameCommand.action!(mockContext, '--auto');

      expect(result).toEqual({
        type: 'message',
        messageType: 'error',
        content:
          'No conversation to title yet — send at least one message first.',
      });
    });

    it('surfaces model_error reason distinctly', async () => {
      tryGenerateSessionTitleMock.mockResolvedValue({
        ok: false,
        reason: 'model_error',
      });
      const mockConfig = {
        getChatRecordingService: vi.fn().mockReturnValue({
          recordCustomTitle: vi.fn(),
        }),
        getFastModel: vi.fn().mockReturnValue('qwen-turbo'),
      };
      mockContext = createMockCommandContext({
        services: { config: mockConfig as never },
      });

      const result = await renameCommand.action!(mockContext, '--auto');

      expect(result).toMatchObject({
        messageType: 'error',
      });
      expect((result as { content: string }).content).toMatch(
        /rate limit, auth, or network error/,
      );
    });

    it('rejects unknown flag with sentinel hint', async () => {
      const mockConfig = {
        getChatRecordingService: vi.fn().mockReturnValue({
          recordCustomTitle: vi.fn(),
        }),
        getFastModel: vi.fn().mockReturnValue('qwen-turbo'),
      };
      mockContext = createMockCommandContext({
        services: { config: mockConfig as never },
      });

      const result = await renameCommand.action!(
        mockContext,
        '--my-label-with-dashes',
      );

      expect(result).toMatchObject({ messageType: 'error' });
      const content = (result as { content: string }).content;
      expect(content).toMatch(/Unknown flag "--my-label-with-dashes"/);
      expect(content).toMatch(/\/rename -- --my-label-with-dashes/);
      expect(tryGenerateSessionTitleMock).not.toHaveBeenCalled();
    });

    it('surfaces aborted reason when user cancels', async () => {
      tryGenerateSessionTitleMock.mockResolvedValue({
        ok: false,
        reason: 'aborted',
      });
      const mockConfig = {
        getChatRecordingService: vi.fn().mockReturnValue({
          recordCustomTitle: vi.fn(),
        }),
        getFastModel: vi.fn().mockReturnValue('qwen-turbo'),
      };
      mockContext = createMockCommandContext({
        services: { config: mockConfig as never },
      });

      const result = await renameCommand.action!(mockContext, '--auto');

      expect(result).toEqual({
        type: 'message',
        messageType: 'error',
        content: 'Title generation was cancelled.',
      });
    });

    it('falls back to SessionService.renameSession with auto source', async () => {
      tryGenerateSessionTitleMock.mockResolvedValue({
        ok: true,
        title: 'Audit auth middleware',
        modelUsed: 'qwen-turbo',
      });
      const mockRenameSession = vi.fn().mockResolvedValue(true);
      const mockConfig = {
        getChatRecordingService: vi.fn().mockReturnValue(undefined),
        getSessionId: vi.fn().mockReturnValue('test-session-id'),
        getSessionService: vi.fn().mockReturnValue({
          renameSession: mockRenameSession,
        }),
        getFastModel: vi.fn().mockReturnValue('qwen-turbo'),
      };
      mockContext = createMockCommandContext({
        services: { config: mockConfig as never },
      });

      const result = await renameCommand.action!(mockContext, '--auto');

      expect(mockRenameSession).toHaveBeenCalledWith(
        'test-session-id',
        'Audit auth middleware',
        'auto',
      );
      expect(result).toMatchObject({ messageType: 'info' });
    });
  });
});
