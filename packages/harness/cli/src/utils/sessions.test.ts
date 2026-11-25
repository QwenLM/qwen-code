/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Config } from '@qwen-code/core';
import { listSessions, deleteSession } from './sessions.js';
import {
  SessionError,
  SessionSelector,
  type SessionInfo,
} from './sessionUtils.js';

const mocks = vi.hoisted(() => ({
  writeToStdout: vi.fn(),
  writeToStderr: vi.fn(),
  releasePersistedWorktreeOwnerHandoff: vi.fn(),
  releasePersistedWorktreeSessionOwnership: vi.fn(),
}));

// Mock the SessionSelector and transcript store deletion.
vi.mock('./sessionUtils.js', async () => {
  const actual =
    await vi.importActual<typeof import('./sessionUtils.js')>(
      './sessionUtils.js',
    );
  return {
    SessionSelector: vi.fn(),
    SessionError: actual.SessionError,
    formatRelativeTime: vi.fn(() => 'some time ago'),
  };
});

vi.mock('@qwen-code/core', async () => {
  const actual = await vi.importActual('@qwen-code/core');
  return {
    ...actual,
    writeToStdout: mocks.writeToStdout,
    writeToStderr: mocks.writeToStderr,
    releasePersistedWorktreeOwnerHandoff:
      mocks.releasePersistedWorktreeOwnerHandoff,
    releasePersistedWorktreeSessionOwnership:
      mocks.releasePersistedWorktreeSessionOwnership,
  };
});

describe('listSessions', () => {
  let mockConfig: Config;
  let mockListSessions: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    // Create mock config
    mockConfig = {
      storage: {
        getProjectTempDir: vi.fn().mockReturnValue('/tmp/test-project'),
      },
      getSessionId: vi.fn().mockReturnValue('current-session-id'),
    } as unknown as Config;

    // Create mock listSessions method
    mockListSessions = vi.fn();

    // Mock SessionSelector constructor to return object with listSessions method
    vi.mocked(SessionSelector).mockImplementation(
      () =>
        ({
          listSessions: mockListSessions,
        }) as unknown as InstanceType<typeof SessionSelector>,
    );
  });

  afterEach(() => {
    vi.clearAllMocks();
    mocks.writeToStdout.mockClear();
    mocks.writeToStderr.mockClear();
  });

  it('should display message when no previous sessions were found', async () => {
    // Arrange: Return empty array from listSessions
    mockListSessions.mockResolvedValue([]);

    // Act
    await listSessions(mockConfig);

    // Assert
    expect(mockListSessions).toHaveBeenCalledOnce();
    expect(mocks.writeToStdout).toHaveBeenCalledWith(
      'No previous sessions found for this project.',
    );
  });

  it('should list sessions when sessions are found', async () => {
    // Arrange: Create test sessions
    const now = new Date('2025-01-20T12:00:00.000Z');
    const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
    const twoDaysAgo = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000);

    const mockSessions: SessionInfo[] = [
      {
        id: 'session-1',
        file: 'session-2025-01-18T12-00-00-session-1',
        fileName: 'session-2025-01-18T12-00-00-session-1.jsonl',
        startTime: twoDaysAgo.toISOString(),
        lastUpdated: twoDaysAgo.toISOString(),
        messageCount: 5,
        displayName: 'First user message',
        firstUserMessage: 'First user message',
        isCurrentSession: false,
        index: 1,
      },
      {
        id: 'session-2',
        file: 'session-2025-01-20T11-00-00-session-2',
        fileName: 'session-2025-01-20T11-00-00-session-2.jsonl',
        startTime: oneHourAgo.toISOString(),
        lastUpdated: oneHourAgo.toISOString(),
        messageCount: 10,
        displayName: 'Second user message',
        firstUserMessage: 'Second user message',
        isCurrentSession: false,
        index: 2,
      },
      {
        id: 'current-session-id',
        file: 'session-2025-01-20T12-00-00-current-s',
        fileName: 'session-2025-01-20T12-00-00-current-s.jsonl',
        startTime: now.toISOString(),
        lastUpdated: now.toISOString(),
        messageCount: 3,
        displayName: 'Current session',
        firstUserMessage: 'Current session',
        isCurrentSession: true,
        index: 3,
      },
    ];

    mockListSessions.mockResolvedValue(mockSessions);

    // Act
    await listSessions(mockConfig);

    // Assert
    expect(mockListSessions).toHaveBeenCalledOnce();

    // Check that the header was displayed
    expect(mocks.writeToStdout).toHaveBeenCalledWith(
      '\nAvailable sessions for this project (3):\n',
    );

    // Check that each session was logged
    expect(mocks.writeToStdout).toHaveBeenCalledWith(
      expect.stringContaining('1. First user message'),
    );
    expect(mocks.writeToStdout).toHaveBeenCalledWith(
      expect.stringContaining('[session-1]'),
    );

    expect(mocks.writeToStdout).toHaveBeenCalledWith(
      expect.stringContaining('2. Second user message'),
    );
    expect(mocks.writeToStdout).toHaveBeenCalledWith(
      expect.stringContaining('[session-2]'),
    );

    expect(mocks.writeToStdout).toHaveBeenCalledWith(
      expect.stringContaining('3. Current session'),
    );
    expect(mocks.writeToStdout).toHaveBeenCalledWith(
      expect.stringContaining(', current)'),
    );
    expect(mocks.writeToStdout).toHaveBeenCalledWith(
      expect.stringContaining('[current-session-id]'),
    );
  });

  it('should preserve selector ordering by lastUpdated descending', async () => {
    // Arrange: Create sessions in non-display order
    const session1Time = new Date('2025-01-18T12:00:00.000Z');
    const session2Time = new Date('2025-01-19T12:00:00.000Z');
    const session3Time = new Date('2025-01-20T12:00:00.000Z');

    const mockSessions: SessionInfo[] = [
      {
        id: 'session-3',
        file: 'session-3',
        fileName: 'session-3.jsonl',
        startTime: session1Time.toISOString(), // Oldest created
        lastUpdated: session3Time.toISOString(), // Most recently updated
        messageCount: 5,
        displayName: 'Most recently updated',
        firstUserMessage: 'Most recently updated',
        isCurrentSession: false,
        index: 1,
      },
      {
        id: 'session-2',
        file: 'session-2',
        fileName: 'session-2.jsonl',
        startTime: session3Time.toISOString(), // Newest created
        lastUpdated: session2Time.toISOString(), // Middle updated
        messageCount: 5,
        displayName: 'Middle updated',
        firstUserMessage: 'Middle updated',
        isCurrentSession: false,
        index: 2,
      },
      {
        id: 'session-1',
        file: 'session-1',
        fileName: 'session-1.jsonl',
        startTime: session2Time.toISOString(), // Middle created
        lastUpdated: session1Time.toISOString(), // Least recently updated
        messageCount: 5,
        displayName: 'Least recently updated',
        firstUserMessage: 'Least recently updated',
        isCurrentSession: false,
        index: 3,
      },
    ];

    mockListSessions.mockResolvedValue(mockSessions);

    // Act
    await listSessions(mockConfig);

    // Assert
    // Get all the session log calls (skip the header)
    const sessionCalls = mocks.writeToStdout.mock.calls.filter(
      (call): call is [string] =>
        // eslint-disable-next-line eslint-js/no-restricted-syntax
        typeof call[0] === 'string' &&
        call[0].includes('[session-') &&
        !call[0].includes('Available sessions'),
    );

    // Verify they match selector order (latest updated first)
    expect(sessionCalls[0][0]).toContain('1. Most recently updated');
    expect(sessionCalls[1][0]).toContain('2. Middle updated');
    expect(sessionCalls[2][0]).toContain('3. Least recently updated');
  });

  it('should format session output with relative time and session ID', async () => {
    // Arrange
    const now = new Date('2025-01-20T12:00:00.000Z');
    const mockSessions: SessionInfo[] = [
      {
        id: 'abc123def456',
        file: 'session-file',
        fileName: 'session-file.jsonl',
        startTime: now.toISOString(),
        lastUpdated: now.toISOString(),
        messageCount: 5,
        displayName: 'Test message',
        firstUserMessage: 'Test message',
        isCurrentSession: false,
        index: 1,
      },
    ];

    mockListSessions.mockResolvedValue(mockSessions);

    // Act
    await listSessions(mockConfig);

    // Assert
    expect(mocks.writeToStdout).toHaveBeenCalledWith(
      expect.stringContaining('1. Test message'),
    );
    expect(mocks.writeToStdout).toHaveBeenCalledWith(
      expect.stringContaining('some time ago'),
    );
    expect(mocks.writeToStdout).toHaveBeenCalledWith(
      expect.stringContaining('[abc123def456]'),
    );
  });

  it('should handle single session', async () => {
    // Arrange
    const now = new Date('2025-01-20T12:00:00.000Z');
    const mockSessions: SessionInfo[] = [
      {
        id: 'single-session',
        file: 'session-file',
        fileName: 'session-file.jsonl',
        startTime: now.toISOString(),
        lastUpdated: now.toISOString(),
        messageCount: 5,
        displayName: 'Only session',
        firstUserMessage: 'Only session',
        isCurrentSession: true,
        index: 1,
      },
    ];

    mockListSessions.mockResolvedValue(mockSessions);

    // Act
    await listSessions(mockConfig);

    // Assert
    expect(mocks.writeToStdout).toHaveBeenCalledWith(
      '\nAvailable sessions for this project (1):\n',
    );
    expect(mocks.writeToStdout).toHaveBeenCalledWith(
      expect.stringContaining('1. Only session'),
    );
    expect(mocks.writeToStdout).toHaveBeenCalledWith(
      expect.stringContaining(', current)'),
    );
  });

  it('should display summary as title when available instead of first user message', async () => {
    // Arrange
    const now = new Date('2025-01-20T12:00:00.000Z');
    const mockSessions: SessionInfo[] = [
      {
        id: 'session-with-summary',
        file: 'session-file',
        fileName: 'session-file.jsonl',
        startTime: now.toISOString(),
        lastUpdated: now.toISOString(),
        messageCount: 10,
        displayName: 'Add dark mode to the app', // Summary
        firstUserMessage:
          'How do I add dark mode to my React application with CSS variables?',
        isCurrentSession: false,
        index: 1,
        summary: 'Add dark mode to the app',
      },
    ];

    mockListSessions.mockResolvedValue(mockSessions);

    // Act
    await listSessions(mockConfig);

    // Assert: Should show the summary (displayName), not the first user message
    expect(mocks.writeToStdout).toHaveBeenCalledWith(
      expect.stringContaining('1. Add dark mode to the app'),
    );
    expect(mocks.writeToStdout).not.toHaveBeenCalledWith(
      expect.stringContaining('How do I add dark mode to my React application'),
    );
  });
});

describe('deleteSession', () => {
  let mockConfig: Config;
  let mockFindSession: ReturnType<typeof vi.fn>;
  let mockDeleteTranscript: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    // Create mock config
    mockDeleteTranscript = vi.fn();
    mockConfig = {
      storage: {
        getProjectTempDir: vi.fn().mockReturnValue('/tmp/test-project'),
      },
      getSessionId: vi.fn().mockReturnValue('current-session-id'),
      getTranscriptStore: vi.fn().mockReturnValue({
        deleteTranscript: mockDeleteTranscript,
      }),
      getSessionArtifactProjectRoot: vi
        .fn()
        .mockReturnValue('/tmp/test-project'),
    } as unknown as Config;

    // Create mock methods
    mockFindSession = vi.fn();

    // Mock SessionSelector constructor
    vi.mocked(SessionSelector).mockImplementation(
      () =>
        ({
          findSession: mockFindSession,
        }) as unknown as InstanceType<typeof SessionSelector>,
    );
  });

  afterEach(() => {
    vi.clearAllMocks();
    mocks.releasePersistedWorktreeOwnerHandoff.mockReset();
    mocks.releasePersistedWorktreeSessionOwnership.mockReset();
  });

  it('should display error when no sessions are found', async () => {
    // Arrange
    mockFindSession.mockRejectedValue(SessionError.noSessionsFound());

    // Act
    await deleteSession(mockConfig, '1');

    // Assert
    expect(mockFindSession).toHaveBeenCalledWith('1');
    expect(mocks.writeToStderr).toHaveBeenCalledWith(
      'No previous sessions found for this project.',
    );
    expect(mockDeleteTranscript).not.toHaveBeenCalled();
  });

  it('should delete session by UUID', async () => {
    // Arrange
    const now = new Date('2025-01-20T12:00:00.000Z');
    const session: SessionInfo = {
      id: 'session-uuid-123',
      file: 'session-file-123',
      fileName: 'session-file-123.jsonl',
      sessionPath: '/tmp/session-file-123.jsonl',
      startTime: now.toISOString(),
      lastUpdated: now.toISOString(),
      messageCount: 5,
      displayName: 'Test session',
      firstUserMessage: 'Test session',
      isCurrentSession: false,
      index: 1,
    };

    mockFindSession.mockResolvedValue(session);
    mockDeleteTranscript.mockResolvedValue(undefined);

    // Act
    await deleteSession(mockConfig, 'session-uuid-123');

    // Assert
    expect(mockFindSession).toHaveBeenCalledWith('session-uuid-123');
    expect(mockDeleteTranscript).toHaveBeenCalledWith(
      '/tmp/session-file-123.jsonl',
    );
    expect(mocks.writeToStdout).toHaveBeenCalledWith(
      'Deleted session 1: Test session (some time ago)',
    );
    expect(mocks.writeToStderr).not.toHaveBeenCalled();
  });

  it('keeps a handoff transcript when owner release cannot be completed', async () => {
    const now = new Date('2025-01-20T12:00:00.000Z');
    const worktreeSession = {
      sessionId: 'session-with-handoff',
      worktreePath: '/tmp/worktree-b',
      worktreeName: 'worktree-b',
      originalCwd: '/tmp/project',
      lifecycle: 'attached',
      pendingOwnerReleasePath: '/tmp/worktree-a',
    } as NonNullable<SessionInfo['worktreeSession']>;
    const session: SessionInfo = {
      id: 'session-with-handoff',
      file: 'session-with-handoff',
      fileName: 'session-with-handoff.jsonl',
      sessionPath: '/tmp/session-with-handoff.jsonl',
      startTime: now.toISOString(),
      lastUpdated: now.toISOString(),
      messageCount: 1,
      displayName: 'Handoff session',
      firstUserMessage: 'Handoff session',
      isCurrentSession: false,
      index: 1,
      worktreeSession,
    };
    mockFindSession.mockResolvedValue(session);
    mocks.releasePersistedWorktreeSessionOwnership.mockRejectedValue(
      new Error('owner handoff unavailable'),
    );

    await deleteSession(mockConfig, 'session-with-handoff');

    expect(mocks.releasePersistedWorktreeSessionOwnership).toHaveBeenCalledWith(
      worktreeSession,
      'session-with-handoff',
    );
    expect(mockDeleteTranscript).not.toHaveBeenCalled();
    expect(mocks.writeToStderr).toHaveBeenCalledWith(
      'Failed to delete session: owner handoff unavailable',
    );
  });

  it('settles a current worktree owner before deleting its transcript', async () => {
    const now = new Date('2025-01-20T12:00:00.000Z');
    const worktreeSession = {
      sessionId: 'owner-session',
      worktreePath: '/tmp/worktree',
      worktreeName: 'worktree',
      originalCwd: '/tmp/project',
      lifecycle: 'owner',
    } as NonNullable<SessionInfo['worktreeSession']>;
    const session: SessionInfo = {
      id: 'owner-session',
      file: 'owner-session',
      fileName: 'owner-session.jsonl',
      sessionPath: '/tmp/owner-session.jsonl',
      startTime: now.toISOString(),
      lastUpdated: now.toISOString(),
      messageCount: 1,
      displayName: 'Owner session',
      firstUserMessage: 'Owner session',
      isCurrentSession: false,
      index: 1,
      worktreeSession,
    };
    mockFindSession.mockResolvedValue(session);

    await deleteSession(mockConfig, 'owner-session');

    expect(
      mocks.releasePersistedWorktreeSessionOwnership,
    ).toHaveBeenCalledWith(worktreeSession, 'owner-session');
    expect(mockDeleteTranscript).toHaveBeenCalledWith('/tmp/owner-session.jsonl');
  });

  it('should delete session by index', async () => {
    // Arrange
    const now = new Date('2025-01-20T12:00:00.000Z');
    const session: SessionInfo = {
      id: 'session-2',
      file: 'session-file-2',
      fileName: 'session-file-2.jsonl',
      sessionPath: '/tmp/session-file-2.jsonl',
      startTime: now.toISOString(),
      lastUpdated: now.toISOString(),
      messageCount: 10,
      displayName: 'Second session',
      firstUserMessage: 'Second session',
      isCurrentSession: false,
      index: 2,
    };

    mockFindSession.mockResolvedValue(session);
    mockDeleteTranscript.mockResolvedValue(undefined);

    // Act
    await deleteSession(mockConfig, '2');

    // Assert
    expect(mockFindSession).toHaveBeenCalledWith('2');
    expect(mockDeleteTranscript).toHaveBeenCalledWith(
      '/tmp/session-file-2.jsonl',
    );
    expect(mocks.writeToStdout).toHaveBeenCalledWith(
      'Deleted session 2: Second session (some time ago)',
    );
  });

  it('should display error for invalid session identifier (non-numeric)', async () => {
    // Arrange
    mockFindSession.mockRejectedValue(
      SessionError.invalidSessionIdentifier('invalid-id'),
    );

    // Act
    await deleteSession(mockConfig, 'invalid-id');

    // Assert
    expect(mocks.writeToStderr).toHaveBeenCalledWith(
      expect.stringContaining('Invalid session identifier "invalid-id"'),
    );
    expect(mockDeleteTranscript).not.toHaveBeenCalled();
  });

  it('should display error for invalid session identifier (out of range)', async () => {
    // Arrange
    mockFindSession.mockRejectedValue(
      SessionError.invalidSessionIdentifier('999'),
    );

    // Act
    await deleteSession(mockConfig, '999');

    // Assert
    expect(mocks.writeToStderr).toHaveBeenCalledWith(
      expect.stringContaining('Invalid session identifier "999"'),
    );
    expect(mockDeleteTranscript).not.toHaveBeenCalled();
  });

  it('should display error for invalid session identifier (zero)', async () => {
    // Arrange
    mockFindSession.mockRejectedValue(
      SessionError.invalidSessionIdentifier('0'),
    );

    // Act
    await deleteSession(mockConfig, '0');

    // Assert
    expect(mocks.writeToStderr).toHaveBeenCalledWith(
      expect.stringContaining('Invalid session identifier "0"'),
    );
    expect(mockDeleteTranscript).not.toHaveBeenCalled();
  });

  it('should prevent deletion of current session', async () => {
    // Arrange
    const now = new Date('2025-01-20T12:00:00.000Z');
    const session: SessionInfo = {
      id: 'current-session-id',
      file: 'current-session-file',
      fileName: 'current-session-file.jsonl',
      sessionPath: '/tmp/current-session-file.jsonl',
      startTime: now.toISOString(),
      lastUpdated: now.toISOString(),
      messageCount: 5,
      displayName: 'Current session',
      firstUserMessage: 'Current session',
      isCurrentSession: true,
      index: 1,
    };

    mockFindSession.mockResolvedValue(session);

    // Act - try to delete by index
    await deleteSession(mockConfig, '1');

    // Assert
    expect(mocks.writeToStderr).toHaveBeenCalledWith(
      'Cannot delete the current active session.',
    );
    expect(mockDeleteTranscript).not.toHaveBeenCalled();
  });

  it('should prevent deletion of current session by UUID', async () => {
    // Arrange
    const now = new Date('2025-01-20T12:00:00.000Z');
    const session: SessionInfo = {
      id: 'current-session-id',
      file: 'current-session-file',
      fileName: 'current-session-file.jsonl',
      sessionPath: '/tmp/current-session-file.jsonl',
      startTime: now.toISOString(),
      lastUpdated: now.toISOString(),
      messageCount: 5,
      displayName: 'Current session',
      firstUserMessage: 'Current session',
      isCurrentSession: true,
      index: 1,
    };

    mockFindSession.mockResolvedValue(session);

    // Act - try to delete by UUID
    await deleteSession(mockConfig, 'current-session-id');

    // Assert
    expect(mocks.writeToStderr).toHaveBeenCalledWith(
      'Cannot delete the current active session.',
    );
    expect(mockDeleteTranscript).not.toHaveBeenCalled();
  });

  it('should handle deletion errors gracefully', async () => {
    // Arrange
    const now = new Date('2025-01-20T12:00:00.000Z');
    const session: SessionInfo = {
      id: 'session-1',
      file: 'session-file-1',
      fileName: 'session-file-1.jsonl',
      sessionPath: '/tmp/session-file-1.jsonl',
      startTime: now.toISOString(),
      lastUpdated: now.toISOString(),
      messageCount: 5,
      displayName: 'Test session',
      firstUserMessage: 'Test session',
      isCurrentSession: false,
      index: 1,
    };

    mockFindSession.mockResolvedValue(session);
    mockDeleteTranscript.mockRejectedValue(new Error('File deletion failed'));

    // Act
    await deleteSession(mockConfig, '1');

    // Assert
    expect(mockDeleteTranscript).toHaveBeenCalledWith(
      '/tmp/session-file-1.jsonl',
    );
    expect(mocks.writeToStderr).toHaveBeenCalledWith(
      'Failed to delete session: File deletion failed',
    );
  });

  it('should handle non-Error deletion failures', async () => {
    // Arrange
    const now = new Date('2025-01-20T12:00:00.000Z');
    const session: SessionInfo = {
      id: 'session-1',
      file: 'session-file-1',
      fileName: 'session-file-1.jsonl',
      sessionPath: '/tmp/session-file-1.jsonl',
      startTime: now.toISOString(),
      lastUpdated: now.toISOString(),
      messageCount: 5,
      displayName: 'Test session',
      firstUserMessage: 'Test session',
      isCurrentSession: false,
      index: 1,
    };

    mockFindSession.mockResolvedValue(session);
    mockDeleteTranscript.mockImplementation(() => {
      // eslint-disable-next-line eslint-js/no-restricted-syntax
      throw 'Unknown error type';
    });

    // Act
    await deleteSession(mockConfig, '1');

    // Assert
    expect(mocks.writeToStderr).toHaveBeenCalledWith(
      'Failed to delete session: Unknown error',
    );
  });

  it('should delegate to findSession for index resolution', async () => {
    // Arrange
    const now = new Date('2025-01-20T12:00:00.000Z');
    const session: SessionInfo = {
      id: 'session-3',
      file: 'session-file-3',
      fileName: 'session-file-3.jsonl',
      sessionPath: '/tmp/session-file-3.jsonl',
      startTime: now.toISOString(),
      lastUpdated: now.toISOString(),
      messageCount: 5,
      displayName: 'Most recently updated',
      firstUserMessage: 'Most recently updated',
      isCurrentSession: false,
      index: 1,
    };

    mockFindSession.mockResolvedValue(session);
    mockDeleteTranscript.mockResolvedValue(undefined);

    // Act - delete index 1
    await deleteSession(mockConfig, '1');

    // Assert - findSession handles the resolution
    expect(mockFindSession).toHaveBeenCalledWith('1');
    expect(mockDeleteTranscript).toHaveBeenCalledWith(
      '/tmp/session-file-3.jsonl',
    );
    expect(mocks.writeToStdout).toHaveBeenCalledWith(
      expect.stringContaining('Most recently updated'),
    );
  });
});
