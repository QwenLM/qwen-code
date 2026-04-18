/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import { act, renderHook } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  CompressionStatus,
  type Config,
  type ResumedSessionData,
} from '@qwen-code/qwen-code-core';
import { useRewindCommand } from './useRewindCommand.js';
import type { RewindHistoryEntry } from '../types/rewind.js';

vi.mock('../utils/resumeHistoryUtils.js', () => ({
  buildResumedHistoryItems: vi.fn(() => [{ id: 1, type: 'user', text: 'hi' }]),
}));

function createSessionData(
  messages: ResumedSessionData['conversation']['messages'],
): ResumedSessionData {
  return {
    filePath: '/tmp/project/chats/session-1.jsonl',
    conversation: {
      sessionId: 'session-1',
      projectHash: 'project-1',
      startTime: '2025-01-01T00:00:00.000Z',
      lastUpdated: '2025-01-01T00:00:00.000Z',
      messages,
    },
    lastCompletedUuid: messages.at(-1)?.uuid ?? null,
  };
}

function createEntry(
  overrides: Partial<RewindHistoryEntry> = {},
): RewindHistoryEntry {
  return {
    key: 'user-2',
    kind: 'node',
    label: 'who are you ?',
    timestamp: '2025-01-01T00:02:00.000Z',
    node: {
      uuid: 'user-2',
      parentUuid: 'assistant-1',
      sessionId: 'session-1',
      timestamp: '2025-01-01T00:02:00.000Z',
      prompt: 'who are you ?',
    },
    codeSummary: {
      hasChanges: false,
      summaryText: 'No code changes',
      detailText: 'The code will be unchanged.',
      changes: [],
    },
    restoreCodeSummary: {
      hasChanges: false,
      summaryText: 'No code changes',
      detailText: 'The code will be unchanged.',
      changes: [],
    },
    ...overrides,
  };
}

describe('useRewindCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('opens and closes the rewind list', () => {
    const { result } = renderHook(() => useRewindCommand());

    act(() => {
      result.current.openRewindDialog();
    });
    expect(result.current.isRewindDialogOpen).toBe(true);

    act(() => {
      result.current.closeRewindDialog();
    });
    expect(result.current.isRewindDialogOpen).toBe(false);
  });

  it('treats the current entry as a no-op', () => {
    const { result } = renderHook(() => useRewindCommand());

    act(() => {
      result.current.openRewindDialog();
      result.current.handleRewind({
        key: 'current',
        kind: 'current',
        label: '(current)',
        codeSummary: {
          hasChanges: false,
          summaryText: 'No code changes',
          detailText: 'The code will be unchanged.',
          changes: [],
        },
        restoreCodeSummary: {
          hasChanges: false,
          summaryText: 'No code changes',
          detailText: 'The code will be unchanged.',
          changes: [],
        },
      });
    });

    expect(result.current.isRewindDialogOpen).toBe(false);
    expect(result.current.rewindTarget).toBeNull();
  });

  it('restores conversation state after confirmation', async () => {
    const entry = createEntry();
    const sessionData = createSessionData([
      {
        uuid: 'user-1',
        parentUuid: null,
        sessionId: 'session-1',
        timestamp: '2025-01-01T00:00:00.000Z',
        type: 'user',
        message: { role: 'user', parts: [{ text: 'hi' }] },
        cwd: '/tmp/project',
        version: '1.0.0',
      },
    ]);
    const historyManager = {
      addItem: vi.fn(),
      clearItems: vi.fn(),
      loadHistory: vi.fn(),
    };
    const startNewSession = vi.fn();
    const setInputText = vi.fn();
    const geminiClient = {
      initialize: vi.fn(),
    };
    const sessionService = {
      loadSession: vi.fn().mockResolvedValue(sessionData),
    };
    const hookSystem = {
      fireSessionStartEvent: vi.fn().mockResolvedValue(undefined),
    };
    const config = {
      getSessionId: () => 'session-1',
      getSessionService: () => sessionService,
      getGeminiClient: () => geminiClient,
      getHookSystem: () => hookSystem,
      getModel: () => 'qwen3-coder-plus',
      getApprovalMode: () => 'default',
      startNewSession: vi.fn(),
      getDebugLogger: () => ({
        warn: vi.fn(),
      }),
    } as unknown as Config;

    const { result } = renderHook(() =>
      useRewindCommand({
        config,
        historyManager,
        startNewSession,
        setInputText,
      }),
    );

    act(() => {
      result.current.openRewindDialog();
      result.current.handleRewind(entry);
    });

    expect(result.current.isRewindDialogOpen).toBe(false);
    expect(result.current.rewindTarget).toEqual(entry);

    await act(async () => {
      await result.current.handleRewindAction('restore_conversation');
    });

    expect(sessionService.loadSession).toHaveBeenCalledWith('session-1', {
      leafUuid: 'assistant-1',
    });
    expect(startNewSession).toHaveBeenCalledWith('session-1');
    expect(historyManager.clearItems).toHaveBeenCalledTimes(1);
    expect(historyManager.loadHistory).toHaveBeenCalledTimes(1);
    expect(config.startNewSession).toHaveBeenCalledWith(
      'session-1',
      sessionData,
    );
    expect(geminiClient.initialize).toHaveBeenCalledTimes(1);
    expect(setInputText).toHaveBeenCalledWith('who are you ?');
    expect(hookSystem.fireSessionStartEvent).toHaveBeenCalledTimes(1);
    expect(result.current.rewindTarget).toBeNull();
  });

  it('restores only code when requested', async () => {
    const gitService = {
      restoreProjectFromSnapshot: vi.fn().mockResolvedValue(undefined),
    };
    const historyManager = {
      addItem: vi.fn(),
      clearItems: vi.fn(),
      loadHistory: vi.fn(),
    };
    const config = {
      getGitService: vi.fn().mockResolvedValue(gitService),
    } as unknown as Config;
    const entry = createEntry({
      codeSummary: {
        hasChanges: false,
        summaryText: 'No code changes',
        detailText: 'The code will be unchanged.',
        changes: [],
      },
      restoreCodeSummary: {
        hasChanges: true,
        summaryText: 'test.py +10 -2',
        detailText: 'The code will be restored +10 -2 in test.py.',
        changes: [{ path: 'test.py', additions: 10, deletions: 2 }],
        checkpointCommitHash: 'snapshot-1',
      },
    });

    const { result } = renderHook(() =>
      useRewindCommand({
        config,
        historyManager,
        startNewSession: vi.fn(),
        setInputText: vi.fn(),
      }),
    );

    act(() => {
      result.current.handleRewind(entry);
    });

    await act(async () => {
      await result.current.handleRewindAction('restore_code');
    });

    expect(gitService.restoreProjectFromSnapshot).toHaveBeenCalledWith(
      'snapshot-1',
      {
        untrackedPathsToDelete: ['test.py'],
      },
    );
    expect(historyManager.addItem).toHaveBeenCalledWith(
      {
        type: 'info',
        text: 'The code will be restored +10 -2 in test.py.',
      },
      expect.any(Number),
    );
  });

  it('preloads conversation before restoring code and conversation', async () => {
    const sessionData = createSessionData([
      {
        uuid: 'user-1',
        parentUuid: null,
        sessionId: 'session-1',
        timestamp: '2025-01-01T00:00:00.000Z',
        type: 'user',
        message: { role: 'user', parts: [{ text: 'hi' }] },
        cwd: '/tmp/project',
        version: '1.0.0',
      },
    ]);
    const callOrder: string[] = [];
    const gitService = {
      restoreProjectFromSnapshot: vi.fn().mockImplementation(() => {
        callOrder.push('restore-code');
        return Promise.resolve();
      }),
    };
    const sessionService = {
      loadSession: vi.fn().mockImplementation(() => {
        callOrder.push('load-session');
        return Promise.resolve(sessionData);
      }),
    };
    const historyManager = {
      addItem: vi.fn(),
      clearItems: vi.fn(),
      loadHistory: vi.fn(),
    };
    const config = {
      getSessionId: () => 'session-1',
      getSessionService: () => sessionService,
      getGeminiClient: () => ({
        initialize: vi.fn(),
      }),
      getHookSystem: () => ({
        fireSessionStartEvent: vi.fn().mockResolvedValue(undefined),
      }),
      getModel: () => 'qwen3-coder-plus',
      getApprovalMode: () => 'default',
      startNewSession: vi.fn(),
      getDebugLogger: () => ({
        warn: vi.fn(),
      }),
      getGitService: vi.fn().mockResolvedValue(gitService),
    } as unknown as Config;
    const entry = createEntry({
      restoreCodeSummary: {
        hasChanges: true,
        summaryText: 'test.py +10 -2',
        detailText: 'The code will be restored +10 -2 in test.py.',
        changes: [{ path: 'test.py', additions: 10, deletions: 2 }],
        checkpointCommitHash: 'snapshot-1',
      },
    });

    const { result } = renderHook(() =>
      useRewindCommand({
        config,
        historyManager,
        startNewSession: vi.fn(),
        setInputText: vi.fn(),
      }),
    );

    act(() => {
      result.current.handleRewind(entry);
    });

    await act(async () => {
      await result.current.handleRewindAction('restore_code_and_conversation');
    });

    expect(callOrder).toEqual(['load-session', 'restore-code']);
    expect(sessionService.loadSession).toHaveBeenCalledTimes(1);
    expect(gitService.restoreProjectFromSnapshot).toHaveBeenCalledWith(
      'snapshot-1',
      {
        untrackedPathsToDelete: ['test.py'],
      },
    );
    expect(historyManager.clearItems).toHaveBeenCalledTimes(1);
  });

  it('does not restore code if conversation preload fails', async () => {
    const gitService = {
      restoreProjectFromSnapshot: vi.fn().mockResolvedValue(undefined),
    };
    const sessionService = {
      loadSession: vi.fn().mockResolvedValue(undefined),
    };
    const historyManager = {
      addItem: vi.fn(),
      clearItems: vi.fn(),
      loadHistory: vi.fn(),
    };
    const config = {
      getSessionId: () => 'session-1',
      getSessionService: () => sessionService,
      getGitService: vi.fn().mockResolvedValue(gitService),
    } as unknown as Config;
    const entry = createEntry({
      restoreCodeSummary: {
        hasChanges: true,
        summaryText: 'test.py +10 -2',
        detailText: 'The code will be restored +10 -2 in test.py.',
        changes: [{ path: 'test.py', additions: 10, deletions: 2 }],
        checkpointCommitHash: 'snapshot-1',
      },
    });

    const { result } = renderHook(() =>
      useRewindCommand({
        config,
        historyManager,
        startNewSession: vi.fn(),
        setInputText: vi.fn(),
      }),
    );

    act(() => {
      result.current.handleRewind(entry);
    });

    await act(async () => {
      await result.current.handleRewindAction('restore_code_and_conversation');
    });

    expect(gitService.restoreProjectFromSnapshot).not.toHaveBeenCalled();
    expect(historyManager.addItem).toHaveBeenCalledWith(
      {
        type: 'error',
        text: 'Failed to rewind session.',
        hint: 'Failed to load rewind session data.',
      },
      expect.any(Number),
    );
  });

  it('reports when conversation restore fails after code was restored', async () => {
    const sessionData = createSessionData([
      {
        uuid: 'user-1',
        parentUuid: null,
        sessionId: 'session-1',
        timestamp: '2025-01-01T00:00:00.000Z',
        type: 'user',
        message: { role: 'user', parts: [{ text: 'hi' }] },
        cwd: '/tmp/project',
        version: '1.0.0',
      },
    ]);
    const gitService = {
      restoreProjectFromSnapshot: vi.fn().mockResolvedValue(undefined),
    };
    const sessionService = {
      loadSession: vi.fn().mockResolvedValue(sessionData),
    };
    const historyManager = {
      addItem: vi.fn(),
      clearItems: vi.fn(),
      loadHistory: vi.fn(),
    };
    const config = {
      getSessionId: () => 'session-1',
      getSessionService: () => sessionService,
      getGitService: vi.fn().mockResolvedValue(gitService),
    } as unknown as Config;
    const entry = createEntry({
      restoreCodeSummary: {
        hasChanges: true,
        summaryText: 'test.py +10 -2',
        detailText: 'The code will be restored +10 -2 in test.py.',
        changes: [{ path: 'test.py', additions: 10, deletions: 2 }],
        checkpointCommitHash: 'snapshot-1',
      },
    });

    const { result } = renderHook(() =>
      useRewindCommand({
        config,
        historyManager,
        startNewSession: vi.fn(() => {
          throw new Error('UI restore failed');
        }),
        setInputText: vi.fn(),
      }),
    );

    act(() => {
      result.current.handleRewind(entry);
    });

    await act(async () => {
      await result.current.handleRewindAction('restore_code_and_conversation');
    });

    expect(gitService.restoreProjectFromSnapshot).toHaveBeenCalledWith(
      'snapshot-1',
      {
        untrackedPathsToDelete: ['test.py'],
      },
    );
    expect(historyManager.addItem).toHaveBeenCalledWith(
      {
        type: 'error',
        text: 'Failed to restore conversation after restoring code. Code was already restored to the selected checkpoint.',
        hint: 'UI restore failed',
      },
      expect.any(Number),
    );
  });

  it('keeps code unchanged when restore conversation is selected', async () => {
    const sessionData = createSessionData([
      {
        uuid: 'user-1',
        parentUuid: null,
        sessionId: 'session-1',
        timestamp: '2025-01-01T00:00:00.000Z',
        type: 'user',
        message: { role: 'user', parts: [{ text: 'hi' }] },
        cwd: '/tmp/project',
        version: '1.0.0',
      },
    ]);
    const gitService = {
      restoreProjectFromSnapshot: vi.fn().mockResolvedValue(undefined),
    };
    const sessionService = {
      loadSession: vi.fn().mockResolvedValue(sessionData),
    };
    const historyManager = {
      addItem: vi.fn(),
      clearItems: vi.fn(),
      loadHistory: vi.fn(),
    };
    const config = {
      getSessionId: () => 'session-1',
      getSessionService: () => sessionService,
      getGeminiClient: () => ({
        initialize: vi.fn(),
      }),
      getHookSystem: () => ({
        fireSessionStartEvent: vi.fn().mockResolvedValue(undefined),
      }),
      getModel: () => 'qwen3-coder-plus',
      getApprovalMode: () => 'default',
      startNewSession: vi.fn(),
      getDebugLogger: () => ({
        warn: vi.fn(),
      }),
      getGitService: vi.fn().mockResolvedValue(gitService),
    } as unknown as Config;
    const entry = createEntry({
      codeSummary: {
        hasChanges: false,
        summaryText: 'No code changes',
        detailText: 'The code will be unchanged.',
        changes: [],
      },
      restoreCodeSummary: {
        hasChanges: true,
        summaryText: 'test.py +10 -2',
        detailText: 'The code will be restored +10 -2 in test.py.',
        changes: [{ path: 'test.py', additions: 10, deletions: 2 }],
        checkpointCommitHash: 'snapshot-1',
      },
    });

    const { result } = renderHook(() =>
      useRewindCommand({
        config,
        historyManager,
        startNewSession: vi.fn(),
        setInputText: vi.fn(),
      }),
    );

    act(() => {
      result.current.handleRewind(entry);
    });

    await act(async () => {
      await result.current.handleRewindAction('restore_conversation');
    });

    expect(gitService.restoreProjectFromSnapshot).not.toHaveBeenCalled();
    expect(sessionService.loadSession).toHaveBeenCalledWith('session-1', {
      leafUuid: 'assistant-1',
    });
  });

  it('shows an error when restore conversation cannot load session data', async () => {
    const sessionService = {
      loadSession: vi.fn().mockResolvedValue(undefined),
    };
    const historyManager = {
      addItem: vi.fn(),
      clearItems: vi.fn(),
      loadHistory: vi.fn(),
    };
    const config = {
      getSessionId: () => 'session-1',
      getSessionService: () => sessionService,
    } as unknown as Config;

    const { result } = renderHook(() =>
      useRewindCommand({
        config,
        historyManager,
        startNewSession: vi.fn(),
        setInputText: vi.fn(),
      }),
    );

    act(() => {
      result.current.handleRewind(createEntry());
    });

    await act(async () => {
      await result.current.handleRewindAction('restore_conversation');
    });

    expect(historyManager.clearItems).not.toHaveBeenCalled();
    expect(historyManager.addItem).toHaveBeenCalledWith(
      {
        type: 'error',
        text: 'Failed to rewind session.',
        hint: 'Failed to load rewind session data.',
      },
      expect.any(Number),
    );
  });

  it('summarizes later messages before continuing from the selected prompt', async () => {
    const entry = createEntry();
    const prefixSessionData = createSessionData([
      {
        uuid: 'user-1',
        parentUuid: null,
        sessionId: 'session-1',
        timestamp: '2025-01-01T00:00:00.000Z',
        type: 'user',
        message: { role: 'user', parts: [{ text: 'hi' }] },
        cwd: '/tmp/project',
        version: '1.0.0',
      },
      {
        uuid: 'assistant-1',
        parentUuid: 'user-1',
        sessionId: 'session-1',
        timestamp: '2025-01-01T00:00:05.000Z',
        type: 'assistant',
        message: { role: 'model', parts: [{ text: 'hello' }] },
        cwd: '/tmp/project',
        version: '1.0.0',
      },
    ]);
    const currentSessionData = createSessionData([
      ...prefixSessionData.conversation.messages,
      {
        uuid: 'user-2',
        parentUuid: 'assistant-1',
        sessionId: 'session-1',
        timestamp: '2025-01-01T00:02:00.000Z',
        type: 'user',
        message: { role: 'user', parts: [{ text: 'who are you ?' }] },
        cwd: '/tmp/project',
        version: '1.0.0',
      },
      {
        uuid: 'assistant-2',
        parentUuid: 'user-2',
        sessionId: 'session-1',
        timestamp: '2025-01-01T00:02:10.000Z',
        type: 'assistant',
        message: { role: 'model', parts: [{ text: 'I am Qwen Code.' }] },
        cwd: '/tmp/project',
        version: '1.0.0',
      },
      {
        uuid: 'user-3',
        parentUuid: 'assistant-2',
        sessionId: 'session-1',
        timestamp: '2025-01-01T00:02:20.000Z',
        type: 'user',
        message: { role: 'user', parts: [{ text: 'show me your skills' }] },
        cwd: '/tmp/project',
        version: '1.0.0',
      },
    ]);
    const sessionService = {
      loadSession: vi.fn().mockResolvedValue(prefixSessionData),
    };
    const contentGenerator = {
      generateContent: vi.fn().mockResolvedValue({
        candidates: [
          {
            content: {
              parts: [{ text: '<state_snapshot>summary</state_snapshot>' }],
            },
          },
        ],
        usageMetadata: {
          promptTokenCount: 20,
          totalTokenCount: 8,
        },
      }),
    };
    const geminiClient = {
      initialize: vi.fn(),
      setHistory: vi.fn(),
    };
    const chatRecordingService = {
      recordChatCompression: vi.fn(),
    };
    const hookSystem = {
      fireSessionStartEvent: vi.fn().mockResolvedValue(undefined),
    };
    const historyManager = {
      addItem: vi.fn(),
      clearItems: vi.fn(),
      loadHistory: vi.fn(),
      updateItem: vi.fn(),
    };
    const callOrder: string[] = [];
    const startNewSession = vi.fn();
    const setInputText = vi.fn();
    const config = {
      getSessionId: () => 'session-1',
      getResumedSessionData: () => currentSessionData,
      getSessionService: () => sessionService,
      getContentGenerator: () => contentGenerator,
      getModel: () => 'qwen3-coder-plus',
      getGeminiClient: () => geminiClient,
      getChatRecordingService: () => {
        callOrder.push('get-recording-service');
        return chatRecordingService;
      },
      getHookSystem: () => hookSystem,
      getApprovalMode: () => 'default',
      startNewSession: vi.fn(() => {
        callOrder.push('start-new-session');
      }),
      getDebugLogger: () => ({
        warn: vi.fn(),
      }),
    } as unknown as Config;

    const { result } = renderHook(() =>
      useRewindCommand({
        config,
        historyManager,
        startNewSession,
        setInputText,
      }),
    );

    act(() => {
      result.current.handleRewind(entry);
    });

    await act(async () => {
      await result.current.handleRewindAction('summarize_from_here');
    });

    expect(sessionService.loadSession).toHaveBeenCalledOnce();
    expect(sessionService.loadSession).toHaveBeenCalledWith('session-1');
    expect(contentGenerator.generateContent).toHaveBeenCalledTimes(1);
    const summarizeRequest = contentGenerator.generateContent.mock.calls[0]![0];
    const summarizedContents = JSON.stringify(summarizeRequest.contents);
    expect(summarizedContents).not.toContain('who are you ?');
    expect(summarizedContents).toContain('I am Qwen Code.');
    expect(summarizedContents).toContain('show me your skills');
    expect(historyManager.clearItems).toHaveBeenCalledTimes(1);
    expect(historyManager.loadHistory).toHaveBeenCalledTimes(1);
    expect(historyManager.addItem).toHaveBeenNthCalledWith(
      1,
      {
        type: 'compression',
        compression: {
          isPending: true,
          originalTokenCount: null,
          newTokenCount: null,
          compressionStatus: null,
        },
      },
      expect.any(Number),
    );
    expect(historyManager.addItem).toHaveBeenNthCalledWith(
      2,
      {
        type: 'compression',
        compression: {
          isPending: false,
          originalTokenCount: 20,
          newTokenCount: 8,
          compressionStatus: CompressionStatus.COMPRESSED,
        },
      },
      expect.any(Number),
    );
    expect(historyManager.addItem).toHaveBeenNthCalledWith(
      3,
      {
        type: 'info',
        text: 'Summarized conversation',
      },
      expect.any(Number),
    );
    expect(historyManager.addItem).toHaveBeenNthCalledWith(
      4,
      {
        type: 'info',
        text: 'Summarized 2 messages from this point. Context: “who are you ?”',
      },
      expect.any(Number),
    );
    expect(startNewSession).toHaveBeenCalledWith('session-1');
    expect(config.startNewSession).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({
        conversation: expect.objectContaining({
          messages: prefixSessionData.conversation.messages,
        }),
        lastCompletedUuid: 'assistant-1',
      }),
    );
    expect(geminiClient.initialize).toHaveBeenCalledTimes(1);
    expect(geminiClient.setHistory).toHaveBeenCalledWith(
      expect.arrayContaining([
        {
          role: 'user',
          parts: [{ text: '<state_snapshot>summary</state_snapshot>' }],
        },
        {
          role: 'model',
          parts: [{ text: 'Got it. Thanks for the additional context!' }],
        },
      ]),
    );
    expect(chatRecordingService.recordChatCompression).toHaveBeenCalledTimes(1);
    expect(callOrder).toEqual(['start-new-session', 'get-recording-service']);
    expect(setInputText).toHaveBeenCalledWith('who are you ?');
    expect(hookSystem.fireSessionStartEvent).toHaveBeenCalledTimes(1);
  });

  it('shows an error when summarize cannot start', async () => {
    const entry = createEntry({
      node: {
        uuid: 'user-2',
        parentUuid: 'user-1',
        sessionId: 'session-1',
        timestamp: '2025-01-01T00:02:00.000Z',
        prompt: 'who are you ?',
      },
    });
    const prefixSessionData = createSessionData([
      {
        uuid: 'user-1',
        parentUuid: null,
        sessionId: 'session-1',
        timestamp: '2025-01-01T00:00:00.000Z',
        type: 'user',
        message: { role: 'user', parts: [{ text: 'hi' }] },
        cwd: '/tmp/project',
        version: '1.0.0',
      },
    ]);
    const currentSessionData = createSessionData([
      ...prefixSessionData.conversation.messages,
      {
        uuid: 'user-2',
        parentUuid: 'user-1',
        sessionId: 'session-1',
        timestamp: '2025-01-01T00:02:00.000Z',
        type: 'user',
        message: { role: 'user', parts: [{ text: 'who are you ?' }] },
        cwd: '/tmp/project',
        version: '1.0.0',
      },
      {
        uuid: 'assistant-2',
        parentUuid: 'user-2',
        sessionId: 'session-1',
        timestamp: '2025-01-01T00:02:10.000Z',
        type: 'assistant',
        message: { role: 'model', parts: [{ text: 'I am Qwen Code.' }] },
        cwd: '/tmp/project',
        version: '1.0.0',
      },
    ]);
    const sessionService = {
      loadSession: vi.fn().mockResolvedValue(currentSessionData),
    };
    const historyManager = {
      addItem: vi.fn().mockReturnValue(123),
      clearItems: vi.fn(),
      loadHistory: vi.fn(),
      updateItem: vi.fn(),
    };
    const config = {
      getSessionId: () => 'session-1',
      getSessionService: () => sessionService,
      getContentGenerator: () => undefined,
      getDebugLogger: () => ({
        warn: vi.fn(),
      }),
    } as unknown as Config;

    const { result } = renderHook(() =>
      useRewindCommand({
        config,
        historyManager,
        startNewSession: vi.fn(),
        setInputText: vi.fn(),
      }),
    );

    act(() => {
      result.current.handleRewind(entry);
    });

    await act(async () => {
      await result.current.handleRewindAction('summarize_from_here');
    });

    expect(historyManager.addItem).toHaveBeenCalledWith(
      {
        type: 'compression',
        compression: {
          isPending: true,
          originalTokenCount: null,
          newTokenCount: null,
          compressionStatus: null,
        },
      },
      expect.any(Number),
    );
    expect(historyManager.updateItem).toHaveBeenCalledWith(123, {
      type: 'error',
      text: 'Failed to summarize messages from this point.',
      hint: 'Content generator unavailable',
    });
  });

  it('updates the pending summarize item when session data is missing', async () => {
    const entry = createEntry();
    const sessionService = {
      loadSession: vi.fn().mockResolvedValue(undefined),
    };
    const historyManager = {
      addItem: vi.fn().mockReturnValue(123),
      clearItems: vi.fn(),
      loadHistory: vi.fn(),
      updateItem: vi.fn(),
    };
    const config = {
      getSessionId: () => 'session-1',
      getSessionService: () => sessionService,
    } as unknown as Config;

    const { result } = renderHook(() =>
      useRewindCommand({
        config,
        historyManager,
        startNewSession: vi.fn(),
        setInputText: vi.fn(),
      }),
    );

    act(() => {
      result.current.handleRewind(entry);
    });

    await act(async () => {
      await result.current.handleRewindAction('summarize_from_here');
    });

    expect(historyManager.updateItem).toHaveBeenCalledWith(123, {
      type: 'error',
      text: 'Failed to summarize messages from this point.',
      hint: 'Session data unavailable',
    });
  });

  it('updates the pending summarize item when session loading fails', async () => {
    const entry = createEntry();
    const sessionService = {
      loadSession: vi.fn().mockRejectedValue(new Error('storage failed')),
    };
    const historyManager = {
      addItem: vi.fn().mockReturnValue(123),
      clearItems: vi.fn(),
      loadHistory: vi.fn(),
      updateItem: vi.fn(),
    };
    const config = {
      getSessionId: () => 'session-1',
      getSessionService: () => sessionService,
    } as unknown as Config;

    const { result } = renderHook(() =>
      useRewindCommand({
        config,
        historyManager,
        startNewSession: vi.fn(),
        setInputText: vi.fn(),
      }),
    );

    act(() => {
      result.current.handleRewind(entry);
    });

    await act(async () => {
      await result.current.handleRewindAction('summarize_from_here');
    });

    expect(historyManager.updateItem).toHaveBeenCalledWith(123, {
      type: 'error',
      text: 'Failed to summarize messages from this point.',
      hint: 'storage failed',
    });
    expect(historyManager.addItem).toHaveBeenCalledTimes(1);
  });
});
