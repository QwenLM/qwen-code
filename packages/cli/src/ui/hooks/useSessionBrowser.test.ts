/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '../../test-utils/render.js';
import { act } from 'react';
import { useSessionBrowser } from './useSessionBrowser.js';
import {
  SessionSelector,
  SessionError,
  type SessionInfo,
  convertMessagesToHistoryFormats,
} from '../../utils/sessionUtils.js';
import {
  type Config,
  createUserMessage,
  createAssistantMessage,
  cloneUsage,
  ForkSessionService,
} from '@qwen-code/core';
import { coreEvents } from '@qwen-code/core';
import { applyWorktreeStartupRequest } from '../../utils/worktreeStartupRequest.js';

const worktreeOwnershipMocks = vi.hoisted(() => ({
  releasePersistedWorktreeSessionOwnership: vi.fn(),
}));

// Mock modules
vi.mock('../../utils/sessionUtils.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../utils/sessionUtils.js')>();
  return {
    ...actual,
    SessionSelector: vi.fn(),
  };
});
vi.mock('@qwen-code/core', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@qwen-code/core')>();
  return {
    ...actual,
    releasePersistedWorktreeSessionOwnership:
      worktreeOwnershipMocks.releasePersistedWorktreeSessionOwnership,
  };
});
vi.mock('../../utils/worktreeStartupRequest.js', () => ({
  applyWorktreeStartupRequest: vi.fn(),
}));

const MOCKED_SESSION_ID = 'test-session-123';
const MOCKED_CURRENT_SESSION_ID = 'current-session-id';

describe('useSessionBrowser', () => {
  const mockedSessionSelector = vi.mocked(SessionSelector);
  const mockResolveSession = vi.fn();
  const mockResolveSelectedSession = vi.fn();
  const mockResolveLatestSession = vi.fn();

  const mockConfig = {
    persistSessionTitle: vi.fn().mockResolvedValue(undefined),
    setSessionId: vi.fn(),
    getSessionId: vi.fn(),
    getProjectRoot: vi.fn(),
    getSessionArtifactProjectRoot: vi.fn(),
    getTranscriptStore: vi.fn(),
    getWorktreeSettings: vi.fn(),
    topicState: {
      setTopic: vi.fn(),
      getTopic: vi.fn(),
      getIntent: vi.fn(),
      reset: vi.fn(),
    },
  } as unknown as Config;

  const mockOnLoadHistory = vi.fn().mockResolvedValue(true);

  beforeEach(() => {
    vi.resetAllMocks();
    worktreeOwnershipMocks.releasePersistedWorktreeSessionOwnership.mockResolvedValue(
      undefined,
    );
    vi.spyOn(coreEvents, 'emitFeedback').mockImplementation(() => {});
    mockOnLoadHistory.mockResolvedValue(true);
    vi.mocked(applyWorktreeStartupRequest).mockResolvedValue(undefined);
    vi.mocked(mockConfig.getSessionId).mockReturnValue(
      MOCKED_CURRENT_SESSION_ID,
    );
    vi.mocked(mockConfig.getWorktreeSettings).mockReturnValue(undefined);
    vi.mocked(mockConfig.getSessionArtifactProjectRoot).mockReturnValue(
      '/target-project',
    );
    mockedSessionSelector.mockImplementation(
      () =>
        ({
          resolveSession: mockResolveSession,
          resolveSelectedSession: mockResolveSelectedSession,
          resolveLatestSession: mockResolveLatestSession,
        }) as unknown as InstanceType<typeof SessionSelector>,
    );
  });

  it('should successfully resume a session', async () => {
    const mockSession = {
      id: MOCKED_SESSION_ID,
      fileName: 'session.jsonl',
    } as SessionInfo;
    mockResolveSelectedSession.mockResolvedValue({
      sessionPath: '/tmp/session.jsonl',
      messages: [createUserMessage('Hello')],
      directories: ['/tmp'],
      sessionInfo: mockSession,
    });

    const { result } = await renderHook(() =>
      useSessionBrowser(mockConfig, mockOnLoadHistory),
    );

    await act(async () => {
      await result.current.handleResumeSession(mockSession);
    });
    expect(mockResolveSelectedSession).toHaveBeenCalledWith(mockSession);
    expect(result.current.isSessionBrowserOpen).toBe(false);
    expect(mockOnLoadHistory).toHaveBeenCalled();
  });

  it('passes a browser-selected worktree request into the resume transaction', async () => {
    const onResumeError = vi.fn();
    const mockSession = {
      id: MOCKED_SESSION_ID,
      fileName: 'session.jsonl',
    } as SessionInfo;
    mockResolveSelectedSession.mockResolvedValue({
      sessionPath: '/tmp/session.jsonl',
      messages: [createUserMessage('Hello')],
      directories: ['/tmp'],
      sessionInfo: mockSession,
    });
    const { result } = await renderHook(() =>
      useSessionBrowser(mockConfig, mockOnLoadHistory, onResumeError),
    );

    await act(async () => {
      result.current.openSessionBrowser({
        worktreeStartupRequest: {
          kind: 'create',
          name: 'feature-login',
          originalCwd: '/tmp',
        },
      });
    });
    await act(async () => {
      await result.current.handleResumeSession(mockSession);
    });

    expect(mockOnLoadHistory).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({ sessionId: MOCKED_SESSION_ID }),
      expect.objectContaining({
        worktreeStartupRequest: {
          kind: 'create',
          name: 'feature-login',
          originalCwd: '/tmp',
        },
      }),
    );
    expect(applyWorktreeStartupRequest).not.toHaveBeenCalled();
    expect(onResumeError).not.toHaveBeenCalled();
  });

  it('reuses a session result already loaded by preview', async () => {
    const mockSession = {
      id: MOCKED_SESSION_ID,
      fileName: 'session.jsonl',
    } as SessionInfo;
    const resolved = {
      sessionPath: '/tmp/session.jsonl',
      messages: [createUserMessage('Hello')],
      directories: ['/tmp'],
      displayInfo: 'preview',
      sessionInfo: mockSession,
    };

    const { result } = await renderHook(() =>
      useSessionBrowser(mockConfig, mockOnLoadHistory),
    );

    await act(async () => {
      await result.current.handleResumeSession(mockSession, resolved);
    });

    expect(mockResolveSelectedSession).not.toHaveBeenCalled();
    expect(mockOnLoadHistory).toHaveBeenCalled();
  });

  it('settles a session worktree owner before deleting from the browser', async () => {
    const deleteTranscript = vi.fn().mockResolvedValue(undefined);
    vi.mocked(mockConfig.getTranscriptStore).mockReturnValue({
      deleteTranscript,
    } as unknown as ReturnType<Config['getTranscriptStore']>);
    const session = {
      id: MOCKED_SESSION_ID,
      fileName: 'session.jsonl',
      sessionPath: '/tmp/session.jsonl',
      worktreeSession: {
        sessionId: MOCKED_SESSION_ID,
        originalCwd: '/tmp/project',
        worktreePath: '/tmp/worktree',
        worktreeName: 'worktree',
        lifecycle: 'owner',
      },
    } as SessionInfo;
    const { result } = await renderHook(() =>
      useSessionBrowser(mockConfig, mockOnLoadHistory),
    );

    await act(async () => {
      await result.current.handleDeleteSession(session);
    });

    expect(
      worktreeOwnershipMocks.releasePersistedWorktreeSessionOwnership,
    ).toHaveBeenCalledWith(session.worktreeSession, MOCKED_SESSION_ID);
    expect(deleteTranscript).toHaveBeenCalledWith('/tmp/session.jsonl');
  });

  it('should handle file read error', async () => {
    const onResumeError = vi.fn();
    const mockSession = {
      id: MOCKED_SESSION_ID,
      fileName: 'session.jsonl',
    } as SessionInfo;
    mockResolveSelectedSession.mockRejectedValue(new Error('File not found'));

    const { result } = await renderHook(() =>
      useSessionBrowser(mockConfig, mockOnLoadHistory, onResumeError),
    );

    await act(async () => {
      await result.current.handleResumeSession(mockSession);
    });

    expect(coreEvents.emitFeedback).toHaveBeenCalledWith(
      'error',
      'Error resuming session:',
      expect.any(Error),
    );
    expect(onResumeError).toHaveBeenCalledWith(expect.any(Error));
    expect(result.current.isSessionBrowserOpen).toBe(false);
  });

  it('should handle JSON parse error', async () => {
    const mockSession = {
      id: MOCKED_SESSION_ID,
      fileName: 'invalid.jsonl',
    } as SessionInfo;
    mockResolveSelectedSession.mockRejectedValue(new Error('invalid json'));

    const { result } = await renderHook(() =>
      useSessionBrowser(mockConfig, mockOnLoadHistory),
    );

    await act(async () => {
      await result.current.handleResumeSession(mockSession);
    });

    expect(coreEvents.emitFeedback).toHaveBeenCalledWith(
      'error',
      'Error resuming session:',
      expect.any(Error),
    );
    expect(result.current.isSessionBrowserOpen).toBe(false);
  });

  it('should continue the latest session when requested', async () => {
    mockResolveLatestSession.mockResolvedValue({
      sessionPath: '/tmp/session.jsonl',
      messages: [createUserMessage('Hello')],
      directories: ['/tmp'],
      sessionInfo: {
        id: 'latest-session',
      },
    });

    const { result } = await renderHook(() =>
      useSessionBrowser(mockConfig, mockOnLoadHistory),
    );

    await act(async () => {
      result.current.openSessionBrowser({ continueLatest: true });
    });

    expect(mockResolveLatestSession).toHaveBeenCalled();
    expect(mockOnLoadHistory).toHaveBeenCalled();
    expect(result.current.isSessionBrowserOpen).toBe(false);
  });

  it('does not cold-resume the session that is already open', async () => {
    // 当前会话的 Writer 仍持有 transcript 状态，冷恢复必然以 conflict 失败；
    // picker 早已把当前会话排除在可恢复范围外，/continue 必须遵守同一条规则。
    const finish = vi.fn();
    mockResolveLatestSession.mockResolvedValue({
      sessionPath: '/tmp/current.jsonl',
      messages: [createUserMessage('Hello')],
      directories: ['/tmp'],
      sessionInfo: {
        id: MOCKED_CURRENT_SESSION_ID,
        isCurrentSession: true,
      },
      resumeAttempt: { finish } as unknown as import('@qwen-code/core').ResumeReadAttempt,
    });

    const { result } = await renderHook(() =>
      useSessionBrowser(mockConfig, mockOnLoadHistory),
    );

    await act(async () => {
      result.current.openSessionBrowser({ continueLatest: true });
    });

    expect(mockOnLoadHistory).not.toHaveBeenCalled();
    expect(coreEvents.emitFeedback).toHaveBeenCalledWith(
      'info',
      'This session is already open.',
    );
    expect(finish).toHaveBeenCalled();
  });

  it('should fail continue without opening the browser when no session exists', async () => {
    mockResolveLatestSession.mockRejectedValue(SessionError.noSessionsFound());

    const { result } = await renderHook(() =>
      useSessionBrowser(mockConfig, mockOnLoadHistory),
    );

    await act(async () => {
      result.current.openSessionBrowser({ continueLatest: true });
    });

    expect(coreEvents.emitFeedback).toHaveBeenCalledWith(
      'error',
      'No conversation found to continue',
    );
    expect(result.current.isSessionBrowserOpen).toBe(false);
    expect(mockOnLoadHistory).not.toHaveBeenCalled();
  });

  it('should open the browser in search mode when the resume target is not an exact match', async () => {
    mockResolveSession.mockRejectedValue(
      SessionError.invalidSessionIdentifier('missing'),
    );

    const { result } = await renderHook(() =>
      useSessionBrowser(mockConfig, mockOnLoadHistory),
    );

    await act(async () => {
      result.current.openSessionBrowser({ resumeTarget: 'missing' });
    });

    expect(result.current.isSessionBrowserOpen).toBe(true);
    expect(result.current.sessionBrowserOptions).toEqual({
      initialSearchQuery: 'missing',
    });
    expect(mockOnLoadHistory).not.toHaveBeenCalled();
  });

  it('should open the browser in search mode when the resume target is latest', async () => {
    mockResolveSession.mockRejectedValue(
      SessionError.invalidSessionIdentifier('latest'),
    );

    const { result } = await renderHook(() =>
      useSessionBrowser(mockConfig, mockOnLoadHistory),
    );

    await act(async () => {
      result.current.openSessionBrowser({ resumeTarget: 'latest' });
    });

    expect(mockResolveSession).toHaveBeenCalledWith('latest');
    expect(result.current.isSessionBrowserOpen).toBe(true);
    expect(result.current.sessionBrowserOptions).toEqual({
      initialSearchQuery: 'latest',
    });
    expect(mockOnLoadHistory).not.toHaveBeenCalled();
  });

  it('passes the initial title into resume so the target runtime persists it', async () => {
    mockResolveSession.mockResolvedValue({
      sessionPath: '/tmp/session.jsonl',
      messages: [createUserMessage('Hello')],
      directories: ['/tmp'],
      sessionInfo: {
        id: MOCKED_SESSION_ID,
      },
    });

    const { result } = await renderHook(() =>
      useSessionBrowser(mockConfig, mockOnLoadHistory),
    );

    await act(async () => {
      result.current.openSessionBrowser({
        resumeTarget: MOCKED_SESSION_ID,
        initialSessionTitle: '  Fix login flow  ',
      });
    });

    expect(mockOnLoadHistory).toHaveBeenCalledWith(
      expect.any(Array),
      expect.any(Object),
      expect.objectContaining({ initialSessionTitle: '  Fix login flow  ' }),
    );
    expect(mockConfig.persistSessionTitle).not.toHaveBeenCalled();
  });

  it('should not persist an initial session title when resume fails after resolution', async () => {
    mockResolveSession.mockResolvedValue({
      sessionPath: '/tmp/session.jsonl',
      messages: [createUserMessage('Hello')],
      directories: ['/tmp'],
      sessionInfo: {
        id: MOCKED_SESSION_ID,
      },
    });
    mockOnLoadHistory.mockResolvedValueOnce(false);

    const { result } = await renderHook(() =>
      useSessionBrowser(mockConfig, mockOnLoadHistory),
    );

    await act(async () => {
      result.current.openSessionBrowser({
        resumeTarget: MOCKED_SESSION_ID,
        initialSessionTitle: 'Fix login flow',
      });
    });

    expect(mockOnLoadHistory).toHaveBeenCalled();
    expect(mockConfig.persistSessionTitle).not.toHaveBeenCalled();
  });

  it('removes a newly created fork when history loading declines the resume', async () => {
    const sourceMessage = createUserMessage('Hello');
    const sourceInfo = {
      id: MOCKED_SESSION_ID,
      transcriptProjectRoot: '/source-project',
      worktreeSession: {
        originalCwd: '/source-project',
        worktreePath: '/source-project/.qwen/worktrees/source',
        worktreeCwd: '/source-project/.qwen/worktrees/source/apps/desktop',
        worktreeName: 'source',
        sessionId: MOCKED_SESSION_ID,
        lifecycle: 'owner',
        pendingOwnerReleasePath: '/source-project/.qwen/worktrees/previous',
      },
    } as SessionInfo;
    mockResolveSelectedSession.mockResolvedValue({
      sessionPath: '/source-project/source.jsonl',
      messages: [sourceMessage],
      directories: ['/source-project'],
      sessionInfo: sourceInfo,
    });
    vi.mocked(mockConfig.getProjectRoot).mockReturnValue(
      '/target-project/.qwen/worktrees/feature-login/apps/desktop',
    );
    vi.mocked(mockConfig.getTranscriptStore).mockReturnValue(
      {} as ReturnType<Config['getTranscriptStore']>,
    );
    vi.mocked(mockConfig.getWorktreeSettings).mockReturnValue({
      name: 'feature-login',
      path: '/target-project/.qwen/worktrees/feature-login',
      worktreeCwd:
        '/target-project/.qwen/worktrees/feature-login/apps/desktop',
      baseSha: 'abc123',
      lifecycle: 'owner',
      originalCwd: '/target-project',
      worktreeBranch: 'worktree-feature-login',
      originalBranch: 'develop',
      originalHeadCommit: 'abc123',
      sessionId: MOCKED_CURRENT_SESSION_ID,
    });
    const attachedWorktreeSession = {
      originalCwd: '/source-project',
      worktreePath: '/source-project/.qwen/worktrees/source',
      worktreeCwd: '/source-project/.qwen/worktrees/source/apps/desktop',
      worktreeName: 'source',
      sessionId: 'fork-session-id',
      lifecycle: 'attached' as const,
    };
    const createFork = vi
      .spyOn(ForkSessionService.prototype, 'createFork')
      .mockResolvedValue({
        entries: [],
        sessionId: 'fork-session-id',
        sessionPath: '/source-project/fork-session-id.jsonl',
        messages: [sourceMessage],
        directories: ['/source-project'],
        fileHistorySnapshots: [],
        sourceSessionInfo: sourceInfo as never,
        worktreeSession: attachedWorktreeSession,
        forkedFrom: {
          sessionId: MOCKED_SESSION_ID,
          messageUuid: sourceMessage.uuid,
        },
        resumeState: {
          filePath: '/source-project/fork-session-id.jsonl',
          sessionId: 'fork-session-id',
          snapshot: {
            device: 0,
            inode: 0,
            size: 0,
            modifiedTimeMs: 0,
          },
          writerState: { messageUuids: [] },
          runtimeTailUuid: null,
          worktreeStates: [],
        },
      });
    const deleteForkArtifacts = vi
      .spyOn(ForkSessionService.prototype, 'deleteForkArtifacts')
      .mockResolvedValue(undefined);
    mockOnLoadHistory.mockResolvedValueOnce(false);

    try {
      const { result } = await renderHook(() =>
        useSessionBrowser(mockConfig, mockOnLoadHistory),
      );

      await act(async () => {
        result.current.openSessionBrowser({
          forkSession: true,
          targetSessionId: 'fork-session-id',
        });
      });
      await act(async () => {
        await result.current.handleResumeSession(sourceInfo, undefined);
      });

      expect(createFork).toHaveBeenCalledWith({
        projectRoot: '/source-project',
        sourceSessionId: MOCKED_SESSION_ID,
        sourceSessionPath: '/source-project/source.jsonl',
        sourceProjectRoot: '/source-project',
        targetSessionId: 'fork-session-id',
        targetWorktreeSession: attachedWorktreeSession,
        targetCwd: '/source-project/.qwen/worktrees/source/apps/desktop',
      });
      expect(mockOnLoadHistory.mock.calls.at(-1)?.[1]).toMatchObject({
        sessionId: 'fork-session-id',
        sourceSessionId: MOCKED_SESSION_ID,
        sessionPath: '/source-project/fork-session-id.jsonl',
        sourceSessionPath: '/source-project/source.jsonl',
      });
      expect(deleteForkArtifacts).toHaveBeenCalledWith({
        projectRoot: '/source-project',
        sessionId: 'fork-session-id',
        sessionPath: '/source-project/fork-session-id.jsonl',
      });
    } finally {
      createFork.mockRestore();
      deleteForkArtifacts.mockRestore();
    }
  });
});

describe('convertMessagesToHistoryFormats', () => {
  it('converts basic transcript user and assistant messages', () => {
    const result = convertMessagesToHistoryFormats([
      createUserMessage('Hello'),
      createAssistantMessage({
        messageId: 'assistant-1',

        blocks: [{ type: 'text', text: 'Hi there' }],

        model: 'test-model',
        stopReason: 'end_turn',

        usage: ((value) => ({
          inputTokens: value.input_tokens,
          outputTokens: value.output_tokens,
          cacheReadInputTokens: value.cache_read_input_tokens,
          cacheCreationInputTokens: value.cache_creation_input_tokens,
        }))(cloneUsage()),
      }),
    ]);

    expect(result.uiHistory).toEqual([
      { type: 'user', text: 'Hello' },
      { type: 'gemini', text: 'Hi there' },
    ]);
  });
});
