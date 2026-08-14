import { describe, expect, it, vi } from 'vitest';
import {
  DaemonHttpError,
  type DaemonCapabilities,
  type DaemonSessionClient,
} from '@qwen-code/sdk/daemon';
import {
  createDaemonSessionActions,
  getConnectionAfterSessionClear,
  resolveSessionRestoreTimeouts,
} from './actions';
import type {
  ActivePrompt,
  DaemonConnectionState,
  PendingSessionLoad,
  SettledPrompt,
} from './types';

describe('getConnectionAfterSessionClear', () => {
  it('clears session fields for the session being detached', () => {
    const next = getConnectionAfterSessionClear(
      {
        status: 'disconnected',
        workspaceCwd: '/workspace',
        sessionId: 'session-a',
        clientId: 'client-a',
        displayName: 'Session A',
        tokenCount: 42,
        commands: [commandInfo('old-command')],
        skills: ['old-skill'],
        supportedCommands: supportedCommandsStatus('session-a'),
        context: contextStatus('session-a'),
        loadingTranscript: true,
        catchingUp: true,
        error: 'old error',
        errorStatus: 404,
        missingSession: true,
      } as DaemonConnectionState,
      'session-a',
    );

    expect(next).toMatchObject({
      status: 'connected',
      workspaceCwd: '/workspace',
      loadingTranscript: undefined,
      catchingUp: undefined,
      error: undefined,
      errorStatus: undefined,
      missingSession: false,
    });
    expect(next).not.toHaveProperty('sessionId');
    expect(next).not.toHaveProperty('clientId');
    expect(next).not.toHaveProperty('displayName');
    expect(next).not.toHaveProperty('tokenCount');
    expect(next).not.toHaveProperty('supportedCommands');
    expect(next).not.toHaveProperty('context');
    // Workspace-scoped slash commands and skills survive a clear so skill-backed
    // commands (e.g. /review) keep autocompleting in the fresh deferred session
    // before its first prompt creates a session (mirrors #6153 / #6066).
    expect(next.commands).toEqual([commandInfo('old-command')]);
    expect(next.skills).toEqual(['old-skill']);
  });

  it('handles commands and skills being undefined before clear', () => {
    // Optional fields: clearing before the first available_commands_update
    // (open the app, immediately start a new chat) leaves them absent. The
    // delete calls are harmless no-ops and nothing is fabricated.
    const next = getConnectionAfterSessionClear(
      {
        status: 'disconnected',
        workspaceCwd: '/workspace',
        sessionId: 'session-a',
        clientId: 'client-a',
        supportedCommands: supportedCommandsStatus('session-a'),
        context: contextStatus('session-a'),
      } as DaemonConnectionState,
      'session-a',
    );

    expect(next).toMatchObject({
      status: 'connected',
      workspaceCwd: '/workspace',
    });
    expect(next).not.toHaveProperty('sessionId');
    expect(next).not.toHaveProperty('commands');
    expect(next).not.toHaveProperty('skills');
    expect(next).not.toHaveProperty('supportedCommands');
    expect(next).not.toHaveProperty('context');
  });

  it('preserves a concurrently loaded session', () => {
    const next = getConnectionAfterSessionClear(
      {
        status: 'connecting',
        workspaceCwd: '/workspace',
        sessionId: 'session-b',
        clientId: 'client-b',
        displayName: 'Session B',
        tokenCount: 7,
        commands: [commandInfo('new-command')],
        skills: ['new-skill'],
        supportedCommands: supportedCommandsStatus('session-b', 'new-command'),
        context: contextStatus('session-b'),
        loadingTranscript: true,
        catchingUp: true,
        error: 'old error',
      } as DaemonConnectionState,
      'session-a',
    );

    expect(next).toMatchObject({
      status: 'connected',
      workspaceCwd: '/workspace',
      sessionId: 'session-b',
      clientId: 'client-b',
      displayName: 'Session B',
      tokenCount: 7,
      commands: [commandInfo('new-command')],
      skills: ['new-skill'],
      supportedCommands: supportedCommandsStatus('session-b', 'new-command'),
      context: contextStatus('session-b'),
      loadingTranscript: undefined,
      catchingUp: undefined,
      error: undefined,
    });
  });
});

/**
 * A capabilities payload advertising a restore budget. Typed rather than cast
 * so renaming or moving `limits.sessionRestoreTimeoutMs` fails typecheck here
 * instead of silently falling back to the client defaults.
 */
function advertisingRestoreBudget(
  sessionRestoreTimeoutMs: number,
): DaemonCapabilities {
  return {
    v: 1,
    mode: 'http-bridge',
    features: [],
    modelServices: [],
    limits: { sessionRestoreTimeoutMs },
  };
}

describe('resolveSessionRestoreTimeouts', () => {
  it('uses 70s request and 75s watchdog defaults for old daemons', () => {
    expect(resolveSessionRestoreTimeouts(undefined)).toEqual({
      requestTimeoutMs: 70_000,
      watchdogTimeoutMs: 75_000,
    });
  });

  it('derives both client budgets from the advertised server timeout', () => {
    expect(
      resolveSessionRestoreTimeouts(advertisingRestoreBudget(90_000)),
    ).toEqual({
      requestTimeoutMs: 100_000,
      watchdogTimeoutMs: 105_000,
    });
  });

  it('disables derived timers that exceed the JavaScript timer ceiling', () => {
    expect(
      resolveSessionRestoreTimeouts(advertisingRestoreBudget(2_147_483_647)),
    ).toEqual({ requestTimeoutMs: 0, watchdogTimeoutMs: undefined });
  });
});

describe('createDaemonSessionActions', () => {
  it('creates from the active session client when the connection matches', async () => {
    const existingSession = createMockSession('session-a');
    const nextSession = createMockSession('session-b');
    existingSession.client.createOrAttachSession.mockResolvedValue(nextSession);
    const createDetachedSession = vi.fn();
    const { actions } = createActionsHarness({
      connection: { status: 'connected', sessionId: 'session-a' },
      createDetachedSession,
      session: existingSession,
    });

    await expect(actions.createSession()).resolves.toBe(nextSession);

    expect(existingSession.client.createOrAttachSession).toHaveBeenCalledOnce();
    expect(createDetachedSession).not.toHaveBeenCalled();
  });

  it('creates a detached session when no active session exists', async () => {
    const nextSession = createMockSession('session-b');
    const createDetachedSession = vi.fn(async () => nextSession);
    const { actions, sessionRef, getConnection } = createActionsHarness({
      connection: { status: 'connected' },
      createDetachedSession,
    });

    await expect(actions.createSession()).resolves.toBe(nextSession);

    expect(createDetachedSession).toHaveBeenCalledOnce();
    expect(sessionRef.current).toBe(nextSession);
    expect(getConnection()).toMatchObject({ sessionId: 'session-b' });
  });

  it('forwards options.workspaceCwd to the detached create branch', async () => {
    const nextSession = createMockSession('session-b');
    const createDetachedSession = vi.fn(async () => nextSession);
    const { actions } = createActionsHarness({
      connection: { status: 'connected' },
      createDetachedSession,
    });

    await actions.createSession({ workspaceCwd: '/ws/secondary' });

    expect(createDetachedSession).toHaveBeenCalledWith('/ws/secondary', {});
  });

  it('omits the workspaceCwd override on the detached branch by default', async () => {
    const nextSession = createMockSession('session-b');
    const createDetachedSession = vi.fn(async () => nextSession);
    const { actions } = createActionsHarness({
      connection: { status: 'connected' },
      createDetachedSession,
    });

    await actions.createSession();

    expect(createDetachedSession).toHaveBeenCalledWith(undefined, {});
  });

  it('forwards options.approvalMode to the detached create branch', async () => {
    const nextSession = createMockSession('session-b');
    const createDetachedSession = vi.fn(async () => nextSession);
    const { actions } = createActionsHarness({
      connection: { status: 'connected' },
      createDetachedSession,
    });

    await actions.createSession({ approvalMode: 'yolo' });

    expect(createDetachedSession).toHaveBeenCalledWith(undefined, {
      approvalMode: 'yolo',
    });
  });

  it('forwards options.sourceType to the detached create branch', async () => {
    const nextSession = createMockSession('session-b');
    const createDetachedSession = vi.fn(async () => nextSession);
    const { actions } = createActionsHarness({
      connection: { status: 'connected' },
      createDetachedSession,
    });

    await actions.createSession({ sourceType: 'default' });

    expect(createDetachedSession).toHaveBeenCalledWith(undefined, {
      sourceType: 'default',
    });
  });

  it('merges options.workspaceCwd into the active session request', async () => {
    const existingSession = createMockSession('session-a');
    const nextSession = createMockSession('session-b');
    existingSession.client.createOrAttachSession.mockResolvedValue(nextSession);
    const { actions } = createActionsHarness({
      connection: { status: 'connected', sessionId: 'session-a' },
      session: existingSession,
    });

    await actions.createSession({ workspaceCwd: '/ws/secondary' });

    expect(existingSession.client.createOrAttachSession).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceCwd: '/ws/secondary' }),
    );
  });

  it('folds options.approvalMode into the active session request', async () => {
    const existingSession = createMockSession('session-a');
    const nextSession = createMockSession('session-b');
    existingSession.client.createOrAttachSession.mockResolvedValue(nextSession);
    const { actions } = createActionsHarness({
      connection: { status: 'connected', sessionId: 'session-a' },
      session: existingSession,
    });

    await actions.createSession({ approvalMode: 'yolo' });

    expect(existingSession.client.createOrAttachSession).toHaveBeenCalledWith(
      expect.objectContaining({ approvalMode: 'yolo' }),
    );
  });

  it('folds options.sourceType into the active session request', async () => {
    const existingSession = createMockSession('session-a');
    const nextSession = createMockSession('session-b');
    existingSession.client.createOrAttachSession.mockResolvedValue(nextSession);
    const { actions } = createActionsHarness({
      connection: { status: 'connected', sessionId: 'session-a' },
      session: existingSession,
    });

    await actions.createSession({ sourceType: 'default' });

    expect(existingSession.client.createOrAttachSession).toHaveBeenCalledWith(
      expect.objectContaining({ sourceType: 'default' }),
    );
  });

  it('does not restore a detached session after the session was cleared', async () => {
    const nextSession = createMockSession('session-b');
    const deferred = createDeferred<DaemonSessionClient>();
    const manualSessionClearRef = { current: false };
    const createDetachedSession = vi.fn(() => deferred.promise);
    const { actions, sessionRef, getConnection } = createActionsHarness({
      connection: { status: 'connected' },
      createDetachedSession,
      manualSessionClearRef,
    });

    const createPromise = actions.createSession();
    manualSessionClearRef.current = true;
    deferred.resolve(nextSession as unknown as DaemonSessionClient);

    await expect(createPromise).rejects.toMatchObject({
      name: 'AbortError',
      message: 'Session creation interrupted',
    });
    expect(nextSession.detach).toHaveBeenCalledOnce();
    expect(sessionRef.current).toBeUndefined();
    expect(getConnection()).not.toHaveProperty('sessionId');
  });

  it('clears the active session while a session switch is loading', async () => {
    const existingSession = createMockSession('session-a');
    const { actions, getConnection, pendingSessionLoadRef, sessionRef } =
      createActionsHarness({
        connection: { status: 'connected', sessionId: 'session-a' },
        session: existingSession,
      });

    void actions.loadSession('session-b').catch(() => undefined);

    expect(existingSession.detach).toHaveBeenCalledOnce();
    expect(existingSession.cancel).not.toHaveBeenCalled();
    expect(existingSession.submitPrompt).not.toHaveBeenCalled();
    expect(sessionRef.current).toBeUndefined();
    expect(getConnection()).toMatchObject({
      status: 'connecting',
      sessionId: 'session-b',
      loadingTranscript: true,
      catchingUp: undefined,
    });
    expect(pendingSessionLoadRef.current).toMatchObject({
      sessionId: 'session-b',
      requestTimeoutMs: 70_000,
    });
  });

  it('carries the daemon-advertised restore budget into the load request', async () => {
    // Live path for the whole chain: advertised capability -> connection ->
    // resolveSessionRestoreTimeouts -> pending load. Dropping the capabilities
    // argument at the real call site leaves every default-budget assertion
    // green, so this is the only test that fails when the advertised budget
    // stops reaching the SDK.
    const existingSession = createMockSession('session-a');
    const { actions, pendingSessionLoadRef } = createActionsHarness({
      connection: {
        status: 'connected',
        sessionId: 'session-a',
        capabilities: advertisingRestoreBudget(90_000),
      },
      session: existingSession,
    });

    void actions.loadSession('session-b').catch(() => undefined);

    expect(pendingSessionLoadRef.current).toMatchObject({
      sessionId: 'session-b',
      requestTimeoutMs: 100_000,
    });
  });

  it('detaches the old same-session attachment after its replacement loads', async () => {
    const existingSession = createMockSession('session-a');
    const { actions, getConnection, pendingSessionLoadRef, sessionRef, store } =
      createActionsHarness({
        connection: { status: 'connected', sessionId: 'session-a' },
        session: existingSession,
      });

    const loadPromise = actions.loadSession('session-a');

    expect(existingSession.detach).not.toHaveBeenCalled();
    expect(sessionRef.current).toBe(existingSession);
    expect(store.reset).not.toHaveBeenCalled();
    expect(getConnection()).toEqual({
      status: 'connected',
      sessionId: 'session-a',
    });

    const pendingLoad = pendingSessionLoadRef.current;
    pendingSessionLoadRef.current = undefined;
    clearTimeout(pendingLoad?.timeout);
    pendingLoad?.resolve();
    await loadPromise;
    expect(existingSession.detach).toHaveBeenCalledOnce();
  });

  it('clears the transcript when the same session id changes workspace', async () => {
    const existingSession = createMockSession('session-a');
    existingSession.workspaceCwd = '/work/a';
    const { actions, getConnection, pendingSessionLoadRef, sessionRef, store } =
      createActionsHarness({
        connection: {
          status: 'connected',
          sessionId: 'session-a',
          workspaceCwd: '/work/a',
        },
        session: existingSession,
      });

    const loadPromise = actions.loadSession('session-a', {
      workspaceCwd: '/work/b',
    });

    expect(existingSession.detach).toHaveBeenCalledOnce();
    expect(sessionRef.current).toBeUndefined();
    expect(store.reset).toHaveBeenCalledOnce();
    expect(getConnection()).toMatchObject({
      status: 'connecting',
      sessionId: 'session-a',
      workspaceCwd: '/work/b',
      loadingTranscript: true,
    });

    const pendingLoad = pendingSessionLoadRef.current;
    pendingSessionLoadRef.current = undefined;
    clearTimeout(pendingLoad?.timeout);
    pendingLoad?.resolve();
    await loadPromise;
  });

  it('keeps the old same-session attachment when its replacement fails', async () => {
    const existingSession = createMockSession('session-a');
    const { actions, pendingSessionLoadRef, sessionRef } = createActionsHarness(
      {
        connection: { status: 'connected', sessionId: 'session-a' },
        session: existingSession,
      },
    );

    const loadPromise = actions.loadSession('session-a');
    const pendingLoad = pendingSessionLoadRef.current;
    pendingSessionLoadRef.current = undefined;
    clearTimeout(pendingLoad?.timeout);
    pendingLoad?.reject(new Error('load failed'));

    await expect(loadPromise).rejects.toThrow('load failed');
    expect(existingSession.detach).not.toHaveBeenCalled();
    expect(sessionRef.current).toBe(existingSession);
  });

  it('does not start a session reload with an aborted signal', async () => {
    const existingSession = createMockSession('session-a');
    const { actions, pendingSessionLoadRef, sessionRef, store } =
      createActionsHarness({
        connection: { status: 'connected', sessionId: 'session-a' },
        session: existingSession,
      });
    const controller = new AbortController();
    controller.abort();

    await expect(
      actions.reloadSession(controller.signal),
    ).rejects.toMatchObject({ name: 'AbortError' });

    expect(pendingSessionLoadRef.current).toBeUndefined();
    expect(sessionRef.current).toBe(existingSession);
    expect(existingSession.detach).not.toHaveBeenCalled();
    expect(store.reset).not.toHaveBeenCalled();
  });

  it('keeps the reload abort signal with the pending load', () => {
    const controller = new AbortController();
    const clearLiveJournalRepair = vi.fn();
    const { actions, pendingSessionLoadRef } = createActionsHarness({
      clearLiveJournalRepair,
      connection: { status: 'connected', sessionId: 'session-a' },
      session: createMockSession('session-a'),
    });

    void actions
      .reloadSession(controller.signal, { replaySource: 'memory' })
      .catch(() => undefined);

    expect(pendingSessionLoadRef.current?.signal).toBe(controller.signal);
    expect(pendingSessionLoadRef.current?.replaySource).toBe('memory');
    expect(clearLiveJournalRepair).not.toHaveBeenCalled();
    clearTimeout(pendingSessionLoadRef.current?.timeout);
    pendingSessionLoadRef.current?.reject(
      new DOMException('Test cleanup', 'AbortError'),
    );
    pendingSessionLoadRef.current = undefined;
  });

  it('clears live journal repair state for a configured reload', () => {
    const controller = new AbortController();
    const clearLiveJournalRepair = vi.fn();
    const { actions, pendingSessionLoadRef } = createActionsHarness({
      clearLiveJournalRepair,
      connection: { status: 'connected', sessionId: 'session-a' },
      session: createMockSession('session-a'),
    });

    void actions.reloadSession(controller.signal).catch(() => undefined);

    expect(clearLiveJournalRepair).toHaveBeenCalledOnce();
    clearTimeout(pendingSessionLoadRef.current?.timeout);
    pendingSessionLoadRef.current?.reject(
      new DOMException('Test cleanup', 'AbortError'),
    );
    pendingSessionLoadRef.current = undefined;
  });

  it('keeps the active workspace when a session load omits one', () => {
    const setRestoreWorkspaceCwd = vi.fn();
    const { actions } = createActionsHarness({
      connection: {
        status: 'connected',
        workspaceCwd: '/workspace/secondary',
      },
      setRestoreWorkspaceCwd,
    });

    void actions.loadSession('session-b').catch(() => undefined);

    expect(setRestoreWorkspaceCwd).toHaveBeenCalledWith('/workspace/secondary');
  });

  it('does not inherit a failed load target workspace on the next switch', async () => {
    const existingSession = createMockSession('session-a');
    existingSession.workspaceCwd = '/work/a';
    const setRestoreWorkspaceCwd = vi.fn();
    const { actions, getConnection, pendingSessionLoadRef } =
      createActionsHarness({
        connection: {
          status: 'connected',
          sessionId: 'session-a',
          workspaceCwd: '/work/a',
        },
        session: existingSession,
        setRestoreWorkspaceCwd,
      });

    const first = actions.loadSession('session-b', {
      workspaceCwd: '/work/b',
    });
    expect(getConnection()).toMatchObject({
      status: 'connecting',
      sessionId: 'session-b',
      workspaceCwd: '/work/b',
      loadingTranscript: true,
    });

    const pendingLoad = pendingSessionLoadRef.current;
    pendingSessionLoadRef.current = undefined;
    clearTimeout(pendingLoad?.timeout);
    pendingLoad?.reject(new Error('load failed'));

    await expect(first).rejects.toThrow('load failed');
    // The failed target stays visible for the error state...
    expect(getConnection()).toMatchObject({
      sessionId: 'session-b',
      workspaceCwd: '/work/b',
      error: 'load failed',
    });

    // ...but the next workspace-less switch must not inherit it.
    void actions.loadSession('session-c');
    expect(setRestoreWorkspaceCwd).toHaveBeenLastCalledWith(undefined);
  });

  it('does not roll back the workspace for a superseded load', async () => {
    const existingSession = createMockSession('session-a');
    existingSession.workspaceCwd = '/work/a';
    const { actions, getConnection, pendingSessionLoadRef } =
      createActionsHarness({
        connection: {
          status: 'connected',
          sessionId: 'session-a',
          workspaceCwd: '/work/a',
        },
        session: existingSession,
      });

    const first = actions.loadSession('session-b', { workspaceCwd: '/work/b' });
    const second = actions.loadSession('session-c', {
      workspaceCwd: '/work/c',
    });

    // The first load was superseded; its rejection must not roll the
    // workspace back over the second load's connecting state.
    await expect(first).rejects.toMatchObject({ name: 'AbortError' });
    expect(getConnection()).toMatchObject({
      status: 'connecting',
      sessionId: 'session-c',
      workspaceCwd: '/work/c',
    });

    const pendingLoad = pendingSessionLoadRef.current;
    pendingSessionLoadRef.current = undefined;
    clearTimeout(pendingLoad?.timeout);
    pendingLoad?.resolve();
    await second;
  });

  it('forwards the workspace when resuming a session', () => {
    const setRestoreWorkspaceCwd = vi.fn();
    const { actions } = createActionsHarness({
      connection: { status: 'connected', workspaceCwd: '/workspace/primary' },
      setRestoreWorkspaceCwd,
    });

    void actions
      .resumeSession('session-b', { workspaceCwd: '/workspace/secondary' })
      .catch(() => undefined);

    expect(setRestoreWorkspaceCwd).toHaveBeenCalledWith('/workspace/secondary');
  });

  it('clears transcript loading when a session switch fails', async () => {
    vi.useFakeTimers();
    try {
      const existingSession = createMockSession('session-a');
      const manualSessionClearRef = { current: false };
      const setRestoreSessionId = vi.fn();
      const { actions, getConnection } = createActionsHarness({
        connection: { status: 'connected', sessionId: 'session-a' },
        manualSessionClearRef,
        session: existingSession,
        setRestoreSessionId,
      });

      const loadPromise = actions.loadSession('session-b');
      expect(getConnection()).toMatchObject({
        status: 'connecting',
        sessionId: 'session-b',
        loadingTranscript: true,
      });

      // Split the boundary so a shorter watchdog cannot pass this test.
      let settledEarly = false;
      void loadPromise.catch(() => {
        settledEarly = true;
      });
      await vi.advanceTimersByTimeAsync(74_999);
      expect(settledEarly).toBe(false);
      await vi.advanceTimersByTimeAsync(1);

      await expect(loadPromise).rejects.toThrow('Session load timed out');
      expect(getConnection()).toMatchObject({
        status: 'disconnected',
        sessionId: undefined,
        loadingTranscript: undefined,
        catchingUp: undefined,
      });
      expect(manualSessionClearRef.current).toBe(true);
      expect(setRestoreSessionId).toHaveBeenLastCalledWith(undefined);
    } finally {
      vi.useRealTimers();
    }
  });

  it('creates a detached session when the ref and connection do not match', async () => {
    const existingSession = createMockSession('session-a');
    const nextSession = createMockSession('session-b');
    const createDetachedSession = vi.fn(async () => nextSession);
    const { actions } = createActionsHarness({
      connection: { status: 'connected', sessionId: 'session-other' },
      createDetachedSession,
      session: existingSession,
    });

    await expect(actions.createSession()).resolves.toBe(nextSession);

    expect(existingSession.client.createOrAttachSession).not.toHaveBeenCalled();
    expect(createDetachedSession).toHaveBeenCalledOnce();
  });

  it('starts an attach session load and bumps the attach nonce', async () => {
    const session = createMockSession('session-a');
    const setAttachSessionNonce = vi.fn();
    const { actions, pendingSessionLoadRef } = createActionsHarness({
      session,
      setAttachSessionNonce,
    });

    const attachPromise = actions.attachSession();

    expect(pendingSessionLoadRef.current).toMatchObject({
      id: 1,
      sessionId: 'session-a',
      mode: 'attach',
    });
    expect(pendingSessionLoadRef.current?.requestTimeoutMs).toBeUndefined();
    expect(setAttachSessionNonce).toHaveBeenCalledOnce();
    const nonceUpdater = setAttachSessionNonce.mock.calls[0]?.[0];
    expect(typeof nonceUpdater).toBe('function');
    expect(nonceUpdater?.(1)).toBe(2);

    clearTimeout(pendingSessionLoadRef.current?.timeout);
    pendingSessionLoadRef.current?.resolve();
    await expect(attachPromise).resolves.toBeUndefined();
  });

  it('reports attach timeouts as attach session failures', async () => {
    vi.useFakeTimers();
    try {
      const session = createMockSession('session-a');
      const addNotice = vi.fn((notice) => notice);
      const { actions } = createActionsHarness({
        addNotice,
        session,
      });

      const attachPromise = actions.attachSession();
      vi.advanceTimersByTime(30_000);

      await expect(attachPromise).rejects.toThrow('Session attach timed out');
      expect(addNotice).toHaveBeenCalledWith(
        expect.objectContaining({
          code: 'daemon.attach_session.failed',
          operation: 'attach_session',
        }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects attachSession when no session exists', async () => {
    const { actions } = createActionsHarness();

    await expect(actions.attachSession()).rejects.toThrow(
      'Daemon session is not connected',
    );
  });

  it('reports getTasks failures by default', async () => {
    const session = createMockSession('session-a');
    const addNotice = vi.fn((notice) => notice);
    session.tasks.mockRejectedValueOnce(new Error('Failed to fetch'));
    const { actions } = createActionsHarness({ addNotice, session });

    await expect(actions.getTasks()).rejects.toThrow('Failed to fetch');

    expect(addNotice).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'daemon.load_tasks.failed',
        message: 'Get tasks failed: Failed to fetch',
        operation: 'load_tasks',
      }),
    );
  });

  it('suppresses notices for silent transient getTasks failures', async () => {
    const session = createMockSession('session-a');
    const addNotice = vi.fn((notice) => notice);
    session.tasks.mockRejectedValueOnce(new Error('Failed to fetch'));
    const { actions } = createActionsHarness({ addNotice, session });

    await expect(actions.getTasks({ silent: true })).rejects.toThrow(
      'Failed to fetch',
    );

    expect(addNotice).not.toHaveBeenCalled();
  });

  it.each(['Request timed out', 'Network error', 'NetworkError'])(
    'suppresses notices for silent %s getTasks failures',
    async (message) => {
      const session = createMockSession('session-a');
      const addNotice = vi.fn((notice) => notice);
      session.tasks.mockRejectedValueOnce(new Error(message));
      const { actions } = createActionsHarness({ addNotice, session });

      await expect(actions.getTasks({ silent: true })).rejects.toThrow(message);

      expect(addNotice).not.toHaveBeenCalled();
    },
  );

  it.each([500, 408, 429])(
    'suppresses notices for silent retryable HTTP %i getTasks failures',
    async (status) => {
      const session = createMockSession('session-a');
      const addNotice = vi.fn((notice) => notice);
      session.tasks.mockRejectedValueOnce(
        new DaemonHttpError(status, undefined, 'Retryable failure'),
      );
      const { actions } = createActionsHarness({ addNotice, session });

      await expect(actions.getTasks({ silent: true })).rejects.toBeInstanceOf(
        DaemonHttpError,
      );

      expect(addNotice).not.toHaveBeenCalled();
    },
  );

  it('suppresses notices for silent abort getTasks failures', async () => {
    const session = createMockSession('session-a');
    const addNotice = vi.fn((notice) => notice);
    session.tasks.mockRejectedValueOnce(
      new DOMException('Aborted', 'AbortError'),
    );
    const { actions } = createActionsHarness({ addNotice, session });

    await expect(actions.getTasks({ silent: true })).rejects.toMatchObject({
      name: 'AbortError',
    });

    expect(addNotice).not.toHaveBeenCalled();
  });

  it('reports silent hard HTTP getTasks failures once', async () => {
    const session = createMockSession('session-a');
    const addNotice = vi.fn((notice) => notice);
    session.tasks.mockRejectedValueOnce(
      new DaemonHttpError(403, undefined, 'Forbidden'),
    );
    const { actions } = createActionsHarness({ addNotice, session });

    await expect(actions.getTasks({ silent: true })).rejects.toBeInstanceOf(
      DaemonHttpError,
    );

    expect(addNotice).toHaveBeenCalledOnce();
    expect(addNotice).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'daemon.load_tasks.failed',
        message: 'Get tasks failed: Forbidden',
        operation: 'load_tasks',
      }),
    );
  });

  it('reports silent hard getTasks failures once', async () => {
    const session = createMockSession('session-a');
    const addNotice = vi.fn((notice) => notice);
    session.tasks.mockRejectedValue(new Error('Malformed response'));
    const { actions } = createActionsHarness({ addNotice, session });

    await expect(actions.getTasks({ silent: true })).rejects.toThrow(
      'Malformed response',
    );
    await expect(actions.getTasks({ silent: true })).rejects.toThrow(
      'Malformed response',
    );

    expect(addNotice).toHaveBeenCalledOnce();
    expect(addNotice).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'daemon.load_tasks.failed',
        message: 'Get tasks failed: Malformed response',
        operation: 'load_tasks',
      }),
    );
  });

  it('resets silent hard getTasks failure dedupe when clearing the session', async () => {
    const sessionA = createMockSession('session-a');
    const sessionB = createMockSession('session-b');
    const addNotice = vi.fn((notice) => notice);
    sessionA.tasks.mockRejectedValue(new Error('Malformed response'));
    sessionB.tasks.mockRejectedValue(new Error('Malformed response'));
    const { actions, sessionRef } = createActionsHarness({
      addNotice,
      session: sessionA,
    });

    await expect(actions.getTasks({ silent: true })).rejects.toThrow(
      'Malformed response',
    );
    await expect(actions.getTasks({ silent: true })).rejects.toThrow(
      'Malformed response',
    );
    await actions.clearSession();
    sessionRef.current = sessionB as unknown as DaemonSessionClient;
    await expect(actions.getTasks({ silent: true })).rejects.toThrow(
      'Malformed response',
    );

    expect(addNotice).toHaveBeenCalledTimes(2);
  });

  it('rejects getTasks silently when no session exists', async () => {
    const addNotice = vi.fn();
    const { actions } = createActionsHarness({ addNotice });

    await expect(actions.getTasks()).rejects.toThrow(
      'Daemon session is not connected',
    );
    expect(addNotice).not.toHaveBeenCalled();
  });

  it('aborts active prompts and rejects pending session loads when clearing', async () => {
    const controller = new AbortController();
    const session = createMockSession('session-a');
    const pendingReject = vi.fn();
    const pendingSessionLoadRef = {
      current: {
        id: 1,
        sessionId: 'session-a',
        mode: 'attach' as const,
        timeout: setTimeout(() => undefined, 30_000),
        resolve: vi.fn(),
        reject: pendingReject,
      },
    };
    const { actions } = createActionsHarness({
      activePrompts: new Map([['session-a', { controller } as ActivePrompt]]),
      pendingSessionLoadRef,
      session,
    });

    await actions.clearSession();

    expect(controller.signal.aborted).toBe(true);
    expect(pendingReject).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'AbortError',
        message: 'Session cleared',
      }),
    );
    expect(pendingSessionLoadRef.current).toBeUndefined();
  });

  it('restarts the event stream after prompt admission', async () => {
    const restartEventStream = vi.fn();
    const onAdmissionStarted = vi.fn();
    const session = createMockSession('session-a');
    const { actions } = createActionsHarness({
      restartEventStream,
      session,
    });

    const prompt = actions.sendPrompt('hello', { onAdmissionStarted });

    await vi.waitFor(() => {
      expect(restartEventStream).toHaveBeenCalledWith('session-a');
    });
    expect(onAdmissionStarted).toHaveBeenCalledOnce();
    await actions.cancel();
    await expect(prompt).resolves.toEqual({ stopReason: 'cancelled' });
  });

  it('starts admission only after local prompt guards pass', async () => {
    const onAdmissionStarted = vi.fn();
    const session = createMockSession('session-a');
    const { actions } = createActionsHarness({
      activePrompts: new Map([
        ['session-a', { controller: new AbortController() } as ActivePrompt],
      ]),
      session,
    });

    await expect(
      actions.sendPrompt('hello', { onAdmissionStarted }),
    ).rejects.toThrow('A prompt is already in progress');

    expect(onAdmissionStarted).not.toHaveBeenCalled();
    expect(session.submitPrompt).not.toHaveBeenCalled();
  });

  it('does not restart the event stream when the admitted prompt is stale', async () => {
    const restartEventStream = vi.fn();
    const session = createMockSession('session-a');
    const accepted = createDeferred<{ promptId: string }>();
    session.submitPrompt.mockReturnValueOnce(accepted.promise);
    const { actions, activePromptsRef } = createActionsHarness({
      restartEventStream,
      session,
    });

    const prompt = actions.sendPrompt('hello');
    activePromptsRef.current.clear();
    accepted.resolve({ promptId: 'prompt-1' });

    await expect(prompt).resolves.toEqual({ stopReason: 'cancelled' });
    expect(restartEventStream).not.toHaveBeenCalled();
  });

  it('preserves ambiguous stable-id admission failures for reconciliation', async () => {
    const session = {
      ...createMockSession('session-a'),
      enqueueMidTurnMessage: vi
        .fn()
        .mockRejectedValueOnce(new Error('response lost')),
    };
    const { actions } = createActionsHarness({ session });

    await expect(
      actions.enqueueMidTurnMessage('follow up', { messageId: 'stable-id' }),
    ).rejects.toThrow('response lost');
    // The stable id must reach the session client verbatim: the daemon's
    // messageId-keyed idempotency and the reconciliation rings never match
    // if this hop drops the option.
    expect(session.enqueueMidTurnMessage).toHaveBeenCalledWith('follow up', {
      messageId: 'stable-id',
    });
  });

  it('keeps legacy mid-turn admission failures best-effort', async () => {
    const session = {
      ...createMockSession('session-a'),
      enqueueMidTurnMessage: vi
        .fn()
        .mockRejectedValueOnce(new Error('daemon unavailable')),
    };
    const { actions } = createActionsHarness({ session });

    await expect(actions.enqueueMidTurnMessage('follow up')).resolves.toEqual({
      accepted: false,
    });
  });

  it('resolves undefined when getMidTurnMessages fails instead of throwing', async () => {
    // Snapshot failure is unknown state. The caller must not infer that it is
    // safe to resend.
    const session = {
      ...createMockSession('session-a'),
      getMidTurnMessages: vi.fn().mockRejectedValue(new Error('daemon 500')),
    };
    const addNotice = vi.fn();
    const { actions } = createActionsHarness({ addNotice, session });

    await expect(actions.getMidTurnMessages()).resolves.toBeUndefined();
    expect(addNotice).not.toHaveBeenCalled();
  });

  it('resolves undefined from getMidTurnMessages when no session exists', async () => {
    const { actions } = createActionsHarness();

    await expect(actions.getMidTurnMessages()).resolves.toBeUndefined();
  });

  it('does not apply a late model update to a replacement attachment', async () => {
    const source = createMockSession('session-a', 'client-a');
    const target = createMockSession('session-a', 'client-b');
    const result = { applied: true };
    const deferred = createDeferred<typeof result>();
    source.setModel.mockReturnValueOnce(deferred.promise);
    const { actions, getConnection, replaceConnection, sessionRef } =
      createActionsHarness({
        connection: {
          status: 'connected',
          sessionId: source.sessionId,
          clientId: source.clientId,
          currentModel: 'source-model',
        },
        session: source,
      });

    const pending = actions.setModel('late-source-model');
    sessionRef.current = target as unknown as DaemonSessionClient;
    replaceConnection({
      status: 'connected',
      sessionId: target.sessionId,
      clientId: target.clientId,
      currentModel: 'target-model',
    });
    deferred.resolve(result);

    await expect(pending).resolves.toBe(result);
    expect(getConnection()).toMatchObject({
      clientId: 'client-b',
      currentModel: 'target-model',
    });
  });

  it('does not apply a late approval mode to a replacement attachment', async () => {
    const source = createMockSession('session-a', 'client-a');
    const target = createMockSession('session-a', 'client-b');
    const result = {
      sessionId: 'session-a',
      mode: 'yolo',
      previous: 'default',
      persisted: false,
    };
    const deferred = createDeferred<typeof result>();
    source.client.setSessionApprovalMode.mockReturnValueOnce(deferred.promise);
    const { actions, getConnection, replaceConnection, sessionRef } =
      createActionsHarness({
        connection: {
          status: 'connected',
          sessionId: source.sessionId,
          clientId: source.clientId,
          currentMode: 'default',
        },
        session: source,
      });

    const pending = actions.setApprovalMode('yolo');
    sessionRef.current = target as unknown as DaemonSessionClient;
    replaceConnection({
      status: 'connected',
      sessionId: target.sessionId,
      clientId: target.clientId,
      currentMode: 'plan',
    });
    deferred.resolve(result);

    await expect(pending).resolves.toBe(result);
    expect(getConnection()).toMatchObject({
      clientId: 'client-b',
      currentMode: 'plan',
    });
  });

  it('does not apply late commands to a replacement attachment', async () => {
    const source = createMockSession('session-a', 'client-a');
    const target = createMockSession('session-a', 'client-b');
    const status = supportedCommandsStatus('session-a', 'source-command');
    const deferred = createDeferred<typeof status>();
    source.supportedCommands.mockReturnValueOnce(deferred.promise);
    const targetStatus = supportedCommandsStatus('session-a', 'target-command');
    const { actions, getConnection, replaceConnection, sessionRef } =
      createActionsHarness({ session: source });

    const pending = actions.refreshCommands();
    sessionRef.current = target as unknown as DaemonSessionClient;
    replaceConnection({
      status: 'connected',
      sessionId: target.sessionId,
      clientId: target.clientId,
      commands: [commandInfo('target-command')],
      skills: ['target-skill'],
      supportedCommands: targetStatus,
    });
    deferred.resolve(status);

    await expect(pending).resolves.toBeUndefined();
    expect(getConnection()).toMatchObject({
      clientId: 'client-b',
      commands: [commandInfo('target-command')],
      skills: ['target-skill'],
      supportedCommands: targetStatus,
    });
  });

  it('does not apply late context to a replacement attachment', async () => {
    const source = createMockSession('session-a', 'client-a');
    const target = createMockSession('session-a', 'client-b');
    const context = {
      ...contextStatus('session-a'),
      state: {
        models: { currentModelId: 'source-model' },
        modes: { currentModeId: 'source-mode' },
      },
    };
    const deferred = createDeferred<typeof context>();
    source.context.mockReturnValueOnce(deferred.promise);
    const targetContext = contextStatus('session-a');
    const { actions, getConnection, replaceConnection, sessionRef } =
      createActionsHarness({ session: source });

    const pending = actions.getContext();
    sessionRef.current = target as unknown as DaemonSessionClient;
    replaceConnection({
      status: 'connected',
      sessionId: target.sessionId,
      clientId: target.clientId,
      context: targetContext,
      currentModel: 'target-model',
      currentMode: 'target-mode',
    });
    deferred.resolve(context);

    await expect(pending).resolves.toBe(context);
    expect(getConnection()).toMatchObject({
      clientId: 'client-b',
      context: targetContext,
      currentModel: 'target-model',
      currentMode: 'target-mode',
    });
  });
});

function createActionsHarness(
  opts: {
    activePrompts?: Map<string, ActivePrompt>;
    addNotice?: ReturnType<typeof vi.fn>;
    clearLiveJournalRepair?: ReturnType<typeof vi.fn>;
    connection?: DaemonConnectionState;
    createDetachedSession?: ReturnType<typeof vi.fn>;
    manualSessionClearRef?: { current: boolean };
    pendingSessionLoadRef?: { current: PendingSessionLoad | undefined };
    restartEventStream?: ReturnType<typeof vi.fn>;
    session?: ReturnType<typeof createMockSession>;
    setAttachSessionNonce?: ReturnType<typeof vi.fn>;
    setRestoreSessionId?: ReturnType<typeof vi.fn>;
    setRestoreWorkspaceCwd?: ReturnType<typeof vi.fn>;
  } = {},
) {
  let connection: DaemonConnectionState = opts.connection ?? {
    status: 'connected',
    workspaceCwd: '/workspace',
  };
  const replaceConnection = (next: DaemonConnectionState) => {
    connection = next;
  };
  const sessionRef = {
    current: opts.session as unknown as DaemonSessionClient | undefined,
  };
  const activePromptsRef = {
    current: opts.activePrompts ?? new Map<string, ActivePrompt>(),
  };
  const pendingSessionLoadRef =
    opts.pendingSessionLoadRef ??
    ({ current: undefined } as {
      current: PendingSessionLoad | undefined;
    });
  const store = {
    reset: vi.fn(),
    appendLocalUserMessage: vi.fn(),
    dispatch: vi.fn(),
  };
  const actions = createDaemonSessionActions({
    store: store as never,
    sessionRef,
    activePromptsRef,
    settledPromptsRef: { current: new Map<string, SettledPrompt>() },
    pendingSessionLoadRef,
    pendingSessionLoadIdRef: { current: 0 },
    sessionConfigGeneration: new WeakMap(),
    heartbeatSupportedRef: { current: false },
    manualSessionClearRef: opts.manualSessionClearRef ?? { current: false },
    skipNextCleanupDetachSessionRef: { current: undefined },
    passiveAssistantDoneTimerRef: { current: undefined },
    getCreateSessionRequest: () => ({ workspaceCwd: '/workspace' }),
    createDetachedSession: (opts.createDetachedSession ??
      vi.fn(
        async () =>
          createMockSession(
            'detached-session',
          ) as unknown as DaemonSessionClient,
      )) as () => Promise<DaemonSessionClient>,
    getConnection: () => connection,
    hasSessionActivePrompt: () => false,
    resetCurrentSessionActivePrompt: vi.fn(),
    restartEventStream: opts.restartEventStream ?? vi.fn(),
    addNotice: opts.addNotice ?? vi.fn(),
    clearLiveJournalRepair: opts.clearLiveJournalRepair,
    setConnection: (update) => {
      connection = typeof update === 'function' ? update(connection) : update;
    },
    setPromptStatus: vi.fn(),
    setRestoreSessionId: opts.setRestoreSessionId ?? vi.fn(),
    setRestoreWorkspaceCwd: opts.setRestoreWorkspaceCwd ?? vi.fn(),
    setRestoreMode: vi.fn(),
    setRestoreSessionNonce: vi.fn(),
    setAttachSessionNonce: opts.setAttachSessionNonce ?? vi.fn(),
    setNewSessionNonce: vi.fn(),
  });
  return {
    actions,
    activePromptsRef,
    getConnection: () => connection,
    pendingSessionLoadRef,
    replaceConnection,
    sessionRef,
    store,
  };
}

function createMockSession(
  sessionId: string,
  clientId = `client-${sessionId}`,
) {
  return {
    sessionId,
    workspaceCwd: '/workspace',
    clientId,
    client: {
      createOrAttachSession: vi.fn(),
      branchSession: vi.fn(),
      detachSession: vi.fn(async () => undefined),
      setSessionApprovalMode: vi.fn(async () => ({
        sessionId,
        mode: 'default',
        previous: 'default',
        persisted: false,
      })),
      listWorkspaceSessions: vi.fn(),
      closeSession: vi.fn(),
    },
    cancel: vi.fn(async () => undefined),
    context: vi.fn(async () => contextStatus(sessionId)),
    detach: vi.fn(async () => undefined),
    setModel: vi.fn(async () => ({})),
    submitPrompt: vi.fn(async () => ({ promptId: 'prompt-1' })),
    supportedCommands: vi.fn(async () => supportedCommandsStatus(sessionId)),
    tasks: vi.fn(async () => ({ v: 1 as const, sessionId, tasks: [] })),
  };
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

function commandInfo(name: string) {
  const raw = commandRaw(name);
  return {
    name,
    description: '',
    raw,
  };
}

function commandRaw(name: string) {
  return {
    name,
    description: '',
    input: null,
  };
}

function supportedCommandsStatus(sessionId: string, ...names: string[]) {
  return {
    v: 1 as const,
    sessionId,
    availableCommands: names.map(commandRaw),
    availableSkills: [],
  };
}

function contextStatus(sessionId: string) {
  return {
    v: 1 as const,
    sessionId,
    workspaceCwd: '/workspace',
    state: {},
  };
}
