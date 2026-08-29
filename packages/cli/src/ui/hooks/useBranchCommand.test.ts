/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useBranchCommand } from './useBranchCommand.js';
import { makeSwapSlotClient } from '../../test-utils/mock-swap-slot-client.js';
import type { LoadedSettings } from '../../config/settings.js';

const mockSettings = {
  merged: { ui: { history: { collapseOnResume: false } } },
} as unknown as LoadedSettings;

describe('useBranchCommand', () => {
  let forkSession: ReturnType<typeof vi.fn>;
  let loadSession: ReturnType<typeof vi.fn>;
  let removeSession: ReturnType<typeof vi.fn>;
  let renameSession: ReturnType<typeof vi.fn>;
  let finalize: ReturnType<typeof vi.fn>;
  let flush: ReturnType<typeof vi.fn>;
  let getCurrentCustomTitle: ReturnType<typeof vi.fn>;
  let getSessionDisplayName: ReturnType<typeof vi.fn>;
  let startNewSessionConfig: ReturnType<typeof vi.fn>;
  let getGoalRuntimeReady: ReturnType<typeof vi.fn>;
  let startNewSessionUI: ReturnType<typeof vi.fn>;
  let clearPendingState: ReturnType<typeof vi.fn>;
  let findSessionTitlesByPrefix: ReturnType<typeof vi.fn>;
  let clearItems: ReturnType<typeof vi.fn>;
  let loadHistory: ReturnType<typeof vi.fn>;
  let setSessionName: ReturnType<typeof vi.fn>;
  let remount: ReturnType<typeof vi.fn>;
  let addItem: ReturnType<typeof vi.fn>;
  let backgroundTaskRegistry: {
    hasRunningTasks: ReturnType<typeof vi.fn>;
    getAll: ReturnType<typeof vi.fn>;
    reset: ReturnType<typeof vi.fn>;
  };
  let monitorRegistry: {
    getRunning: ReturnType<typeof vi.fn>;
    reset: ReturnType<typeof vi.fn>;
  };
  let backgroundShellRegistry: {
    hasRunningEntries: ReturnType<typeof vi.fn>;
    getAll: ReturnType<typeof vi.fn>;
    reset: ReturnType<typeof vi.fn>;
  };
  let workflowRunRegistry: {
    hasRunningEntries: ReturnType<typeof vi.fn>;
    list: ReturnType<typeof vi.fn>;
    reset: ReturnType<typeof vi.fn>;
    abortAll: ReturnType<typeof vi.fn>;
  };
  // Mock Config shape covers only what useBranchCommand touches.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let config: any;

  const makeOptions = () => ({
    config,
    settings: mockSettings,
    historyManager: { clearItems, loadHistory, addItem },
    startNewSession: startNewSessionUI,
    clearPendingState,
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
    removeSession = vi.fn().mockResolvedValue(true);
    renameSession = vi.fn().mockResolvedValue(true);
    loadSession = vi.fn().mockResolvedValue({
      conversation: {
        messages: [userRecord('help me fix the login bug')],
      },
      filePath: '/tmp/new.jsonl',
      lastCompletedUuid: 'u2',
    });
    finalize = vi.fn();
    flush = vi.fn().mockResolvedValue(undefined);
    getCurrentCustomTitle = vi.fn().mockReturnValue(undefined);
    getSessionDisplayName = vi.fn().mockResolvedValue(undefined);
    findSessionTitlesByPrefix = vi.fn().mockResolvedValue([]);
    startNewSessionConfig = vi.fn();
    getGoalRuntimeReady = vi.fn().mockResolvedValue({});
    startNewSessionUI = vi.fn();
    clearPendingState = vi.fn();
    clearItems = vi.fn();
    loadHistory = vi.fn();
    setSessionName = vi.fn();
    remount = vi.fn();
    addItem = vi.fn();
    backgroundTaskRegistry = {
      hasRunningTasks: vi.fn().mockReturnValue(false),
      getAll: vi.fn().mockReturnValue([]),
      reset: vi.fn(),
    };
    monitorRegistry = {
      getRunning: vi.fn().mockReturnValue([]),
      reset: vi.fn(),
    };
    backgroundShellRegistry = {
      hasRunningEntries: vi.fn().mockReturnValue(false),
      getAll: vi.fn().mockReturnValue([]),
      reset: vi.fn(),
    };
    workflowRunRegistry = {
      hasRunningEntries: vi.fn().mockReturnValue(false),
      list: vi.fn().mockReturnValue([]),
      reset: vi.fn(),
      abortAll: vi.fn(),
    };
    config = {
      getSessionId: () => '12345678-aaaa-bbbb-cccc-dddddddddddd',
      getSessionService: () => ({
        forkSession,
        loadSession,
        removeSession,
        renameSession,
        findSessionTitlesByPrefix,
        getSessionDisplayName,
      }),
      getChatRecordingService: () => ({
        finalize,
        flush,
        getCurrentCustomTitle,
      }),
      getLlmClient: () => ({ initialize: vi.fn() }),
      getBackgroundTaskRegistry: () => backgroundTaskRegistry,
      getMonitorRegistry: () => monitorRegistry,
      getBackgroundShellRegistry: () => backgroundShellRegistry,
      getWorkflowRunRegistry: () => workflowRunRegistry,
      startNewSession: startNewSessionConfig,
      getGoalRuntimeReady,
      getDebugLogger: () => ({ warn: vi.fn() }),
    };
  });

  it('refuses to branch while background work is running', async () => {
    backgroundTaskRegistry.hasRunningTasks.mockReturnValue(true);
    backgroundTaskRegistry.getAll.mockReturnValue([
      {
        agentId: 'bg_ab12cd34',
        isBackgrounded: true,
        status: 'running',
        description: 'long-running research',
        startTime: Date.now(),
      },
    ]);

    const { result } = renderHook(() => useBranchCommand(makeOptions()));
    await act(async () => {
      await result.current.handleBranch('blocked');
    });

    expect(finalize).not.toHaveBeenCalled();
    expect(forkSession).not.toHaveBeenCalled();
    expect(startNewSessionConfig).not.toHaveBeenCalled();
    expect(addItem).toHaveBeenCalledTimes(1);
    const blockedItem = addItem.mock.calls[0]?.[0] as {
      type: string;
      text: string;
    };
    expect(blockedItem.type).toBe('error');
    expect(blockedItem.text).toContain('running background tasks');
    expect(blockedItem.text).toContain('[bg_ab12cd34]');
  });

  it('clears terminal background state after the branch initializes', async () => {
    const { result } = renderHook(() => useBranchCommand(makeOptions()));
    await act(async () => {
      await result.current.handleBranch('ready');
    });

    expect(backgroundTaskRegistry.reset).toHaveBeenCalledOnce();
    expect(monitorRegistry.reset).toHaveBeenCalledOnce();
    expect(backgroundShellRegistry.reset).toHaveBeenCalledOnce();
    expect(workflowRunRegistry.reset).toHaveBeenCalledOnce();
    expect(clearPendingState).toHaveBeenCalledOnce();
    expect(clearPendingState.mock.invocationCallOrder[0]).toBeLessThan(
      loadHistory.mock.invocationCallOrder[0]!,
    );
    expect(startNewSessionUI.mock.invocationCallOrder[0]).toBeLessThan(
      backgroundTaskRegistry.reset.mock.invocationCallOrder[0]!,
    );
  });

  it('persists and reloads the title before switching core or UI', async () => {
    // The parent snapshot must come AFTER finalize(): finalize() appends a
    // trailing custom_title record to the parent JSONL, advancing the
    // recorder's lastCompletedUuid. A snapshot taken before that captures
    // a stale tail; on rollback the restored recorder would chain its next
    // record's parentUuid to a record that's no longer the JSONL tail,
    // orphaning the custom_title record from the parent chain.
    const order: string[] = [];
    finalize.mockImplementation(() => order.push('finalize'));
    flush.mockImplementation(async () => {
      order.push('flush');
    });
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
    renameSession.mockImplementation(async () => {
      order.push('rename');
      return true;
    });
    startNewSessionConfig.mockImplementation(() => order.push('config.start'));
    getGoalRuntimeReady.mockImplementation(async () => {
      order.push('goal.ready');
      return {};
    });

    const { result } = renderHook(() => useBranchCommand(makeOptions()));
    await act(async () => {
      await result.current.handleBranch('my-branch');
    });

    expect(order).toEqual([
      'finalize',
      'flush',
      'load', // parent snapshot for rollback (after finalize so it captures the custom_title append)
      'fork',
      'load', // provisional fork load
      'rename',
      'load', // final load after title persistence
      'config.start',
      'goal.ready',
    ]);
  });

  it('starts the forked recorder from the post-title JSONL tail', async () => {
    const parent = {
      conversation: { messages: [userRecord('parent msg')] },
      filePath: '/tmp/parent.jsonl',
      lastCompletedUuid: 'parent-tail',
    };
    const provisional = {
      conversation: { messages: [userRecord('parent msg')] },
      filePath: '/tmp/new.jsonl',
      lastCompletedUuid: 'fork-tail',
    };
    const titled = {
      ...provisional,
      lastCompletedUuid: 'title-tail',
    };
    loadSession
      .mockResolvedValueOnce(parent)
      .mockResolvedValueOnce(provisional)
      .mockResolvedValueOnce(titled);

    const { result } = renderHook(() => useBranchCommand(makeOptions()));
    await act(async () => {
      await result.current.handleBranch('my-branch');
    });

    expect(startNewSessionConfig).toHaveBeenCalledWith(
      expect.any(String),
      titled,
    );
  });

  it('waits for the forked session Goal runtime exactly once', async () => {
    const { result } = renderHook(() => useBranchCommand(makeOptions()));
    await act(async () => {
      await result.current.handleBranch('my-branch');
    });
    expect(getGoalRuntimeReady).toHaveBeenCalledTimes(1);
  });

  it('rolls core back when the fork contains malformed Goal state', async () => {
    getGoalRuntimeReady.mockRejectedValueOnce(
      new Error('unsupported Goal lifecycle record'),
    );

    const { result } = renderHook(() => useBranchCommand(makeOptions()));
    await act(async () => {
      await result.current.handleBranch('my-branch');
    });

    expect(startNewSessionConfig).toHaveBeenCalledTimes(2);
    expect(startNewSessionUI).not.toHaveBeenCalled();
    expect(clearItems).not.toHaveBeenCalled();
    expect(loadHistory).not.toHaveBeenCalled();
    expect(removeSession).toHaveBeenCalledTimes(1);
    expect(addItem).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'error',
        text: expect.stringMatching(/unsupported Goal lifecycle record/),
      }),
      expect.any(Number),
    );
  });

  it('records the user-provided name with a numeric suffix', async () => {
    const { result } = renderHook(() => useBranchCommand(makeOptions()));
    await act(async () => {
      await result.current.handleBranch('my-branch');
    });
    expect(renameSession).toHaveBeenCalledWith(
      expect.any(String),
      'my-branch(1)',
      'manual',
    );
    expect(setSessionName).toHaveBeenCalledWith('my-branch(1)');
  });

  it('increments the suffix when the default name is already taken', async () => {
    // `findSessionTitlesByPrefix` returns every existing title under the
    // `${name}(` prefix in one shot, so the bump logic picks the
    // first free slot in memory — no per-candidate disk probe.
    findSessionTitlesByPrefix.mockResolvedValue(['my-branch(1)']);

    const { result } = renderHook(() => useBranchCommand(makeOptions()));
    await act(async () => {
      await result.current.handleBranch('my-branch');
    });
    expect(renameSession).toHaveBeenCalledWith(
      expect.any(String),
      'my-branch(2)',
      'manual',
    );
    expect(setSessionName).toHaveBeenCalledWith('my-branch(2)');
  });

  it('does ONE prefix scan even when many numeric slots are taken', async () => {
    // Pin the perf invariant: regardless of collision density, the
    // collision lookup must be a single project-wide scan, not N probes.
    // Reviewer's concern was that 99 sequential probes can stall /branch
    // on dense title spaces.
    findSessionTitlesByPrefix.mockResolvedValue([
      'my-branch(1)',
      'my-branch(2)',
      'my-branch(3)',
      'my-branch(4)',
    ]);

    const { result } = renderHook(() => useBranchCommand(makeOptions()));
    await act(async () => {
      await result.current.handleBranch('my-branch');
    });

    expect(findSessionTitlesByPrefix).toHaveBeenCalledTimes(1);
    expect(findSessionTitlesByPrefix).toHaveBeenCalledWith('my-branch(');
    expect(renameSession).toHaveBeenCalledWith(
      expect.any(String),
      'my-branch(5)',
      'manual',
    );
  });

  it('derives the base title from the first user ChatRecord when no name is given', async () => {
    const { result } = renderHook(() => useBranchCommand(makeOptions()));
    await act(async () => {
      await result.current.handleBranch();
    });
    // deriveFirstPrompt collapses whitespace and truncates to 100 chars;
    // "help me fix the login bug" fits, then + "(1)"
    expect(renameSession).toHaveBeenCalledWith(
      expect.any(String),
      'help me fix the login bug(1)',
      'auto',
    );
  });

  it('prefers the source custom title when no name is given', async () => {
    getCurrentCustomTitle.mockReturnValue('My Project');

    const { result } = renderHook(() => useBranchCommand(makeOptions()));
    await act(async () => {
      await result.current.handleBranch();
    });

    expect(renameSession).toHaveBeenCalledWith(
      expect.any(String),
      'My Project(1)',
      'auto',
    );
  });

  it.each([
    ['My Project(2)', 'My Project(1)'],
    ['My Project (Branch)', 'My Project(1)'],
    ['My Project (Branch 2)', 'My Project(1)'],
    ['My Project (2)', 'My Project (2)(1)'],
    ['(Branch)', 'help me fix the login bug(1)'],
    ['(Branch 2)', 'help me fix the login bug(1)'],
  ])(
    'normalizes the derived source title %s',
    async (sourceTitle, expectedTitle) => {
      getCurrentCustomTitle.mockReturnValue(sourceTitle);

      const { result } = renderHook(() => useBranchCommand(makeOptions()));
      await act(async () => {
        await result.current.handleBranch();
      });

      expect(renameSession).toHaveBeenCalledWith(
        expect.any(String),
        expectedTitle,
        'auto',
      );
    },
  );

  it('uses the picker display name for an untitled source session', async () => {
    const pickerDisplayName = `Error: first line\n${'x'.repeat(120)}`;
    getSessionDisplayName.mockResolvedValue(pickerDisplayName);

    const { result } = renderHook(() => useBranchCommand(makeOptions()));
    await act(async () => {
      await result.current.handleBranch();
    });

    expect(getSessionDisplayName).toHaveBeenCalledWith(
      '12345678-aaaa-bbbb-cccc-dddddddddddd',
    );
    expect(renameSession).toHaveBeenCalledWith(
      expect.any(String),
      `${pickerDisplayName}(1)`,
      'auto',
    );
  });

  it.each(['', '   '])(
    'falls back to the first prompt when the picker display name is blank (%j)',
    async (blankDisplayName) => {
      getSessionDisplayName.mockResolvedValue(blankDisplayName);

      const { result } = renderHook(() => useBranchCommand(makeOptions()));
      await act(async () => {
        await result.current.handleBranch();
      });

      expect(renameSession).toHaveBeenCalledWith(
        expect.any(String),
        'help me fix the login bug(1)',
        'auto',
      );
    },
  );

  it('preserves a numeric token in an explicit branch name', async () => {
    const { result } = renderHook(() => useBranchCommand(makeOptions()));
    await act(async () => {
      await result.current.handleBranch('Roadmap (2026)');
    });

    expect(renameSession).toHaveBeenCalledWith(
      expect.any(String),
      'Roadmap (2026)(1)',
      'manual',
    );
  });

  it('falls back to "Branched conversation(1)" when the transcript has no user records', async () => {
    loadSession.mockResolvedValue({
      conversation: { messages: [] },
      filePath: '/tmp/new.jsonl',
      lastCompletedUuid: null,
    });
    const { result } = renderHook(() => useBranchCommand(makeOptions()));
    await act(async () => {
      await result.current.handleBranch();
    });
    expect(renameSession).toHaveBeenCalledWith(
      expect.any(String),
      'Branched conversation(1)',
      'auto',
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
    expect(renameSession).toHaveBeenCalledWith(
      expect.any(String),
      'what does this codebase do(1)',
      'auto',
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

  it('initializes LlmClient with SessionStartSource.Branch', async () => {
    const initialize = vi.fn().mockResolvedValue(undefined);
    config.getLlmClient = () => ({ initialize });

    const { result } = renderHook(() => useBranchCommand(makeOptions()));
    await act(async () => {
      await result.current.handleBranch('my-branch');
    });

    expect(initialize).toHaveBeenCalledTimes(1);
    expect(initialize).toHaveBeenCalledWith('branch');
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

  it('does not create a fork when the source recording cannot flush', async () => {
    flush.mockRejectedValue(new Error('recording failed'));

    const { result } = renderHook(() => useBranchCommand(makeOptions()));
    await act(async () => {
      await result.current.handleBranch('x');
    });

    expect(forkSession).not.toHaveBeenCalled();
    expect(renameSession).not.toHaveBeenCalled();
    expect(startNewSessionConfig).not.toHaveBeenCalled();
    expect(startNewSessionUI).not.toHaveBeenCalled();
  });

  it('does not create a fork when source finalization throws', async () => {
    finalize.mockImplementation(() => {
      throw new Error('finalize failed');
    });

    const { result } = renderHook(() => useBranchCommand(makeOptions()));
    await act(async () => {
      await result.current.handleBranch('x');
    });

    expect(flush).not.toHaveBeenCalled();
    expect(forkSession).not.toHaveBeenCalled();
    expect(startNewSessionConfig).not.toHaveBeenCalled();
    expect(startNewSessionUI).not.toHaveBeenCalled();
  });

  it('rejects the branch when another session switch holds the swap latch', async () => {
    // Another /resume or /branch holds the single telemetry-swap slot, so
    // beginTelemetrySwap returns false. The hook must surface the error,
    // create no fork, and settle NOTHING: the slot belongs to the in-flight
    // swap — committing or aborting it here would discard that swap's armed
    // undo and reintroduce the #9833 double-count (#9844). The latch also
    // runs BEFORE any outgoing-session work, so nothing is finalized or
    // forked on a rejection.
    const beginTelemetrySwap = vi.fn().mockReturnValue(false);
    const commitTelemetrySwap = vi.fn();
    const abortTelemetrySwap = vi.fn();
    config.getLlmClient = () => ({
      initialize: vi.fn(),
      beginTelemetrySwap,
      commitTelemetrySwap,
      abortTelemetrySwap,
    });

    const { result } = renderHook(() => useBranchCommand(makeOptions()));
    await act(async () => {
      await result.current.handleBranch('x');
    });

    expect(beginTelemetrySwap).toHaveBeenCalledTimes(1);
    expect(finalize).not.toHaveBeenCalled();
    expect(forkSession).not.toHaveBeenCalled();
    expect(removeSession).not.toHaveBeenCalled();
    expect(startNewSessionConfig).not.toHaveBeenCalled();
    expect(startNewSessionUI).not.toHaveBeenCalled();
    expect(commitTelemetrySwap).not.toHaveBeenCalled();
    expect(abortTelemetrySwap).not.toHaveBeenCalled();
    expect(addItem).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'error',
        text: expect.stringContaining('already in progress'),
      }),
      expect.any(Number),
    );
  });

  it('settles the swap slot when the branch fails before the core swap', async () => {
    // The latch opened in step 0 means this attempt owns the slot even when
    // the pre-core-swap work (flush / fork / title persistence) fails. The
    // catch must settle that transaction so the next swap is not rejected
    // with "already in progress" (#9844). The default client mock
    // ({ initialize: vi.fn() }) has no commitTelemetrySwap, so the settle
    // there is an optional-chained no-op — observe the release through a
    // stateful slot fake instead.
    forkSession.mockRejectedValue(new Error('disk full'));
    const llmClient = makeSwapSlotClient();
    config.getLlmClient = () => llmClient;

    const { result } = renderHook(() => useBranchCommand(makeOptions()));
    await act(async () => {
      await result.current.handleBranch('x');
    });

    // The failure surfaced before any core/UI swap...
    expect(startNewSessionConfig).not.toHaveBeenCalled();
    expect(startNewSessionUI).not.toHaveBeenCalled();
    expect(addItem).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'error',
        text: expect.stringMatching(/Failed to branch conversation.*disk full/),
      }),
      expect.any(Number),
    );
    // ...and the catch settled (committed, never aborted) the transaction
    // this attempt opened.
    expect(llmClient.commitTelemetrySwap).toHaveBeenCalledTimes(1);
    expect(llmClient.abortTelemetrySwap).not.toHaveBeenCalled();

    // The released slot admits the next attempt: the retry is NOT rejected
    // with "already in progress" and completes the full swap.
    forkSession.mockResolvedValue({
      filePath: '/tmp/new.jsonl',
      copiedCount: 2,
    });
    await act(async () => {
      await result.current.handleBranch('x');
    });
    expect(llmClient.beginTelemetrySwap).toHaveBeenCalledTimes(2);
    expect(addItem).not.toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining('already in progress'),
      }),
      expect.any(Number),
    );
    expect(startNewSessionConfig).toHaveBeenCalledTimes(1);
    expect(startNewSessionUI).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['returns false', () => renameSession.mockResolvedValue(false)],
    [
      'throws',
      () => renameSession.mockRejectedValue(new Error('title write failed')),
    ],
  ])(
    'removes the fork and leaves the parent active when title persistence %s',
    async (_label, arrange) => {
      arrange();

      const { result } = renderHook(() => useBranchCommand(makeOptions()));
      await act(async () => {
        await result.current.handleBranch('x');
      });

      expect(removeSession).toHaveBeenCalledTimes(1);
      expect(startNewSessionConfig).not.toHaveBeenCalled();
      expect(startNewSessionUI).not.toHaveBeenCalled();
      expect(setSessionName).not.toHaveBeenCalled();
    },
  );

  it('removes the fork when the final post-title reload fails', async () => {
    const loaded = {
      conversation: { messages: [userRecord('parent msg')] },
      filePath: '/tmp/new.jsonl',
      lastCompletedUuid: 'u2',
    };
    loadSession
      .mockResolvedValueOnce(loaded) // parent rollback snapshot
      .mockResolvedValueOnce(loaded) // provisional fork
      .mockResolvedValueOnce(undefined); // final titled fork

    const { result } = renderHook(() => useBranchCommand(makeOptions()));
    await act(async () => {
      await result.current.handleBranch('x');
    });

    expect(renameSession).toHaveBeenCalledTimes(1);
    expect(removeSession).toHaveBeenCalledTimes(1);
    expect(startNewSessionConfig).not.toHaveBeenCalled();
    expect(startNewSessionUI).not.toHaveBeenCalled();
  });

  it('rolls core back to the parent session when getLlmClient().initialize() rejects after swap', async () => {
    // The reviewer's scenario: config.startNewSession succeeds (core is now
    // on the fork), but then getLlmClient().initialize() rejects. Without
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
    // The parent is loaded once for rollback. The fork is loaded before and
    // after its title append so the live recorder starts at the true tail.
    loadSession.mockImplementation(async (sid: string) =>
      sid === oldSessionId ? parentResumed : forkResumed,
    );

    const llmClient = makeSwapSlotClient();
    llmClient.initialize
      .mockRejectedValueOnce(new Error('init boom')) // fork init fails
      .mockResolvedValueOnce(undefined); // rollback re-init succeeds
    config.getLlmClient = () => llmClient;

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
    expect(llmClient.initialize).toHaveBeenCalledTimes(2);
    // The rollback aborted the transaction this attempt opened — never
    // committed it. The true return is safe to assert here: initialize ran
    // during the open transaction, so the real client armed an undo and
    // also returns true — unlike the open-but-unarmed shape, which the
    // slot fake over-approximates (#9844 review; see
    // mock-swap-slot-client.ts).
    expect(llmClient.abortTelemetrySwap).toHaveBeenCalledTimes(1);
    expect(llmClient.abortTelemetrySwap).toHaveReturnedWith(true);
    expect(llmClient.commitTelemetrySwap).not.toHaveBeenCalled();
    // UI never switched — no cleared history, no UI sessionId swap.
    expect(clearItems).not.toHaveBeenCalled();
    expect(loadHistory).not.toHaveBeenCalled();
    expect(startNewSessionUI).not.toHaveBeenCalled();
    expect(setSessionName).not.toHaveBeenCalled();
    expect(removeSession).toHaveBeenCalledTimes(1);
    expect(backgroundTaskRegistry.reset).not.toHaveBeenCalled();
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
    config.getLlmClient = () => ({ initialize });

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
    expect(removeSession).toHaveBeenCalledTimes(1);
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

  it('does not roll core back to parent when a post-UI-swap step throws', async () => {
    // The reviewer's reverse split-brain: once the UI commits to the branch,
    // any subsequent failure (hook fire, remount,
    // announcement render) must NOT trigger the catch block's core rollback.
    // If it did, the user would see the branch UI but every new prompt
    // would be recorded into the parent's JSONL.
    //
    // Pin the invariant by making remount() — which runs after the UI swap —
    // throw, then assert: only ONE config.startNewSession call (to the
    // branch), no second call resetting it back to the parent.
    const oldSessionId = '12345678-aaaa-bbbb-cccc-dddddddddddd';
    remount.mockImplementation(() => {
      throw new Error('remount boom');
    });

    const { result } = renderHook(() => useBranchCommand(makeOptions()));
    await act(async () => {
      await result.current.handleBranch('x');
    });

    // UI did swap.
    expect(startNewSessionUI).toHaveBeenCalledTimes(1);
    expect(clearItems).toHaveBeenCalled();
    expect(loadHistory).toHaveBeenCalled();
    // Core did NOT roll back to the parent — only the initial swap to
    // the branch. A second call with `oldSessionId` would mean the catch
    // block reverted core while UI stayed on the branch.
    expect(startNewSessionConfig).toHaveBeenCalledTimes(1);
    expect(startNewSessionConfig).not.toHaveBeenCalledWith(
      oldSessionId,
      expect.anything(),
    );
    // The user still sees the failure surfaced as an error item.
    expect(addItem).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'error',
        text: expect.stringMatching(
          /Failed to branch conversation.*remount boom/,
        ),
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
    expect(removeSession).toHaveBeenCalledTimes(1);
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

  it('applies collapse policy when collapseOnResume is true', async () => {
    const settingsWithCollapse = {
      merged: { ui: { history: { collapseOnResume: true } } },
    } as unknown as LoadedSettings;

    const { result } = renderHook(() =>
      useBranchCommand({
        ...makeOptions(),
        settings: settingsWithCollapse,
      }),
    );
    await act(async () => {
      await result.current.handleBranch('my-branch');
    });

    // loadHistory should have been called with items that include
    // suppressOnRestore and a collapse-summary item.
    expect(loadHistory).toHaveBeenCalledTimes(1);
    const loadedItems = loadHistory.mock.calls[0][0];
    expect(loadedItems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          display: expect.objectContaining({ suppressOnRestore: true }),
        }),
        expect.objectContaining({
          display: expect.objectContaining({ kind: 'collapse-summary' }),
        }),
      ]),
    );
  });
});
