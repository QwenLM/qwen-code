/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

const { mockListSessions, mockRemoveSession, mockSessionServiceConstructor } =
  vi.hoisted(() => ({
    mockListSessions: vi.fn(),
    mockRemoveSession: vi.fn(),
    mockSessionServiceConstructor: vi.fn(),
  }));

vi.mock('@qwen-code/qwen-code-core', async () => {
  const actual = await vi.importActual('@qwen-code/qwen-code-core');
  return {
    ...actual,
    SessionService: vi.fn().mockImplementation((cwd: string) => {
      mockSessionServiceConstructor(cwd);
      return {
        listSessions: mockListSessions,
        removeSession: mockRemoveSession,
      };
    }),
  };
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { historyCommand } from './historyCommand.js';
import { createMockCommandContext } from '../../test-utils/mockCommandContext.js';
import type { CommandContext } from './types.js';

describe('historyCommand', () => {
  let mockContext: CommandContext;

  beforeEach(() => {
    vi.clearAllMocks();
    mockListSessions.mockResolvedValue({
      items: [],
      hasMore: false,
      nextCursor: undefined,
    });
    mockRemoveSession.mockResolvedValue(true);

    mockContext = createMockCommandContext({
      services: {
        config: {
          getWorkingDir: () => '/repo',
          getProjectRoot: () => '/repo',
          getSessionId: () => 'current-session',
        },
      },
    });
  });

  it('lists saved chat history by default', async () => {
    mockListSessions.mockResolvedValue({
      items: [
        {
          sessionId: 'current-session',
          cwd: '/repo',
          startTime: '2026-04-14T00:00:00.000Z',
          mtime: 1,
          prompt: 'Current prompt',
          gitBranch: 'main',
          filePath: '/repo/.qwen/chats/current-session.jsonl',
          messageCount: 3,
        },
        {
          sessionId: 'older-session',
          cwd: '/repo',
          startTime: '2026-04-13T00:00:00.000Z',
          mtime: 2,
          prompt: 'Older prompt',
          gitBranch: undefined,
          filePath: '/repo/.qwen/chats/older-session.jsonl',
          messageCount: 1,
        },
      ],
      hasMore: false,
      nextCursor: undefined,
    });

    const result = await historyCommand.action?.(mockContext, '');

    expect(mockSessionServiceConstructor).toHaveBeenCalledWith('/repo');
    expect(mockListSessions).toHaveBeenCalledWith({
      size: 100,
      cursor: undefined,
    });
    expect(result).toEqual({
      type: 'message',
      messageType: 'info',
      content: expect.stringContaining('Saved chat history for this project:'),
    });
    expect(result?.type).toBe('message');
    if (result?.type === 'message') {
      expect(result.content).toContain('current-session (current)');
      expect(result.content).toContain('Older prompt');
    }
  });

  it('returns a helpful message when no saved history exists', async () => {
    const result = await historyCommand.action?.(mockContext, '');

    expect(result).toEqual({
      type: 'message',
      messageType: 'info',
      content: 'No saved chat history found for this project.',
    });
  });

  it('returns usage information when clear is missing arguments', async () => {
    const clearCommand = historyCommand.subCommands?.find(
      (command) => command.name === 'clear',
    );

    const result = await clearCommand?.action?.(mockContext, '');

    expect(result).toEqual({
      type: 'message',
      messageType: 'error',
      content: 'Usage: /history clear <session-id> or /history clear --all',
    });
  });

  it('deletes a specific inactive session by id', async () => {
    const clearCommand = historyCommand.subCommands?.find(
      (command) => command.name === 'clear',
    );

    const result = await clearCommand?.action?.(mockContext, 'older-session');

    expect(mockRemoveSession).toHaveBeenCalledWith('older-session');
    expect(result).toEqual({
      type: 'message',
      messageType: 'info',
      content: 'Deleted saved chat history for session older-session.',
    });
  });

  it('refuses to delete the active session history', async () => {
    const clearCommand = historyCommand.subCommands?.find(
      (command) => command.name === 'clear',
    );

    const result = await clearCommand?.action?.(mockContext, 'current-session');

    expect(mockRemoveSession).not.toHaveBeenCalled();
    expect(result).toEqual({
      type: 'message',
      messageType: 'error',
      content:
        'Cannot delete the active session history while this session is running. Start a new session first, then delete it by ID.',
    });
  });

  it('deletes all inactive sessions and leaves the active session untouched', async () => {
    mockListSessions
      .mockResolvedValueOnce({
        items: [
          {
            sessionId: 'current-session',
            cwd: '/repo',
            startTime: '2026-04-14T00:00:00.000Z',
            mtime: 3,
            prompt: 'Current prompt',
            gitBranch: 'main',
            filePath: '/repo/.qwen/chats/current-session.jsonl',
            messageCount: 3,
          },
          {
            sessionId: 'older-session',
            cwd: '/repo',
            startTime: '2026-04-13T00:00:00.000Z',
            mtime: 2,
            prompt: 'Older prompt',
            gitBranch: undefined,
            filePath: '/repo/.qwen/chats/older-session.jsonl',
            messageCount: 1,
          },
        ],
        hasMore: true,
        nextCursor: 2,
      })
      .mockResolvedValueOnce({
        items: [
          {
            sessionId: 'oldest-session',
            cwd: '/repo',
            startTime: '2026-04-12T00:00:00.000Z',
            mtime: 1,
            prompt: 'Oldest prompt',
            gitBranch: undefined,
            filePath: '/repo/.qwen/chats/oldest-session.jsonl',
            messageCount: 2,
          },
        ],
        hasMore: false,
        nextCursor: undefined,
      });

    const clearCommand = historyCommand.subCommands?.find(
      (command) => command.name === 'clear',
    );
    const result = await clearCommand?.action?.(mockContext, '--all');

    expect(mockListSessions).toHaveBeenNthCalledWith(1, {
      size: 100,
      cursor: undefined,
    });
    expect(mockListSessions).toHaveBeenNthCalledWith(2, {
      size: 100,
      cursor: 2,
    });
    expect(mockRemoveSession).toHaveBeenCalledTimes(2);
    expect(mockRemoveSession).toHaveBeenNthCalledWith(1, 'older-session');
    expect(mockRemoveSession).toHaveBeenNthCalledWith(2, 'oldest-session');
    expect(result).toEqual({
      type: 'message',
      messageType: 'info',
      content:
        'Deleted 2 saved chat history session(s) for this project. The active session was left untouched.',
    });
  });
});
