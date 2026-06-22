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

  it('exposes an argumentHint covering --auto and <name>', () => {
    // The completion menu reads argumentHint when the user types
    // `/rename` and hovers — this is the primary discoverability
    // affordance, so pin its shape.
    expect(renameCommand.argumentHint).toBe('[--auto] [<name>]');
  });

  describe('completion', () => {
    const run = (partial: string) =>
      renameCommand.completion!(mockContext, partial);

    it('returns null when the partial argument is empty', async () => {
      // Match /model's contract: don't pop the menu for free-text titles.
      // The user opting into a name shouldn't be shadowed by the lone
      // --auto suggestion.
      expect(await run('')).toBeNull();
      expect(await run('   ')).toBeNull();
    });

    it('suggests --auto when the partial argument is a prefix of it', async () => {
      // Covers the discovery path: typing `--`, `--a`, `--au`, `--auto`
      // all match — same shape as /model's --fast handling.
      for (const partial of ['-', '--', '--a', '--au', '--auto']) {
        const result = await run(partial);
        expect(result).toEqual([
          {
            value: '--auto',
            description: expect.stringContaining('fast model'),
          },
        ]);
      }
    });

    it('returns null when the partial argument is a free-text name', async () => {
      // Anything that isn't a prefix of --auto is treated as the user
      // typing the title itself; we don't want to offer --auto in that
      // case (would feel like noise on `/rename my-feature`).
      expect(await run('my-feature')).toBeNull();
      expect(await run('fix bug')).toBeNull();
      expect(await run('-x')).toBeNull(); // not a --auto prefix
    });
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
    // Bare `/rename` now shares the `tryGenerateSessionTitle` pipeline with
    // `--auto`, so an empty-history failure is surfaced via the same
    // discriminated outcome.
    tryGenerateSessionTitleMock.mockResolvedValue({
      ok: false,
      reason: 'empty_history',
    });
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
      content:
        'No conversation to title yet — send at least one message first.',
    });
    expect(tryGenerateSessionTitleMock).toHaveBeenCalledOnce();
  });

  it('should return error when only whitespace is provided and auto-generate fails', async () => {
    tryGenerateSessionTitleMock.mockResolvedValue({
      ok: false,
      reason: 'empty_history',
    });
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
      content:
        'No conversation to title yet — send at least one message first.',
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

  describe('bare /rename pipeline', () => {
    // Pins the unified-pipeline contract: bare `/rename` (no args) goes
    // through the same fast-model `tryGenerateSessionTitle` pipeline as
    // `--auto`, with no semantic divergence. Source is always 'auto' when
    // the LLM produced it.
    it('routes through tryGenerateSessionTitle on bare /rename', async () => {
      tryGenerateSessionTitleMock.mockResolvedValue({
        ok: true,
        title: 'Fix login bug',
        modelUsed: 'qwen-turbo',
      });
      const mockConfig = {
        getChatRecordingService: vi.fn().mockReturnValue({
          recordCustomTitle: vi.fn().mockReturnValue(true),
        }),
      };
      mockContext = createMockCommandContext({
        services: { config: mockConfig as never },
      });

      await renameCommand.action!(mockContext, '');

      expect(tryGenerateSessionTitleMock).toHaveBeenCalledOnce();
    });

    it('records bare /rename success as auto-sourced', async () => {
      // The LLM produced the title, not the user — picker should be able
      // to dim it the same way it dims --auto results.
      tryGenerateSessionTitleMock.mockResolvedValue({
        ok: true,
        title: 'Refactor auth middleware',
        modelUsed: 'qwen-turbo',
      });
      const mockRecordCustomTitle = vi.fn().mockReturnValue(true);
      const mockConfig = {
        getChatRecordingService: vi.fn().mockReturnValue({
          recordCustomTitle: mockRecordCustomTitle,
        }),
      };
      mockContext = createMockCommandContext({
        services: { config: mockConfig as never },
      });

      await renameCommand.action!(mockContext, '');

      expect(mockRecordCustomTitle).toHaveBeenCalledWith(
        'Refactor auth middleware',
        'auto',
      );
    });

    it('surfaces no_fast_model on bare /rename when fast model is unset', async () => {
      // Both bare /rename and --auto now hard-require a fast model — the
      // failure reason flows out via the discriminated outcome rather
      // than a pre-flight check, so the user sees a single consistent
      // message regardless of which form they typed.
      tryGenerateSessionTitleMock.mockResolvedValue({
        ok: false,
        reason: 'no_fast_model',
      });
      const mockConfig = {
        getChatRecordingService: vi.fn().mockReturnValue({
          recordCustomTitle: vi.fn(),
        }),
      };
      mockContext = createMockCommandContext({
        services: { config: mockConfig as never },
      });

      const result = await renameCommand.action!(mockContext, '');

      expect(result).toMatchObject({ messageType: 'error' });
      expect((result as { content: string }).content).toMatch(
        /requires a fast model/,
      );
    });
  });

  describe('--auto flag', () => {
    it('surfaces no_fast_model on --auto via the shared pipeline', async () => {
      // Pre-flight `getFastModel()` check was removed in the unification —
      // both bare /rename and --auto now rely on tryGenerateSessionTitle
      // to return the `no_fast_model` reason, which keeps the failure
      // mode in one place.
      tryGenerateSessionTitleMock.mockResolvedValue({
        ok: false,
        reason: 'no_fast_model',
      });
      const mockConfig = {
        getChatRecordingService: vi.fn().mockReturnValue({
          recordCustomTitle: vi.fn(),
        }),
      };
      mockContext = createMockCommandContext({
        services: { config: mockConfig as never },
      });

      const result = await renameCommand.action!(mockContext, '--auto');

      expect(result).toMatchObject({ messageType: 'error' });
      expect((result as { content: string }).content).toMatch(
        /requires a fast model/,
      );
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
        /rate limit, auth, network error, or unexpected response format/,
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
