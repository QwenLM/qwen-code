/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { SessionStartSource } from '@qwen-code/qwen-code-core';
import { useBranchCommand } from './useBranchCommand.js';

describe('useBranchCommand', () => {
  let forkSession: ReturnType<typeof vi.fn>;
  let loadSession: ReturnType<typeof vi.fn>;
  let finalize: ReturnType<typeof vi.fn>;
  let startNewSessionConfig: ReturnType<typeof vi.fn>;
  let startNewSessionUI: ReturnType<typeof vi.fn>;
  let recordCustomTitle: ReturnType<typeof vi.fn>;
  let findSessionsByTitle: ReturnType<typeof vi.fn>;
  let fireSessionStartEvent: ReturnType<typeof vi.fn>;
  let clearItems: ReturnType<typeof vi.fn>;
  let loadHistory: ReturnType<typeof vi.fn>;
  let setSessionName: ReturnType<typeof vi.fn>;
  let remount: ReturnType<typeof vi.fn>;
  let addItem: ReturnType<typeof vi.fn>;
  // Mock Config shape covers only what useBranchCommand touches.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let config: any;

  const makeOptions = () => ({
    config,
    historyManager: { clearItems, loadHistory, addItem },
    startNewSession: startNewSessionUI,
    setSessionName,
    remount,
  });

  // Helper to build a ChatRecord-shaped user message for loadSession mocks.
  // Keeps intent explicit at each call site (genuine user msg vs. synthetic
  // subtype vs. non-text) without pulling in the full ChatRecord type here.
  const userRecord = (text: string, subtype?: string) => ({
    uuid: 'u' + text.slice(0, 3),
    parentUuid: null,
    sessionId: 'sid',
    type: 'user' as const,
    ...(subtype ? { subtype } : {}),
    timestamp: 't',
    cwd: '/',
    version: 'v',
    message: { role: 'user', parts: [{ text }] },
  });

  beforeEach(() => {
    forkSession = vi
      .fn()
      .mockResolvedValue({ filePath: '/tmp/new.jsonl', copiedCount: 2 });
    loadSession = vi.fn().mockResolvedValue({
      conversation: {
        messages: [userRecord('help me fix the login bug')],
      },
      filePath: '/tmp/new.jsonl',
      lastCompletedUuid: 'u2',
    });
    finalize = vi.fn();
    recordCustomTitle = vi.fn().mockReturnValue(true);
    findSessionsByTitle = vi.fn().mockResolvedValue([]);
    fireSessionStartEvent = vi.fn();
    startNewSessionConfig = vi.fn();
    startNewSessionUI = vi.fn();
    clearItems = vi.fn();
    loadHistory = vi.fn();
    setSessionName = vi.fn();
    remount = vi.fn();
    addItem = vi.fn();
    config = {
      getSessionId: () => '12345678-aaaa-bbbb-cccc-dddddddddddd',
      getSessionService: () => ({
        forkSession,
        loadSession,
        findSessionsByTitle,
      }),
      getChatRecordingService: () => ({ finalize, recordCustomTitle }),
      getGeminiClient: () => ({ initialize: vi.fn() }),
      getHookSystem: () => ({ fireSessionStartEvent }),
      startNewSession: startNewSessionConfig,
      getModel: () => 'test-model',
      getApprovalMode: () => 'default',
      getDebugLogger: () => ({ warn: vi.fn() }),
    };
  });

  it('runs snapshot → finalize → forkSession → loadSession → config.startNewSession in order', async () => {
    // The leading snapshot load (of the parent session) exists so the catch
    // block can roll core back to the parent with the correct parentUuid
    // chain tail if getGeminiClient().initialize() rejects after the swap.
    const order: string[] = [];
    finalize.mockImplementation(() => order.push('finalize'));
    forkSession.mockImplementation(async () => {
      order.push('fork');
      return { filePath: '/tmp/new.jsonl', copiedCount: 2 };
    });
    loadSession.mockImplementation(async () => {
      order.push('load');
      return {
        conversation: { messages: [] },
        filePath: '/tmp/new.jsonl',
        lastCompletedUuid: 'u',
      };
    });
    startNewSessionConfig.mockImplementation(() => order.push('config.start'));

    const { result } = renderHook(() => useBranchCommand(makeOptions()));
    await act(async () => {
      await result.current.handleBranch('my-branch');
    });

    expect(order).toEqual([
      'load', // parent snapshot for rollback
      'finalize',
      'fork',
      'load', // forked session
      'config.start',
    ]);
  });

  it('records the user-provided name with a (Branch) suffix', async () => {
    const { result } = renderHook(() => useBranchCommand(makeOptions()));
    await act(async () => {
      await result.current.handleBranch('my-branch');
    });
    expect(recordCustomTitle).toHaveBeenCalledWith('my-branch (Branch)');
    expect(setSessionName).toHaveBeenCalledWith('my-branch (Branch)');
  });

  it('bumps to (Branch N) when the default suffix is already taken', async () => {
    findSessionsByTitle.mockImplementation(async (title: string) => {
      if (title === 'my-branch (Branch)') {
        return [{ sessionId: 'other', customTitle: title } as unknown];
      }
      return [];
    });

    const { result } = renderHook(() => useBranchCommand(makeOptions()));
    await act(async () => {
      await result.current.handleBranch('my-branch');
    });
    expect(recordCustomTitle).toHaveBeenCalledWith('my-branch (Branch 2)');
    expect(setSessionName).toHaveBeenCalledWith('my-branch (Branch 2)');
  });

  it('derives the base title from the first user ChatRecord when no name is given', async () => {
    const { result } = renderHook(() => useBranchCommand(makeOptions()));
    await act(async () => {
      await result.current.handleBranch();
    });
    // deriveFirstPrompt collapses whitespace and truncates to 100 chars;
    // "help me fix the login bug" fits, then + " (Branch)"
    expect(recordCustomTitle).toHaveBeenCalledWith(
      'help me fix the login bug (Branch)',
    );
  });

  it('falls back to "Branched conversation (Branch)" when the transcript has no user records', async () => {
    loadSession.mockResolvedValue({
      conversation: { messages: [] },
      filePath: '/tmp/new.jsonl',
      lastCompletedUuid: null,
    });
    const { result } = renderHook(() => useBranchCommand(makeOptions()));
    await act(async () => {
      await result.current.handleBranch();
    });
    expect(recordCustomTitle).toHaveBeenCalledWith(
      'Branched conversation (Branch)',
    );
  });

  it('skips synthetic user-role records (cron, notification, etc.) and picks the first real prompt', async () => {
    loadSession.mockResolvedValue({
      conversation: {
        messages: [
          userRecord('scheduled task ran', 'cron'),
          userRecord('agent finished X', 'notification'),
          userRecord('what does this codebase do'),
        ],
      },
      filePath: '/tmp/new.jsonl',
      lastCompletedUuid: null,
    });

    const { result } = renderHook(() => useBranchCommand(makeOptions()));
    await act(async () => {
      await result.current.handleBranch();
    });
    expect(recordCustomTitle).toHaveBeenCalledWith(
      'what does this codebase do (Branch)',
    );
  });

  it('emits the Claude-style success pair naming the branch and the resume hint with the old sessionId', async () => {
    const { result } = renderHook(() => useBranchCommand(makeOptions()));
    await act(async () => {
      await result.current.handleBranch('my-branch');
    });

    expect(addItem).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'info',
        text: 'Branched conversation "my-branch". You are now in the branch.',
      }),
      expect.any(Number),
    );
    expect(addItem).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'info',
        text: 'To resume the original: /resume 12345678-aaaa-bbbb-cccc-dddddddddddd',
      }),
      expect.any(Number),
    );
  });

  it('fires SessionStart with SessionStartSource.Branch (not Resume)', async () => {
    const { result } = renderHook(() => useBranchCommand(makeOptions()));
    await act(async () => {
      await result.current.handleBranch('my-branch');
    });
    expect(fireSessionStartEvent).toHaveBeenCalledTimes(1);
    expect(fireSessionStartEvent).toHaveBeenCalledWith(
      SessionStartSource.Branch,
      expect.any(String),
      expect.any(String),
    );
  });

  it('omits the quoted-title fragment when no name is provided', async () => {
    const { result } = renderHook(() => useBranchCommand(makeOptions()));
    await act(async () => {
      await result.current.handleBranch();
    });
    expect(addItem).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'info',
        text: 'Branched conversation. You are now in the branch.',
      }),
      expect.any(Number),
    );
  });

  it('surfaces an error item and does not switch sessions when forkSession throws', async () => {
    forkSession.mockRejectedValue(new Error('disk full'));

    const { result } = renderHook(() => useBranchCommand(makeOptions()));
    await act(async () => {
      await result.current.handleBranch('x');
    });

    expect(startNewSessionConfig).not.toHaveBeenCalled();
    expect(addItem).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'error',
        text: expect.stringMatching(/Failed to branch conversation.*disk full/),
      }),
      expect.any(Number),
    );
  });

  it('rolls core back to the parent session when getGeminiClient().initialize() rejects after swap', async () => {
    // The reviewer's scenario: config.startNewSession succeeds (core is now
    // on the fork), but then getGeminiClient().initialize() rejects. Without
    // rollback, core stays on the fork while UI is still on the parent, so
    // the recorder silently writes subsequent user input into an orphan
    // JSONL. This test pins the rollback invariant — after the failure core
    // must be back on the parent sessionId with the parent's ResumedSessionData.
    const oldSessionId = '12345678-aaaa-bbbb-cccc-dddddddddddd';
    const parentResumed = {
      conversation: { messages: [userRecord('parent msg')] },
      filePath: `/tmp/${oldSessionId}.jsonl`,
      lastCompletedUuid: 'uparent',
    };
    const forkResumed = {
      conversation: { messages: [userRecord('parent msg')] },
      filePath: '/tmp/new.jsonl',
      lastCompletedUuid: 'uparent',
    };
    // Called twice: once up front to snapshot the parent for rollback,
    // once after forkSession to load the fork.
    loadSession.mockImplementation(async (sid: string) =>
      sid === oldSessionId ? parentResumed : forkResumed,
    );

    const initialize = vi
      .fn()
      .mockRejectedValueOnce(new Error('init boom')) // fork init fails
      .mockResolvedValueOnce(undefined); // rollback re-init succeeds
    config.getGeminiClient = () => ({ initialize });

    const { result } = renderHook(() => useBranchCommand(makeOptions()));
    await act(async () => {
      await result.current.handleBranch('x');
    });

    // Core was swapped to the fork, then rolled back to the parent.
    expect(startNewSessionConfig).toHaveBeenNthCalledWith(
      1,
      expect.not.stringMatching(oldSessionId),
      forkResumed,
    );
    expect(startNewSessionConfig).toHaveBeenNthCalledWith(
      2,
      oldSessionId,
      parentResumed,
    );
    // Client was re-initialized after rollback so chat history re-hydrates
    // against the parent session.
    expect(initialize).toHaveBeenCalledTimes(2);
    // UI never switched — no cleared history, no UI sessionId swap.
    expect(clearItems).not.toHaveBeenCalled();
    expect(loadHistory).not.toHaveBeenCalled();
    expect(startNewSessionUI).not.toHaveBeenCalled();
    expect(setSessionName).not.toHaveBeenCalled();
    // User sees the failure.
    expect(addItem).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'error',
        text: expect.stringMatching(/Failed to branch conversation.*init boom/),
      }),
      expect.any(Number),
    );
  });

  it('still surfaces the error and leaves core on the parent when rollback re-init also throws', async () => {
    // If the rollback initialize() itself rejects, the swap of sessionId +
    // recorder has still happened — that is the load-bearing invariant —
    // so we just log and surface the original failure without crashing.
    const oldSessionId = '12345678-aaaa-bbbb-cccc-dddddddddddd';
    loadSession.mockResolvedValue({
      conversation: { messages: [userRecord('parent msg')] },
      filePath: '/tmp/new.jsonl',
      lastCompletedUuid: 'u2',
    });
    const debugWarn = vi.fn();
    config.getDebugLogger = () => ({ warn: debugWarn });

    const initialize = vi
      .fn()
      .mockRejectedValueOnce(new Error('init boom'))
      .mockRejectedValueOnce(new Error('rollback boom'));
    config.getGeminiClient = () => ({ initialize });

    const { result } = renderHook(() => useBranchCommand(makeOptions()));
    await act(async () => {
      await result.current.handleBranch('x');
    });

    // Core was still rolled back to the parent sessionId.
    expect(startNewSessionConfig).toHaveBeenNthCalledWith(
      2,
      oldSessionId,
      expect.any(Object),
    );
    expect(debugWarn).toHaveBeenCalledWith(
      expect.stringContaining('Rollback after failed /branch init failed'),
    );
    // Original failure is what the user sees, not the rollback failure.
    expect(addItem).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'error',
        text: expect.stringMatching(/Failed to branch conversation.*init boom/),
      }),
      expect.any(Number),
    );
  });

  it('does not clear or swap the UI when core startNewSession throws post-fork', async () => {
    // Guards the "swap core first" invariant: if core swap fails after the
    // disk fork succeeds, the UI must stay on the parent — no cleared
    // history, no new UI sessionId — so the user is not stranded.
    startNewSessionConfig.mockImplementation(() => {
      throw new Error('core boom');
    });

    const { result } = renderHook(() => useBranchCommand(makeOptions()));
    await act(async () => {
      await result.current.handleBranch('x');
    });

    expect(forkSession).toHaveBeenCalledTimes(1);
    expect(clearItems).not.toHaveBeenCalled();
    expect(loadHistory).not.toHaveBeenCalled();
    expect(startNewSessionUI).not.toHaveBeenCalled();
    expect(addItem).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'error',
        text: expect.stringMatching(/Failed to branch conversation.*core boom/),
      }),
      expect.any(Number),
    );
  });
});
