/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Regression tests for #9833: a /resume or /branch that fails AFTER the
 * client's initialize() replayed the incoming session's stored telemetry
 * must not leave that replay in the process-wide usage aggregate (and must
 * not let the rollback's own re-initialize add a second copy on top).
 *
 * These tests drive the REAL hooks against the REAL GeminiClient and the
 * REAL UiTelemetryService singleton — only the startChat side of the client
 * and the session-service I/O are stubbed — so the assertions observe the
 * actual aggregate the /stats display and persistSessionUsage read.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';

import { useBranchCommand } from './useBranchCommand.js';
import { useResumeCommand } from './useResumeCommand.js';
import type { LoadedSettings } from '../../config/settings.js';

// Replace only SessionService (file I/O); keep GeminiClient and the real
// uiTelemetryService singleton intact.
const sessionServiceMocks = vi.hoisted(() => ({
  sessions: new Map<string, { conversation: unknown }>(),
}));

// Fault injection for the pre-UI-commit "history swap" step: both hooks
// build the resumed history items AFTER the client initialized but BEFORE
// the UI swap commits, and a throw there must roll core (and the usage
// aggregate) back.
const historyUtilsMocks = vi.hoisted(() => ({
  throwOnBuild: { value: false },
}));

vi.mock('../utils/resumeHistoryUtils.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../utils/resumeHistoryUtils.js')>();
  return {
    ...actual,
    buildResumedHistoryItems: vi.fn(
      (...args: Parameters<typeof actual.buildResumedHistoryItems>) => {
        if (historyUtilsMocks.throwOnBuild.value) {
          throw new Error('history swap failed');
        }
        return actual.buildResumedHistoryItems(...args);
      },
    ),
  };
});

vi.mock('@qwen-code/qwen-code-core', async (importOriginal) => {
  const original =
    await importOriginal<typeof import('@qwen-code/qwen-code-core')>();
  class SessionService {
    constructor(_cwd: string) {}
    async loadSession(sessionId: string) {
      return sessionServiceMocks.sessions.get(sessionId);
    }
    getSessionTitle(_sessionId: string) {
      return undefined;
    }
  }
  return {
    ...original,
    SessionService,
  };
});

import {
  GeminiClient,
  uiTelemetryService,
  EVENT_API_RESPONSE,
  type Config,
  type ResumedSessionData,
  type UiEvent,
} from '@qwen-code/qwen-code-core';

const SESSION_A = 'session-A';
const SESSION_B = 'session-B';

const mockSettings = {
  merged: { ui: { history: { collapseOnResume: false } } },
} as unknown as LoadedSettings;

/** A stored api_response telemetry event worth `tokens` prompt tokens. */
function storedApiEvent(tokens: number): UiEvent {
  return {
    'event.name': EVENT_API_RESPONSE,
    'event.timestamp': '2026-08-24T00:00:00.000Z',
    response_id: `resp-${tokens}`,
    model: 'test-model',
    duration_ms: 10,
    input_token_count: tokens,
    output_token_count: 0,
    cached_content_token_count: 0,
    thoughts_token_count: 0,
    total_token_count: tokens,
    prompt_id: SESSION_A,
  } as UiEvent;
}

/** ChatRecord-shaped system record persisting one telemetry event. */
function telemetryRecord(tokens: number) {
  return {
    uuid: `t-${tokens}`,
    parentUuid: null,
    sessionId: SESSION_A,
    type: 'system' as const,
    subtype: 'ui_telemetry',
    timestamp: '2026-08-24T00:00:00.000Z',
    cwd: '/',
    version: 'test',
    systemPayload: { uiEvent: storedApiEvent(tokens) },
  };
}

function userRecord(text: string) {
  return {
    uuid: `u-${text.slice(0, 3)}`,
    parentUuid: null,
    sessionId: SESSION_A,
    type: 'user' as const,
    timestamp: '2026-08-24T00:00:00.000Z',
    cwd: '/',
    version: 'test',
    message: { role: 'user', parts: [{ text }] },
  };
}

/** Conversation whose stored telemetry replays as `tokens` prompt tokens. */
function conversationWith(tokens: number) {
  return {
    sessionId: SESSION_A,
    projectHash: 'project-1',
    startTime: '2026-08-24T00:00:00.000Z',
    lastUpdated: '2026-08-24T00:00:00.000Z',
    messages: [userRecord('hello world'), telemetryRecord(tokens)],
  };
}

function totalRequests(): number {
  return Object.values(uiTelemetryService.getMetrics().models).reduce(
    (sum, m) => sum + m.api.totalRequests,
    0,
  );
}

function promptTokens(): number {
  return Object.values(uiTelemetryService.getMetrics().models).reduce(
    (sum, m) => sum + m.tokens.prompt,
    0,
  );
}

/**
 * A stateful fake Config wired to a REAL GeminiClient. Tracks the live
 * session id + resumed data exactly like Config.startNewSession does, so
 * client.initialize() sees the same facts the hooks set.
 */
function makeFakeEnv() {
  let currentSessionId = SESSION_A;
  let sessionData: ResumedSessionData | undefined;

  const fakeChat = {
    seedResumeTokenCounts: vi.fn(),
    setLastPromptTokenCount: vi.fn(),
  };

  // One shared session-service object: every getSessionService() call sees
  // the same fake, and tests can inspect its mocks afterwards (e.g. derive
  // the fork id from forkSession's call args) (#9844 review).
  const sessionService = {
    forkSession: vi
      .fn()
      .mockImplementation(async (from: string, to: string) => {
        const source = sessionServiceMocks.sessions.get(from);
        if (source) sessionServiceMocks.sessions.set(to, source);
        return { filePath: `/tmp/${to}.jsonl`, copiedCount: 2 };
      }),
    loadSession: async (id: string) => sessionServiceMocks.sessions.get(id),
    getSessionDisplayName: vi.fn().mockResolvedValue(undefined),
    // Realistic like SessionService.removeSession (deletes the fork JSONL):
    // the branch hook calls it in exactly the failure path these tests
    // drive (forkCreated && !uiSwapped), so the fork must not survive in
    // the store afterwards (#9844 review).
    removeSession: vi.fn().mockImplementation(async (id: string) => {
      sessionServiceMocks.sessions.delete(id);
      return true;
    }),
    renameSession: vi.fn().mockResolvedValue(true),
    findSessionTitlesByPrefix: vi.fn().mockResolvedValue([]),
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const config: any = {
    getSessionId: () => currentSessionId,
    getResumedSessionData: () => sessionData,
    getTargetDir: () => '/tmp/project',
    startNewSession: (sessionId?: string, data?: ResumedSessionData) => {
      currentSessionId = sessionId ?? currentSessionId;
      sessionData = data;
      return currentSessionId;
    },
    getChatRecordingService: () => ({
      finalize: vi.fn(),
      flush: vi.fn().mockResolvedValue(undefined),
      rebuildTurnBoundaries: vi.fn(),
      getCurrentCustomTitle: vi.fn().mockReturnValue(undefined),
    }),
    getSessionService: () => sessionService,
    getGoalRuntimeReady: vi.fn().mockResolvedValue({}),
    loadPausedBackgroundAgents: vi.fn().mockResolvedValue([]),
    getBackgroundAgentResumeService: () => ({
      buildRecoveredBackgroundAgentsNotice: () => '',
    }),
    getBackgroundTaskRegistry: () => ({
      hasRunningTasks: () => false,
      getAll: () => [],
      reset: vi.fn(),
    }),
    getMonitorRegistry: () => ({
      getRunning: () => [],
      reset: vi.fn(),
    }),
    getBackgroundShellRegistry: () => ({
      hasRunningEntries: () => false,
      getAll: () => [],
      reset: vi.fn(),
    }),
    getWorkflowRunRegistry: () => ({
      hasRunningEntries: () => false,
      list: () => [],
      reset: vi.fn(),
      abortAll: vi.fn(),
    }),
    getToolRegistry: () => ({
      getTool: () => undefined,
      warmAll: async () => {},
      getDeferredToolSummary: () => ({}),
    }),
    getDebugLogger: () => ({
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      info: vi.fn(),
      isEnabled: () => false,
    }),
  };

  const client = new GeminiClient(config as Config);
  config.getGeminiClient = () => client;
  // initialize() rebuilds the chat through startChat; stub only that side
  // effect so the replay path (the unit under test) stays real.
  vi.spyOn(client, 'startChat').mockImplementation(async function (
    this: GeminiClient,
  ) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (this as any).chat = fakeChat;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return fakeChat as any;
  });

  return { config, client, sessionService };
}

describe('session swap telemetry accounting (#9833)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionServiceMocks.sessions.clear();
    historyUtilsMocks.throwOnBuild.value = false;
    uiTelemetryService.reset();
  });

  /**
   * Process state shared by both scenarios: session A was resumed at
   * process start (its stored history H replayed into the aggregate), then
   * one live turn L happened. This is the state a failed swap must restore.
   */
  async function establishLiveSessionA(historyTokens: number) {
    sessionServiceMocks.sessions.set(SESSION_A, {
      conversation: conversationWith(historyTokens),
    });
    const { config, client, sessionService } = makeFakeEnv();

    // Process-startup resume of A (`qwen --resume`): Config hands the client
    // the resumed session data, then initialize() replays it. Replay is
    // legitimate here and must survive everything that follows.
    config.startNewSession(SESSION_A, {
      conversation: conversationWith(historyTokens),
    });
    await client.initialize();
    // Live usage accrued after startup.
    uiTelemetryService.addEvent(storedApiEvent(5), SESSION_A);
    return { config, client, sessionService };
  }

  it('a failed /branch restores the process-wide aggregate', async () => {
    const { config, sessionService } = await establishLiveSessionA(100);
    const preSwap = structuredClone(uiTelemetryService.getMetrics());
    expect(totalRequests()).toBe(2); // 1 replayed + 1 live

    // Fault after the fork's initialize() replayed, but before the UI swap
    // commits: the branch hook builds the resumed history items in exactly
    // that window. A throw there must roll core (and the aggregate) back.
    historyUtilsMocks.throwOnBuild.value = true;
    const addItem = vi.fn();
    const { result } = renderHook(() =>
      useBranchCommand({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        config: config as any,
        settings: mockSettings,
        historyManager: {
          clearItems: vi.fn(),
          loadHistory: vi.fn(),
          addItem,
        },
        startNewSession: vi.fn(),
        clearPendingState: vi.fn(),
        setSessionName: vi.fn(),
        remount: vi.fn(),
      }),
    );

    await act(async () => {
      await result.current.handleBranch();
    });

    // Guard: the scenario must fail at the injected point (after the fork's
    // replay committed, before the UI swap), not at some earlier step.
    expect(addItem).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining('Failed to branch conversation'),
      }),
      expect.any(Number),
    );

    // The swap failed and core rolled back to A: the aggregate must be
    // exactly what it was before the swap attempt.
    expect(promptTokens()).toBe(preSwap.models['test-model']!.tokens.prompt);
    expect(totalRequests()).toBe(2);
    // The fork's replay-created bucket must be gone; A's bucket intact.
    // Assert on the fork's actual id — the randomUUID() the branch hook
    // derived, swapped core to, and the replay keyed its events by. Derive
    // it from the fork call itself, not post-cleanup store membership:
    // production deletes the fork from the store in this exact failure
    // branch (forkCreated && !uiSwapped → removeSession), and the fake
    // removeSession now does the same, so the fork must NOT survive here
    // (#9844). getMetricsForSession returns fresh empty metrics for ANY
    // unknown id, so deriving a wrong forkId would pass vacuously — the
    // fork-call derivation is the id the replay actually keyed by.
    expect(sessionService.forkSession).toHaveBeenCalledTimes(1);
    const forkId = sessionService.forkSession.mock.calls[0][1];
    expect(typeof forkId).toBe('string');
    expect(uiTelemetryService.getMetricsForSession(forkId).models).toEqual({});
    // Post-cleanup shape: the fork was removed, only the parent remains.
    expect([...sessionServiceMocks.sessions.keys()]).toEqual([SESSION_A]);
    expect(sessionService.removeSession).toHaveBeenCalledWith(forkId);
    expect(
      uiTelemetryService.getMetricsForSession(SESSION_A).models['test-model']
        ?.api.totalRequests,
    ).toBe(2);
  });

  it('a failed /resume restores the process-wide aggregate', async () => {
    const { config } = await establishLiveSessionA(100);
    expect(totalRequests()).toBe(2);

    // Resume target B: same stored history shape, different session id.
    sessionServiceMocks.sessions.set(SESSION_B, {
      conversation: { ...conversationWith(100), sessionId: SESSION_B },
    });
    // The failure window from the report: initialize() succeeds, then the
    // paused-background-agent load rejects.
    config.loadPausedBackgroundAgents = vi
      .fn()
      .mockRejectedValue(new Error('agent load failed'));

    const addItem = vi.fn();
    const { result } = renderHook(() =>
      useResumeCommand({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        config: config as any,
        settings: mockSettings,
        historyManager: {
          addItem,
          clearItems: vi.fn(),
          loadHistory: vi.fn(),
        },
        startNewSession: vi.fn(),
        clearPendingState: vi.fn(),
        setSessionName: vi.fn(),
        remount: vi.fn(),
      }),
    );

    await act(async () => {
      await result.current.handleResume(SESSION_B);
    });

    // Guard: the scenario must fail at the injected point (after the replay
    // committed), not at some earlier setup step.
    expect(config.loadPausedBackgroundAgents).toHaveBeenCalledWith(SESSION_B);
    expect(addItem).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining('Failed to resume session'),
      }),
      expect.any(Number),
    );

    // Rollback put core back on A; the abandoned replay of B's history
    // must not remain in the aggregate.
    expect(totalRequests()).toBe(2);
    expect(promptTokens()).toBe(105);
    expect(uiTelemetryService.getMetricsForSession(SESSION_B).models).toEqual(
      {},
    );
  });

  it('a successful /branch keeps the replayed usage', async () => {
    const { config } = await establishLiveSessionA(100);

    const { result } = renderHook(() =>
      useBranchCommand({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        config: config as any,
        settings: mockSettings,
        historyManager: {
          clearItems: vi.fn(),
          loadHistory: vi.fn(),
          addItem: vi.fn(),
        },
        startNewSession: vi.fn(),
        clearPendingState: vi.fn(),
        setSessionName: vi.fn(),
        remount: vi.fn(),
      }),
    );

    await act(async () => {
      await result.current.handleBranch();
    });

    // Committed swap: the fork's replayed history legitimately stays in the
    // aggregate and in the fork's bucket. Pre-swap is 2 requests (startup
    // replay + live); the fork's single stored event adds one more.
    expect(totalRequests()).toBe(3);
    expect(promptTokens()).toBe(205);
    // A later failed swap of a THIRD session must not undo this commit.
  });

  it('a failure after the UI re-key does not roll back or undo', async () => {
    // Trap (3) from #9833: once the stats provider is re-keyed to the new
    // session, restoring the snapshot (which drops the new session's bucket)
    // would make every usage display render zeros. The commit point is the
    // re-key itself, so a later failure keeps the swap and its usage.
    const { config } = await establishLiveSessionA(100);

    const loadHistory = vi.fn().mockImplementation(() => {
      throw new Error('history items failed after re-key');
    });
    const addItem = vi.fn();
    const { result } = renderHook(() =>
      useBranchCommand({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        config: config as any,
        settings: mockSettings,
        historyManager: {
          clearItems: vi.fn(),
          loadHistory,
          addItem,
        },
        startNewSession: vi.fn(),
        clearPendingState: vi.fn(),
        setSessionName: vi.fn(),
        remount: vi.fn(),
      }),
    );

    await act(async () => {
      await result.current.handleBranch();
    });

    expect(loadHistory).toHaveBeenCalledOnce();
    // The failure surfaces as an error item...
    expect(addItem).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error' }),
      expect.any(Number),
    );
    // ...but the swap stands: core is on the fork, the fork's replay stays
    // in the aggregate, and the fork's bucket is intact for the re-keyed
    // display (nothing restored it away).
    expect(config.getSessionId()).not.toBe(SESSION_A);
    expect(totalRequests()).toBe(3);
    expect(promptTokens()).toBe(205);
    expect(
      uiTelemetryService.getMetricsForSession(config.getSessionId()).models[
        'test-model'
      ]?.api.totalRequests,
    ).toBe(1);
  });

  it('same-session /resume does not disturb the aggregate', async () => {
    const { config } = await establishLiveSessionA(100);
    expect(totalRequests()).toBe(2);

    // Resume the session the user is already on; make the post-initialize
    // step fail so the rollback path runs.
    config.loadPausedBackgroundAgents = vi
      .fn()
      .mockRejectedValue(new Error('agent load failed'));

    const { result } = renderHook(() =>
      useResumeCommand({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        config: config as any,
        settings: mockSettings,
        historyManager: {
          addItem: vi.fn(),
          clearItems: vi.fn(),
          loadHistory: vi.fn(),
        },
        startNewSession: vi.fn(),
        clearPendingState: vi.fn(),
        setSessionName: vi.fn(),
        remount: vi.fn(),
      }),
    );

    await act(async () => {
      await result.current.handleResume(SESSION_A);
    });

    // initialize() early-returns for the same session (no replay decision),
    // so the failed rollback must leave the aggregate untouched.
    expect(totalRequests()).toBe(2);
    expect(promptTokens()).toBe(105);
  });

  it('rejects a concurrent /resume submitted while a swap is in flight', async () => {
    // The session picker fires handleResume fire-and-forget (the dialog
    // closes immediately, the promise is never awaited) and no input gate
    // covers the swap, so a second /resume can be submitted while the first
    // is still in flight. Before the fix the second begin was a ??= no-op
    // and the two swaps entangled the single transaction slot: C committed
    // and cleared the slot, then B's late failure could no longer settle —
    // B's abandoned replay stayed permanently double-counted in the
    // aggregate while core rolled back under C's committed UI (SCENARIO A
    // of the #9844 review). The fix rejects C while B's transaction is
    // open.
    const SESSION_C = 'session-C';
    const { config } = await establishLiveSessionA(100);
    expect(promptTokens()).toBe(105);

    sessionServiceMocks.sessions.set(SESSION_B, {
      conversation: { ...conversationWith(100), sessionId: SESSION_B },
    });
    sessionServiceMocks.sessions.set(SESSION_C, {
      conversation: { ...conversationWith(100), sessionId: SESSION_C },
    });

    // Deterministic interleaving: B's swap hangs on a deferred
    // loadPausedBackgroundAgents AFTER its forward initialize() replay
    // committed (transaction open, aggregate includes B's history), so C
    // can be submitted into exactly that window.
    let failB!: (err: Error) => void;
    config.loadPausedBackgroundAgents = vi.fn((id: string) =>
      id === SESSION_B
        ? new Promise<never>((_resolve, reject) => {
            failB = reject;
          })
        : Promise.resolve([]),
    );

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const renderResume = (addItemMock: any) =>
      renderHook(() =>
        useResumeCommand({
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          config: config as any,
          settings: mockSettings,
          historyManager: {
            addItem: addItemMock,
            clearItems: vi.fn(),
            loadHistory: vi.fn(),
          },
          startNewSession: vi.fn(),
          clearPendingState: vi.fn(),
          setSessionName: vi.fn(),
          remount: vi.fn(),
        }),
      ).result;

    const addItemB = vi.fn();
    const addItemC = vi.fn();
    const resultB = renderResume(addItemB);
    const resultC = renderResume(addItemC);

    // Fire-and-forget B, exactly like the resume dialog fires it.
    let pendingB!: Promise<void>;
    await act(async () => {
      pendingB = resultB.current.handleResume(SESSION_B);
      // Let B reach the deferred loadPausedBackgroundAgents; its replay has
      // committed by then.
      for (let i = 0; i < 100 && totalRequests() < 3; i++) {
        await Promise.resolve();
      }
    });
    expect(totalRequests()).toBe(3); // B's replay is in the aggregate

    // Submit C while B's transaction is open: it must be rejected without
    // replaying anything or touching core's session.
    await act(async () => {
      await resultC.current.handleResume(SESSION_C);
    });
    expect(addItemC).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining('already in progress'),
      }),
      expect.any(Number),
    );
    expect(promptTokens()).toBe(205); // C added nothing
    expect(config.getSessionId()).toBe(SESSION_B); // C swapped nothing

    // Now B fails late: because C never entangled the slot, B's own
    // transaction settles cleanly — the aggregate is restored exactly
    // instead of keeping B's abandoned replay forever (which read 305 with
    // core rolled back under C's committed UI before the fix).
    await act(async () => {
      failB(new Error('late failure'));
      await pendingB;
    });
    expect(addItemB).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining('Failed to resume session'),
      }),
      expect.any(Number),
    );
    expect(config.getSessionId()).toBe(SESSION_A);
    expect(promptTokens()).toBe(105);
    expect(totalRequests()).toBe(2);
    expect(uiTelemetryService.getMetricsForSession(SESSION_B).models).toEqual(
      {},
    );
  });

  it('rejects a /branch submitted while a swap is in flight', async () => {
    // Mirror of the /resume-into-/resume rejection for the branch hook:
    // its rejection throws inside the try, so the catch must skip settling
    // (the slot belongs to the in-flight swap) while still surfacing the
    // failure. Before the fix the catch's unguarded settle committed the
    // in-flight swap's transaction, discarding its armed undo — the later
    // failure then had nothing to restore and the abandoned replay stayed
    // double-counted (#9844).
    const { config } = await establishLiveSessionA(100);
    expect(promptTokens()).toBe(105);

    sessionServiceMocks.sessions.set(SESSION_B, {
      conversation: { ...conversationWith(100), sessionId: SESSION_B },
    });

    // B's swap hangs on a deferred loadPausedBackgroundAgents AFTER its
    // replay committed (transaction open), so /branch lands in exactly
    // that window.
    let failB!: (err: Error) => void;
    config.loadPausedBackgroundAgents = vi.fn((id: string) =>
      id === SESSION_B
        ? new Promise<never>((_resolve, reject) => {
            failB = reject;
          })
        : Promise.resolve([]),
    );

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const renderResume = (addItemMock: any) =>
      renderHook(() =>
        useResumeCommand({
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          config: config as any,
          settings: mockSettings,
          historyManager: {
            addItem: addItemMock,
            clearItems: vi.fn(),
            loadHistory: vi.fn(),
          },
          startNewSession: vi.fn(),
          clearPendingState: vi.fn(),
          setSessionName: vi.fn(),
          remount: vi.fn(),
        }),
      ).result;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const renderBranch = (addItemMock: any) =>
      renderHook(() =>
        useBranchCommand({
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          config: config as any,
          settings: mockSettings,
          historyManager: {
            clearItems: vi.fn(),
            loadHistory: vi.fn(),
            addItem: addItemMock,
          },
          startNewSession: vi.fn(),
          clearPendingState: vi.fn(),
          setSessionName: vi.fn(),
          remount: vi.fn(),
        }),
      ).result;

    const addItemB = vi.fn();
    const resultB = renderResume(addItemB);

    // Fire-and-forget B, exactly like the resume dialog fires it.
    let pendingB!: Promise<void>;
    await act(async () => {
      pendingB = resultB.current.handleResume(SESSION_B);
      for (let i = 0; i < 100 && totalRequests() < 3; i++) {
        await Promise.resolve();
      }
    });
    expect(totalRequests()).toBe(3); // B's replay is in the aggregate

    const addItemBranch = vi.fn();
    const resultBranch = renderBranch(addItemBranch);
    await act(async () => {
      await resultBranch.current.handleBranch();
    });

    // Rejected at the latch before any fork work: error item, no fork
    // created, core untouched — and, the load-bearing bit, the in-flight
    // transaction untouched.
    expect(addItemBranch).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining('already in progress'),
      }),
      expect.any(Number),
    );
    expect(
      [...sessionServiceMocks.sessions.keys()].filter(
        (id) => id !== SESSION_A && id !== SESSION_B,
      ),
    ).toEqual([]); // the rejected attempt created no fork
    expect(config.getSessionId()).toBe(SESSION_B); // branch swapped nothing
    expect(promptTokens()).toBe(205); // branch settled nothing

    // B's later failure still settles through its own transaction.
    await act(async () => {
      failB(new Error('late failure'));
      await pendingB;
    });
    expect(config.getSessionId()).toBe(SESSION_A);
    expect(promptTokens()).toBe(105);
    expect(totalRequests()).toBe(2);
  });

  it('rejects a /resume before its session load when a swap is in flight', async () => {
    // The latch opens BEFORE the outgoing-session capture and the incoming
    // loadSession await: a concurrent attempt is rejected at the latch and
    // its pre-swap work can never settle the in-flight swap's transaction.
    // Before the fix, loadSession ran first, and its failure during an
    // in-flight swap reached the catch's unguarded settle and committed the
    // OTHER swap's transaction (#9844).
    const SESSION_C = 'session-C'; // never stored: loadSession finds nothing
    const { config } = await establishLiveSessionA(100);

    sessionServiceMocks.sessions.set(SESSION_B, {
      conversation: { ...conversationWith(100), sessionId: SESSION_B },
    });

    let failB!: (err: Error) => void;
    config.loadPausedBackgroundAgents = vi.fn((id: string) =>
      id === SESSION_B
        ? new Promise<never>((_resolve, reject) => {
            failB = reject;
          })
        : Promise.resolve([]),
    );

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const renderResume = (addItemMock: any) =>
      renderHook(() =>
        useResumeCommand({
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          config: config as any,
          settings: mockSettings,
          historyManager: {
            addItem: addItemMock,
            clearItems: vi.fn(),
            loadHistory: vi.fn(),
          },
          startNewSession: vi.fn(),
          clearPendingState: vi.fn(),
          setSessionName: vi.fn(),
          remount: vi.fn(),
        }),
      ).result;

    const addItemB = vi.fn();
    const addItemC = vi.fn();
    const resultB = renderResume(addItemB);
    const resultC = renderResume(addItemC);

    let pendingB!: Promise<void>;
    await act(async () => {
      pendingB = resultB.current.handleResume(SESSION_B);
      for (let i = 0; i < 100 && totalRequests() < 3; i++) {
        await Promise.resolve();
      }
    });
    expect(totalRequests()).toBe(3);

    await act(async () => {
      await resultC.current.handleResume(SESSION_C);
    });
    // Rejected at the latch BEFORE loadSession (which would have found
    // nothing and returned silently — the pre-fix shape that then settled
    // B's transaction through the catch's unguarded commit).
    expect(addItemC).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining('already in progress'),
      }),
      expect.any(Number),
    );
    expect(promptTokens()).toBe(205); // C settled nothing

    await act(async () => {
      failB(new Error('late failure'));
      await pendingB;
    });
    expect(config.getSessionId()).toBe(SESSION_A);
    expect(promptTokens()).toBe(105);
    expect(totalRequests()).toBe(2);
  });

  it('resuming a missing session frees the swap slot for the next swap', async () => {
    // The latch now opens BEFORE the incoming session is loaded, so the
    // missing-session early return must settle the transaction it opened;
    // forgetting that would leave the single slot occupied and every later
    // swap rejected (#9844).
    const { config } = await establishLiveSessionA(100);

    const addItem = vi.fn();
    const { result } = renderHook(() =>
      useResumeCommand({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        config: config as any,
        settings: mockSettings,
        historyManager: {
          addItem,
          clearItems: vi.fn(),
          loadHistory: vi.fn(),
        },
        startNewSession: vi.fn(),
        clearPendingState: vi.fn(),
        setSessionName: vi.fn(),
        remount: vi.fn(),
      }),
    );

    await act(async () => {
      await result.current.handleResume('missing-session');
    });
    // Silent no-op, as before — no session, no error.
    expect(addItem).not.toHaveBeenCalled();
    expect(config.getSessionId()).toBe(SESSION_A);

    sessionServiceMocks.sessions.set(SESSION_B, {
      conversation: { ...conversationWith(100), sessionId: SESSION_B },
    });
    await act(async () => {
      await result.current.handleResume(SESSION_B);
    });
    // The second swap ran (was not rejected by a stuck slot) and committed.
    expect(config.getSessionId()).toBe(SESSION_B);
    expect(promptTokens()).toBe(205);
  });

  it('an undo committed by an earlier swap is never restored later', async () => {
    // Trap (2) from #9833: the undo's lifetime is one swap transaction, not
    // the process. A snapshot taken by an EARLIER (committed) swap — or by
    // the startup resume — must never be what a LATER failed swap restores.
    const { config } = await establishLiveSessionA(100);
    expect(promptTokens()).toBe(105);

    sessionServiceMocks.sessions.set(SESSION_B, {
      conversation: { ...conversationWith(100), sessionId: SESSION_B },
    });

    const { result } = renderHook(() =>
      useResumeCommand({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        config: config as any,
        settings: mockSettings,
        historyManager: {
          addItem: vi.fn(),
          clearItems: vi.fn(),
          loadHistory: vi.fn(),
        },
        startNewSession: vi.fn(),
        clearPendingState: vi.fn(),
        setSessionName: vi.fn(),
        remount: vi.fn(),
      }),
    );

    // First swap succeeds and commits: its replay now belongs to the session
    // the user is on.
    await act(async () => {
      await result.current.handleResume(SESSION_B);
    });
    expect(promptTokens()).toBe(205); // startup 100 + live 5 + committed 100

    // Second swap fails after initialize(): the restore point is pre-SECOND-
    // swap (205), never the first swap's snapshot (105) or pre-startup (0).
    const SESSION_C = 'session-C';
    sessionServiceMocks.sessions.set(SESSION_C, {
      conversation: { ...conversationWith(100), sessionId: SESSION_C },
    });
    config.loadPausedBackgroundAgents = vi
      .fn()
      .mockRejectedValue(new Error('agent load failed'));

    await act(async () => {
      await result.current.handleResume(SESSION_C);
    });

    expect(promptTokens()).toBe(205);
  });
});
