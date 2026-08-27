import { describe, expect, it, vi } from 'vitest';
import {
  DaemonHttpError,
  DaemonPendingPromptLimitError,
  DaemonTransportClosedError,
  type DaemonCapabilities,
  type DaemonSessionClient,
  type GoalSnapshotV2,
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
        goalState: { v: 2, goal: null, activity: 'idle' },
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
    expect(next).not.toHaveProperty('goalState');
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

  it('restores workspace model previews after clearing session context models', () => {
    const next = getConnectionAfterSessionClear(
      {
        status: 'connected',
        workspaceCwd: '/workspace',
        sessionId: 'session-a',
        context: contextStatus('session-a'),
        models: [
          {
            id: 'qwen3.8-max',
            baseModelId: 'qwen3.8-max',
            label: 'Qwen 3.8 Max',
          },
        ],
        providers: {
          v: 1,
          workspaceCwd: '/workspace',
          initialized: true,
          current: { modelId: 'qwen3.8-max' },
          providers: [
            {
              kind: 'model_provider',
              status: 'ok',
              authType: 'qwen-oauth',
              current: true,
              models: [
                {
                  modelId: 'qwen3.8-max',
                  baseModelId: 'qwen3.8-max',
                  name: 'Qwen 3.8 Max',
                  isCurrent: true,
                  isRuntime: false,
                  configOptions: [
                    {
                      id: 'reasoning_effort',
                      currentValue: 'xhigh',
                      options: [
                        { value: 'none' },
                        { value: 'low' },
                        { value: 'medium' },
                        { value: 'xhigh' },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      } as DaemonConnectionState,
      'session-a',
    );

    expect(next.models?.[0]?.reasoningPreview).toEqual({
      enabled: true,
      effort: 'xhigh',
      efforts: ['low', 'medium', 'xhigh'],
    });
  });

  it('keeps the prior model list when no workspace providers are loaded', () => {
    // Older daemons without workspaceProviders support (or a rejected fetch)
    // leave `providers` undefined; the pre-clear list must survive the clear.
    const models = [
      {
        id: 'qwen3.8-max',
        baseModelId: 'qwen3.8-max',
        label: 'Qwen 3.8 Max',
      },
    ];
    const next = getConnectionAfterSessionClear(
      {
        status: 'connected',
        workspaceCwd: '/workspace',
        sessionId: 'session-a',
        context: contextStatus('session-a'),
        models,
      } as DaemonConnectionState,
      'session-a',
    );

    expect(next.models).toEqual(models);
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
  it('does not report a stats error while the session is disconnected', async () => {
    const addNotice = vi.fn();
    const { actions } = createActionsHarness({ addNotice });

    await expect(actions.getStats()).rejects.toThrow(
      'Daemon session is not connected',
    );
    expect(addNotice).not.toHaveBeenCalled();
  });

  it('does not report a stats error when the session disconnects in flight', async () => {
    const addNotice = vi.fn();
    const session = createMockSession('session-a');
    session.stats.mockRejectedValueOnce(new DaemonTransportClosedError());
    const { actions } = createActionsHarness({ addNotice, session });

    await expect(actions.getStats()).rejects.toThrow(
      'Transport connection closed',
    );
    expect(addNotice).not.toHaveBeenCalled();
  });

  it.each([
    'fetch failed',
    'Failed to fetch',
    'NetworkError when attempting to fetch resource',
    'Load failed',
  ])(
    'does not report a stats error when fetch disconnects in flight: %s',
    async (message) => {
      const addNotice = vi.fn();
      const session = createMockSession('session-a');
      session.stats.mockRejectedValueOnce(new TypeError(message));
      const { actions } = createActionsHarness({ addNotice, session });

      await expect(actions.getStats()).rejects.toThrow(message);
      expect(addNotice).not.toHaveBeenCalled();
    },
  );

  it('reports non-disconnect stats errors', async () => {
    const addNotice = vi.fn((notice) => notice);
    const session = createMockSession('session-a');
    session.stats.mockRejectedValueOnce(new Error('bad response'));
    const { actions } = createActionsHarness({ addNotice, session });

    await expect(actions.getStats()).rejects.toThrow('bad response');
    expect(addNotice).toHaveBeenCalledWith(
      expect.objectContaining({ operation: 'load_stats' }),
    );
  });

  it('clears the previous Goal before starting a fresh session', async () => {
    const { actions, getConnection } = createActionsHarness({
      connection: {
        status: 'connected',
        sessionId: 'session-a',
        goalState: { v: 2, goal: null, activity: 'idle' },
      },
    });

    await actions.newSession();

    expect(getConnection().goalState).toBeUndefined();
  });

  it('rejects a concurrent source-bound branch request', async () => {
    const source = createMockSession('session-a', 'client-a');
    const first = createDeferred<{
      sessionId: string;
      displayName: string;
      clientId: string;
    }>();
    source.client.branchSession.mockReturnValueOnce(first.promise);
    const { actions } = createActionsHarness({
      session: source,
    });

    const firstBranch = actions.branchSession({ name: 'First' });
    const secondBranch = actions.branchSession({ name: 'Second' });
    await expect(secondBranch).rejects.toMatchObject({
      name: 'InvalidStateError',
    });
    expect(source.client.branchSession).toHaveBeenCalledOnce();

    first.resolve({
      sessionId: 'session-b',
      displayName: 'First',
      clientId: 'client-b',
    });
    await expect(firstBranch).resolves.toEqual({
      sessionId: 'session-b',
      displayName: 'First',
      switchStarted: true,
    });
  });

  it('does not open a branch that resolves after its source is cleared', async () => {
    const source = createMockSession('session-a', 'client-a');
    const branched = createDeferred<{
      sessionId: string;
      displayName: string;
      clientId: string;
    }>();
    source.client.branchSession.mockReturnValueOnce(branched.promise);
    const { actions, pendingSessionLoadRef, sessionRef } = createActionsHarness(
      {
        session: source,
      },
    );

    const pending = actions.branchSession({ name: 'Late branch' });
    await actions.clearSession();
    branched.resolve({
      sessionId: 'session-b',
      displayName: 'Late branch',
      clientId: 'client-b',
    });

    await expect(pending).resolves.toEqual({
      sessionId: 'session-b',
      displayName: 'Late branch',
      switchStarted: false,
    });
    await Promise.resolve();
    expect(sessionRef.current).toBeUndefined();
    expect(pendingSessionLoadRef.current).toBeUndefined();
    expect(source.client.detachSession).toHaveBeenCalledWith(
      'session-b',
      'client-b',
    );
  });

  it('detaches a late historical worktree branch response', async () => {
    const source = createMockSession('session-a', 'client-a');
    const branched = createDeferred<{
      sessionId: string;
      displayName: string;
      clientId: string;
    }>();
    source.client.branchSession.mockReturnValueOnce(branched.promise);
    const { actions } = createActionsHarness({ session: source });

    const pending = actions.branchSession({
      atRecordId: 'checkpoint-1',
      worktree: {},
    });
    await actions.clearSession();
    branched.resolve({
      sessionId: 'session-b',
      displayName: 'Worktree branch',
      clientId: 'client-b',
    });

    await expect(pending).resolves.toMatchObject({ switchStarted: false });
    await Promise.resolve();
    expect(source.client.detachSession).toHaveBeenCalledWith(
      'session-b',
      'client-b',
    );
  });

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
        connection: {
          status: 'connected',
          sessionId: 'session-a',
          goalState: { v: 2, goal: null, activity: 'idle' },
        },
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
    expect(getConnection().goalState).toBeUndefined();
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

  it('reads and controls the authoritative Goal through the session client', async () => {
    const session = createMockSession('session-a');
    const snapshot = {
      v: 2 as const,
      activity: 'idle' as const,
      goal: null,
    };
    session.goal.mockResolvedValue({ snapshot });
    session.controlGoal.mockResolvedValue({ snapshot });
    const { actions, getConnection } = createActionsHarness({
      connection: { status: 'connected', sessionId: 'session-a' },
      session,
    });
    const request = { action: 'create' as const, objective: 'ship safely' };

    await expect(actions.getGoal()).resolves.toEqual({ snapshot });
    await expect(actions.controlGoal(request)).resolves.toEqual({ snapshot });

    expect(session.goal).toHaveBeenCalledOnce();
    expect(session.controlGoal).toHaveBeenCalledWith(request);
    expect(getConnection().goalState).toBe(snapshot);
  });

  it('does not let delayed Goal responses regress the current revision', async () => {
    const session = createMockSession('session-a');
    const current = {
      v: 2 as const,
      activity: 'idle' as const,
      goal: {
        goalId: 'goal-1',
        revision: 7,
        objective: 'newer objective',
        status: 'paused' as const,
        evidenceCursor: { recordId: 'record-1' },
        turnCount: 3,
        activeTimeMs: 4_000,
        createdAt: 10,
        updatedAt: 30,
      },
    };
    const stale = {
      ...current,
      activity: 'running' as const,
      goal: { ...current.goal, revision: 6, status: 'active' as const },
    };
    session.goal.mockResolvedValue({ snapshot: stale });
    session.controlGoal.mockResolvedValue({ snapshot: stale });
    const { actions, getConnection } = createActionsHarness({
      connection: {
        status: 'connected',
        sessionId: 'session-a',
        goalState: current,
      },
      session,
    });

    await actions.getGoal();
    await actions.controlGoal({
      action: 'pause',
      expectedGoalId: 'goal-1',
      expectedRevision: 7,
    });

    expect(getConnection().goalState).toBe(current);
  });

  it('installs an out-of-band Goal snapshot for the attached session only', () => {
    const session = createMockSession('session-a');
    const active: GoalSnapshotV2 = {
      v: 2,
      activity: 'running',
      goal: {
        goalId: 'goal-1',
        revision: 3,
        objective: 'ship safely',
        status: 'active',
        evidenceCursor: { recordId: 'record-1' },
        turnCount: 0,
        activeTimeMs: 0,
        createdAt: 10,
        updatedAt: 20,
      },
    };
    const { actions, getConnection } = createActionsHarness({
      connection: { status: 'connected', sessionId: 'session-a' },
      session,
    });

    actions.applyGoalSnapshot('session-b', active);
    expect(getConnection().goalState).toBeUndefined();

    actions.applyGoalSnapshot('session-a', active);
    expect(getConnection().goalState).toBe(active);

    // Reconciled like any other snapshot, so a stale one cannot regress it.
    actions.applyGoalSnapshot('session-a', {
      ...active,
      goal: { ...active.goal!, revision: 2 },
    });
    expect(getConnection().goalState).toBe(active);
  });

  it('does not let a stale bare-null Goal read wipe a Goal created meanwhile', async () => {
    // The daemon answered the read while the session was goal-less, so the
    // response carries no `clearedGoal` tombstone. Reconciling it against the
    // goal created while it was in flight would clear that goal outright.
    const session = createMockSession('session-a');
    let resolveRead:
      | ((value: { snapshot: GoalSnapshotV2 }) => void)
      | undefined;
    session.goal.mockReturnValue(
      new Promise<{ snapshot: GoalSnapshotV2 }>((resolve) => {
        resolveRead = resolve;
      }),
    );
    const { actions, getConnection, replaceConnection } = createActionsHarness({
      connection: { status: 'connected', sessionId: 'session-a' },
      session,
    });

    const read = actions.getGoal();
    const created: GoalSnapshotV2 = {
      v: 2,
      activity: 'running',
      goal: {
        goalId: 'goal-new',
        revision: 1,
        objective: 'ship safely',
        status: 'active',
        evidenceCursor: { recordId: 'record-1' },
        turnCount: 0,
        activeTimeMs: 0,
        createdAt: 10,
        updatedAt: 20,
      },
    };
    replaceConnection({
      status: 'connected',
      sessionId: 'session-a',
      goalState: created,
    });
    resolveRead?.({ snapshot: { v: 2, goal: null, activity: 'idle' } });
    await read;

    expect(getConnection().goalState).toBe(created);
  });

  it('applies a bare-null Goal read to the Goal it observed', async () => {
    // Same shape, but nothing changed while the read was in flight: an older
    // daemon that clears without a tombstone must still clear the UI.
    const session = createMockSession('session-a');
    const active: GoalSnapshotV2 = {
      v: 2,
      activity: 'running',
      goal: {
        goalId: 'goal-1',
        revision: 7,
        objective: 'ship safely',
        status: 'active',
        evidenceCursor: { recordId: 'record-1' },
        turnCount: 3,
        activeTimeMs: 4_000,
        createdAt: 10,
        updatedAt: 30,
      },
    };
    session.goal.mockResolvedValue({
      snapshot: { v: 2, goal: null, activity: 'idle' },
    });
    const { actions, getConnection } = createActionsHarness({
      connection: {
        status: 'connected',
        sessionId: 'session-a',
        goalState: active,
      },
      session,
    });

    await actions.getGoal();

    expect(getConnection().goalState?.goal).toBeNull();
  });

  it('uploads prompt images and submits attachment references instead of base64', async () => {
    const onAdmissionStarted = vi.fn();
    const session = createMockSession('session-a');
    const { actions } = createActionsHarness({
      session,
      connection: {
        status: 'connected',
        workspaceCwd: '/workspace',
        capabilities: {
          v: 1,
          mode: 'http-bridge',
          features: ['session_attachments'],
          modelServices: [],
        },
      },
    });

    await actions.submitPrompt('look', {
      images: [{ data: 'AQID', mimeType: 'image/png' }],
      onAdmissionStarted,
    });

    expect(session.uploadAttachment).toHaveBeenCalledWith(
      expect.any(Blob),
      'image.png',
      'image/png',
      undefined,
    );
    expect(session.submitPrompt).toHaveBeenCalledWith({
      prompt: [
        { type: 'text', text: 'look' },
        {
          type: 'image',
          attachmentId: 'image.png',
          mimeType: 'image/png',
          size: 3,
        },
      ],
    });
    expect(onAdmissionStarted).toHaveBeenCalledOnce();
    expect(onAdmissionStarted.mock.invocationCallOrder[0]).toBeLessThan(
      session.submitPrompt.mock.invocationCallOrder[0]!,
    );
  });

  it('does not upload attachments discarded by slash commands', async () => {
    const session = createMockSession('session-a');
    const { actions, store } = createActionsHarness({
      session,
      connection: {
        status: 'connected',
        workspaceCwd: '/workspace',
        capabilities: {
          v: 1,
          mode: 'http-bridge',
          features: ['session_attachments'],
          modelServices: [],
        },
      },
    });

    await actions.submitPrompt('/help', {
      images: [{ data: 'AQID', mimeType: 'image/png' }],
      files: [{ name: 'notes.txt', text: 'hello', media_type: 'text/plain' }],
    });

    expect(session.uploadAttachment).not.toHaveBeenCalled();
    expect(session.submitPrompt).toHaveBeenCalledWith({
      prompt: [{ type: 'text', text: '/help' }],
    });
    expect(store.appendLocalUserMessage).toHaveBeenCalledWith(
      '/help',
      [],
      undefined,
      [],
    );
  });

  it('uploads text attachments and submits attachment references', async () => {
    const session = createMockSession('session-a');
    const { actions, store } = createActionsHarness({
      session,
      connection: {
        status: 'connected',
        workspaceCwd: '/workspace',
        capabilities: {
          v: 1,
          mode: 'http-bridge',
          features: ['session_attachments'],
          modelServices: [],
        },
      },
    });

    await actions.submitPrompt('check', {
      files: [{ name: 'notes.txt', text: 'hello', media_type: 'text/plain' }],
    });

    expect(session.uploadAttachment).toHaveBeenCalledWith(
      expect.any(Blob),
      'notes.txt',
      'text/plain',
      undefined,
    );
    expect(session.submitPrompt).toHaveBeenCalledWith({
      prompt: [
        {
          type: 'text',
          text: 'check\n\n@attachment:///notes.txt',
        },
        {
          type: 'resource',
          attachmentId: 'notes.txt',
          mimeType: 'text/plain',
          size: 5,
        },
      ],
    });
    expect(store.appendLocalUserMessage).toHaveBeenCalledWith(
      'check',
      [],
      undefined,
      [
        {
          name: 'notes.txt',
          mimeType: 'text/plain',
          text: 'hello',
          attachmentId: 'notes.txt',
        },
      ],
    );
    expect(session.uploadAttachment.mock.invocationCallOrder[0]).toBeLessThan(
      store.appendLocalUserMessage.mock.invocationCallOrder[0]!,
    );
  });

  it('uploads arbitrary file bytes without text decoding', async () => {
    const session = createMockSession('session-a');
    const { actions } = createActionsHarness({
      session,
      connection: {
        status: 'connected',
        workspaceCwd: '/workspace',
        capabilities: {
          v: 1,
          mode: 'http-bridge',
          features: ['session_attachments'],
          modelServices: [],
        },
      },
    });
    const data = new Blob([Uint8Array.from([0, 255, 1])], {
      type: 'application/pdf',
    });

    await actions.submitPrompt('check', {
      files: [{ name: 'report.pdf', data, media_type: 'application/pdf' }],
    });

    expect(session.uploadAttachment).toHaveBeenCalledWith(
      data,
      'report.pdf',
      'application/pdf',
      undefined,
    );
    expect(session.submitPrompt).toHaveBeenCalledWith({
      prompt: [
        {
          type: 'text',
          text: 'check\n\n@attachment:///report.pdf',
        },
        {
          type: 'resource',
          attachmentId: 'report.pdf',
          mimeType: 'application/pdf',
          size: 3,
        },
      ],
    });
  });

  it('uses the matching uploaded reference for image-typed files', async () => {
    const session = createMockSession('session-a');
    session.uploadAttachment
      .mockResolvedValueOnce({
        type: 'image',
        attachmentId: 'image.png',
        mimeType: 'image/png',
        size: 3,
      })
      .mockResolvedValueOnce({
        type: 'image',
        attachmentId: 'diagram (1).png',
        mimeType: 'image/png',
        size: 3,
      });
    const { actions } = createActionsHarness({
      session,
      connection: {
        status: 'connected',
        workspaceCwd: '/workspace',
        capabilities: {
          v: 1,
          mode: 'http-bridge',
          features: ['session_attachments'],
          modelServices: [],
        },
      },
    });

    await actions.submitPrompt('check', {
      images: [{ data: 'AQID', mimeType: 'image/png' }],
      files: [
        {
          name: 'diagram.png',
          data: new Blob([Uint8Array.of(1, 2, 3)], { type: 'image/png' }),
          media_type: 'image/png',
        },
      ],
    });

    expect(session.submitPrompt).toHaveBeenCalledWith({
      prompt: [
        {
          type: 'text',
          text: 'check\n\n@attachment:///diagram%20(1).png',
        },
        expect.objectContaining({ attachmentId: 'image.png' }),
        expect.objectContaining({ attachmentId: 'diagram (1).png' }),
      ],
    });
  });

  it('uses the daemon-deduplicated attachment name in the prompt token', async () => {
    const session = createMockSession('session-a');
    session.uploadAttachment.mockResolvedValueOnce({
      type: 'resource',
      attachmentId: 'notes (1).txt',
      mimeType: 'text/plain',
      size: 5,
    });
    const { actions } = createActionsHarness({
      session,
      connection: {
        status: 'connected',
        workspaceCwd: '/workspace',
        capabilities: {
          v: 1,
          mode: 'http-bridge',
          features: ['session_attachments'],
          modelServices: [],
        },
      },
    });

    await actions.submitPrompt('check', {
      files: [{ name: 'notes.txt', text: 'hello', media_type: 'text/plain' }],
    });

    expect(session.submitPrompt).toHaveBeenCalledWith({
      prompt: [
        {
          type: 'text',
          text: 'check\n\n@attachment:///notes%20(1).txt',
        },
        {
          type: 'resource',
          attachmentId: 'notes (1).txt',
          mimeType: 'text/plain',
          size: 5,
        },
      ],
    });
  });

  it('keeps images without a concrete mime type inline instead of uploading', async () => {
    const session = createMockSession('session-a');
    const { actions } = createActionsHarness({
      session,
      connection: {
        status: 'connected',
        workspaceCwd: '/workspace',
        capabilities: {
          v: 1,
          mode: 'http-bridge',
          features: ['session_attachments'],
          modelServices: [],
        },
      },
    });

    await actions.submitPrompt('look', {
      images: [{ data: 'AQID', mimeType: 'image/*' }],
    });

    // The attachment route matches concrete image types only; uploading a literal
    // image/* Content-Type 400s, so such images must stay inline (untyped,
    // matching the legacy shape).
    expect(session.uploadAttachment).not.toHaveBeenCalled();
    expect(session.submitPrompt).toHaveBeenCalledWith({
      prompt: [
        { type: 'text', text: 'look' },
        { type: 'image', data: 'AQID' },
      ],
    });
  });

  it('does not mark admission started when attachment upload fails', async () => {
    const onAdmissionStarted = vi.fn();
    const session = createMockSession('session-a');
    session.uploadAttachment.mockRejectedValueOnce(new Error('upload failed'));
    const { actions } = createActionsHarness({
      session,
      connection: {
        status: 'connected',
        workspaceCwd: '/workspace',
        capabilities: {
          v: 1,
          mode: 'http-bridge',
          features: ['session_attachments'],
          modelServices: [],
        },
      },
    });

    await expect(
      actions.submitPrompt('look', {
        images: [{ data: 'AQID', mimeType: 'image/png' }],
        onAdmissionStarted,
      }),
    ).rejects.toThrow('upload failed');

    expect(onAdmissionStarted).not.toHaveBeenCalled();
    expect(session.submitPrompt).not.toHaveBeenCalled();
  });

  it('falls back to inline image data when the attachment route is unavailable', async () => {
    const session = createMockSession('session-a');
    session.uploadAttachment.mockRejectedValueOnce(
      new DaemonHttpError(404, undefined, 'Not found'),
    );
    const { actions } = createActionsHarness({
      session,
      connection: {
        status: 'connected',
        workspaceCwd: '/workspace',
        capabilities: {
          v: 1,
          mode: 'http-bridge',
          features: ['session_attachments'],
          modelServices: [],
        },
      },
    });

    await actions.submitPrompt('look', {
      images: [{ data: 'AQID', mimeType: 'image/png' }],
    });

    expect(session.submitPrompt).toHaveBeenCalledWith({
      prompt: [
        { type: 'text', text: 'look' },
        { type: 'image', data: 'AQID', mimeType: 'image/png' },
      ],
    });
  });

  it('does not submit empty files when attachment upload is unsupported', async () => {
    const session = createMockSession('session-a');
    const { actions } = createActionsHarness({
      session,
      connection: {
        status: 'connected',
        workspaceCwd: '/workspace',
        capabilities: {
          v: 1,
          mode: 'http-bridge',
          features: [],
          modelServices: [],
        },
      },
    });

    await expect(
      actions.submitPrompt('check', {
        files: [
          {
            name: 'report.pdf',
            data: new Blob(['pdf']),
            media_type: 'application/pdf',
          },
        ],
      }),
    ).rejects.toThrow('File attachment upload is not supported');

    expect(session.submitPrompt).not.toHaveBeenCalled();
  });

  it('does not submit empty files when the attachment route is unavailable', async () => {
    const session = createMockSession('session-a');
    session.uploadAttachment.mockRejectedValueOnce(
      new DaemonHttpError(404, undefined, 'Not found'),
    );
    const { actions } = createActionsHarness({
      session,
      connection: {
        status: 'connected',
        workspaceCwd: '/workspace',
        capabilities: {
          v: 1,
          mode: 'http-bridge',
          features: ['session_attachments'],
          modelServices: [],
        },
      },
    });

    await expect(
      actions.submitPrompt('check', {
        files: [
          {
            name: 'report.pdf',
            data: new Blob(['pdf']),
            media_type: 'application/pdf',
          },
        ],
      }),
    ).rejects.toThrow('Not found');

    expect(session.submitPrompt).not.toHaveBeenCalled();
  });

  it('removes successful attachment uploads when another upload fails', async () => {
    const session = createMockSession('session-a');
    session.uploadAttachment
      .mockResolvedValueOnce({
        type: 'resource',
        attachmentId: 'first.txt',
        mimeType: 'text/plain',
        size: 5,
      })
      .mockRejectedValueOnce(new Error('second upload failed'));
    const first = new Blob(['first']);
    const second = new Blob(['second']);
    const { actions, store } = createActionsHarness({
      session,
      connection: {
        status: 'connected',
        workspaceCwd: '/workspace',
        capabilities: {
          v: 1,
          mode: 'http-bridge',
          features: ['session_attachments'],
          modelServices: [],
        },
      },
    });

    await expect(
      actions.submitPrompt('look', {
        files: [
          { name: 'first.txt', data: first, media_type: 'text/plain' },
          { name: 'second.txt', data: second, media_type: 'text/plain' },
        ],
      }),
    ).rejects.toThrow('second upload failed');

    expect(session.removeAttachment).toHaveBeenCalledWith('first.txt');
    expect(store.appendLocalUserMessage).toHaveBeenCalledWith(
      'look',
      [],
      undefined,
      [
        {
          name: 'first.txt',
          mimeType: 'text/plain',
          data: first,
        },
        {
          name: 'second.txt',
          mimeType: 'text/plain',
          data: second,
        },
      ],
    );
    expect(session.submitPrompt).not.toHaveBeenCalled();
  });

  it('removes uploaded attachments when prompt admission is rejected', async () => {
    const session = createMockSession('session-a');
    session.submitPrompt.mockRejectedValueOnce(
      new DaemonPendingPromptLimitError('session-a', 20, 20),
    );
    const { actions, store } = createActionsHarness({
      session,
      connection: {
        status: 'connected',
        workspaceCwd: '/workspace',
        capabilities: {
          v: 1,
          mode: 'http-bridge',
          features: ['session_attachments'],
          modelServices: [],
        },
      },
    });

    await expect(
      actions.sendPrompt('look', {
        images: [{ data: 'AQID', mimeType: 'image/png' }],
      }),
    ).rejects.toThrow('Pending prompts full');

    expect(session.removeAttachment).toHaveBeenCalledWith('image.png');
    expect(store.appendLocalUserMessage).toHaveBeenCalledWith(
      'look',
      [{ data: 'AQID', mimeType: 'image/png' }],
      undefined,
      [],
    );
  });

  it('keeps uploaded attachments when prompt admission is uncertain', async () => {
    const session = createMockSession('session-a');
    session.submitPrompt.mockRejectedValueOnce(new TypeError('fetch failed'));
    const { actions } = createActionsHarness({
      session,
      connection: {
        status: 'connected',
        workspaceCwd: '/workspace',
        capabilities: {
          v: 1,
          mode: 'http-bridge',
          features: ['session_attachments'],
          modelServices: [],
        },
      },
    });

    await expect(
      actions.submitPrompt('look', {
        images: [{ data: 'AQID', mimeType: 'image/png' }],
      }),
    ).rejects.toThrow('fetch failed');

    expect(session.removeAttachment).not.toHaveBeenCalled();
  });

  it('removes uploaded attachments when cancelled before prompt admission', async () => {
    const upload = createDeferred<{
      type: 'image';
      attachmentId: string;
      mimeType: string;
      size: number;
    }>();
    const session = createMockSession('session-a');
    session.uploadAttachment.mockReturnValueOnce(upload.promise);
    const { actions, store } = createActionsHarness({
      session,
      connection: {
        status: 'connected',
        workspaceCwd: '/workspace',
        capabilities: {
          v: 1,
          mode: 'http-bridge',
          features: ['session_attachments'],
          modelServices: [],
        },
      },
    });

    const prompt = actions.sendPrompt('look', {
      images: [{ data: 'AQID', mimeType: 'image/png' }],
    });
    await vi.waitFor(() => expect(session.uploadAttachment).toHaveBeenCalled());
    await actions.cancel();
    upload.resolve({
      type: 'image',
      attachmentId: 'media-1',
      mimeType: 'image/png',
      size: 3,
    });

    await expect(prompt).resolves.toEqual({ stopReason: 'cancelled' });
    expect(session.removeAttachment).toHaveBeenCalledWith('media-1');
    expect(store.appendLocalUserMessage).toHaveBeenCalled();
    expect(session.submitPrompt).not.toHaveBeenCalled();
  });

  it('removes uploaded attachments when an admitted pending prompt is removed', async () => {
    const controller = new AbortController();
    const session = createMockSession('session-a');
    session.submitPrompt.mockImplementationOnce(async () => {
      controller.abort();
      return { promptId: 'prompt-1' };
    });
    session.removePendingPrompt.mockResolvedValueOnce({ removed: true });
    const { actions } = createActionsHarness({
      session,
      connection: {
        status: 'connected',
        workspaceCwd: '/workspace',
        capabilities: {
          v: 1,
          mode: 'http-bridge',
          features: ['session_attachments'],
          modelServices: [],
        },
      },
    });

    await expect(
      actions.submitPrompt('look', {
        signal: controller.signal,
        images: [{ data: 'AQID', mimeType: 'image/png' }],
      }),
    ).resolves.toEqual({ promptId: 'prompt-1', removedAfterAbort: true });

    expect(session.removeAttachment).toHaveBeenCalledWith('image.png');
  });

  it('keeps uploaded attachments when the admitted prompt already started', async () => {
    const controller = new AbortController();
    const session = createMockSession('session-a');
    session.submitPrompt.mockImplementationOnce(async () => {
      controller.abort();
      return { promptId: 'prompt-1' };
    });
    session.removePendingPrompt.mockResolvedValueOnce({ removed: false });
    const { actions } = createActionsHarness({
      session,
      connection: {
        status: 'connected',
        workspaceCwd: '/workspace',
        capabilities: {
          v: 1,
          mode: 'http-bridge',
          features: ['session_attachments'],
          modelServices: [],
        },
      },
    });

    await expect(
      actions.submitPrompt('look', {
        signal: controller.signal,
        images: [{ data: 'AQID', mimeType: 'image/png' }],
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });

    expect(session.removeAttachment).not.toHaveBeenCalled();
  });

  it('keeps prompt images inline for an older daemon', async () => {
    const session = createMockSession('session-a');
    const { actions } = createActionsHarness({ session });

    await actions.submitPrompt('look', {
      images: [{ data: 'AQID', mimeType: 'image/png' }],
    });

    expect(session.uploadAttachment).not.toHaveBeenCalled();
    expect(session.submitPrompt).toHaveBeenCalledWith({
      prompt: [
        { type: 'text', text: 'look' },
        {
          type: 'image',
          data: 'AQID',
          mimeType: 'image/png',
        },
      ],
    });
  });

  it('removes an orphaned upload from its original session after a switch', async () => {
    const session = createMockSession('session-current', 'client-current');
    const { actions } = createActionsHarness({ session });

    await expect(
      actions.removeAttachment('media-old', { sessionId: 'session-old' }),
    ).resolves.toBe(true);

    expect(session.removeAttachment).not.toHaveBeenCalled();
    expect(session.client.removeSessionAttachment).toHaveBeenCalledWith(
      'session-old',
      'media-old',
    );
  });

  it('removes an orphaned upload after the active session is cleared', async () => {
    const session = createMockSession('session-old', 'client-old');
    const { actions, sessionRef } = createActionsHarness({ session });
    await actions.uploadAttachment({ data: 'AQID', mimeType: 'image/png' });
    sessionRef.current = undefined;

    await expect(
      actions.removeAttachment('media-old', { sessionId: 'session-old' }),
    ).resolves.toBe(true);

    expect(session.client.removeSessionAttachment).toHaveBeenCalledWith(
      'session-old',
      'media-old',
      { clientId: 'client-old' },
    );
  });

  it('uses the target session client id when removing an old attachment', async () => {
    vi.stubGlobal('window', {
      sessionStorage: {
        getItem: vi.fn(() => 'client-old'),
      },
    });
    try {
      const session = createMockSession('session-current', 'client-current');
      const { actions } = createActionsHarness({ session });

      await actions.removeAttachment('media-old', {
        sessionId: 'session-old',
      });

      expect(session.client.removeSessionAttachment).toHaveBeenCalledWith(
        'session-old',
        'media-old',
        { clientId: 'client-old' },
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('retries cross-session attachment removal without the client id when it is stale', async () => {
    // Detach unregisters the persisted client id on the daemon; the cleanup
    // must degrade to a no-clientId removal instead of orphaning the media.
    vi.stubGlobal('window', {
      sessionStorage: {
        getItem: vi.fn(() => 'client-old'),
      },
    });
    try {
      const session = createMockSession('session-current', 'client-current');
      session.client.removeSessionAttachment = vi
        .fn()
        .mockRejectedValueOnce(
          new DaemonHttpError(
            400,
            { code: 'invalid_client_id' },
            'invalid client id',
          ),
        )
        .mockResolvedValueOnce(true);
      const { actions } = createActionsHarness({ session });

      await expect(
        actions.removeAttachment('media-old', { sessionId: 'session-old' }),
      ).resolves.toBe(true);

      expect(session.client.removeSessionAttachment).toHaveBeenCalledTimes(2);
      expect(session.client.removeSessionAttachment).toHaveBeenNthCalledWith(
        1,
        'session-old',
        'media-old',
        { clientId: 'client-old' },
      );
      expect(session.client.removeSessionAttachment).toHaveBeenNthCalledWith(
        2,
        'session-old',
        'media-old',
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('does not retry unrelated cross-session attachment removal errors', async () => {
    vi.stubGlobal('window', {
      sessionStorage: {
        getItem: vi.fn(() => 'client-old'),
      },
    });
    try {
      const session = createMockSession('session-current', 'client-current');
      const error = new DaemonHttpError(
        400,
        { code: 'invalid_attachment_id' },
        'invalid attachment id',
      );
      session.client.removeSessionAttachment = vi
        .fn()
        .mockRejectedValueOnce(error);
      const { actions } = createActionsHarness({ session });

      await expect(
        actions.removeAttachment('media-old', { sessionId: 'session-old' }),
      ).rejects.toBe(error);
      expect(session.client.removeSessionAttachment).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('normalizes image MIME parameters when naming an uploaded attachment', async () => {
    const session = createMockSession('session-a');
    const { actions } = createActionsHarness({ session });

    await actions.uploadAttachment({
      data: 'AQID',
      mimeType: 'image/jpeg; charset=binary',
    });

    expect(session.uploadAttachment).toHaveBeenCalledWith(
      expect.any(Blob),
      'image.jpeg',
      'image/jpeg',
      undefined,
    );
  });

  it('uploads a file attachment with its original name and MIME type', async () => {
    const session = createMockSession('session-a');
    const { actions } = createActionsHarness({ session });
    const data = new Blob(['hello'], { type: 'text/plain' });

    await actions.uploadAttachment({
      name: 'notes.txt',
      data,
      mimeType: 'text/plain',
    });

    expect(session.uploadAttachment).toHaveBeenCalledWith(
      data,
      'notes.txt',
      'text/plain',
      undefined,
    );
  });

  it('does not upload an attachment after the active session changes', async () => {
    const session = createMockSession('session-b');
    const { actions } = createActionsHarness({ session });

    await expect(
      actions.uploadAttachment(
        {
          name: 'notes.txt',
          data: new Blob(['hello']),
          mimeType: 'text/plain',
        },
        { sessionId: 'session-a' },
      ),
    ).rejects.toThrow('Attachment session changed');
    expect(session.uploadAttachment).not.toHaveBeenCalled();
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

  it('rethrows a stale branch point error without a generic notice', async () => {
    const session = createMockSession('session-a');
    const addNotice = vi.fn((notice) => notice);
    session.client.branchSession.mockRejectedValueOnce(
      new DaemonHttpError(409, { code: 'branch_point_invalid' }, 'Conflict'),
    );
    const { actions } = createActionsHarness({ addNotice, session });

    await expect(
      actions.branchSession({ atRecordId: 'a1' }),
    ).rejects.toMatchObject({ _alreadyDispatched: true });
    expect(addNotice).not.toHaveBeenCalled();
  });

  it('lets the SDK own the branch deadline instead of adding a 30s action timeout', async () => {
    vi.useFakeTimers();
    try {
      const session = createMockSession('session-a');
      const branchResult = createDeferred<{
        sessionId: string;
        displayName: string;
      }>();
      session.client.branchSession.mockReturnValueOnce(branchResult.promise);
      const addNotice = vi.fn((notice) => notice);
      const { actions, pendingSessionLoadRef } = createActionsHarness({
        addNotice,
        session,
      });

      let settled = false;
      const branch = actions
        .branchSession({ atRecordId: 'checkpoint-1' })
        .finally(() => {
          settled = true;
        });
      await vi.advanceTimersByTimeAsync(30_001);
      expect(settled).toBe(false);
      expect(addNotice).not.toHaveBeenCalled();

      branchResult.resolve({
        sessionId: 'session-b',
        displayName: 'Historical branch',
      });
      await expect(branch).resolves.toEqual({
        sessionId: 'session-b',
        displayName: 'Historical branch',
        switchStarted: true,
      });
      if (pendingSessionLoadRef.current) {
        clearTimeout(pendingSessionLoadRef.current.timeout);
        pendingSessionLoadRef.current.resolve();
        pendingSessionLoadRef.current = undefined;
      }
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('does not let a late branch result supersede newer navigation', async () => {
    const session = createMockSession('session-a');
    const branchResult = createDeferred<{
      sessionId: string;
      displayName: string;
    }>();
    session.client.branchSession.mockReturnValueOnce(branchResult.promise);
    const { actions, pendingSessionLoadRef } = createActionsHarness({
      session,
    });

    const branch = actions.branchSession({ atRecordId: 'checkpoint-1' });
    const newerLoad = actions.loadSession('session-b');
    expect(pendingSessionLoadRef.current?.sessionId).toBe('session-b');

    branchResult.resolve({
      sessionId: 'session-c',
      displayName: 'Historical branch',
    });
    await expect(branch).resolves.toEqual({
      sessionId: 'session-c',
      displayName: 'Historical branch',
      switchStarted: false,
    });
    expect(pendingSessionLoadRef.current?.sessionId).toBe('session-b');

    if (pendingSessionLoadRef.current) {
      clearTimeout(pendingSessionLoadRef.current.timeout);
      pendingSessionLoadRef.current.resolve();
      pendingSessionLoadRef.current = undefined;
    }
    await expect(newerLoad).resolves.toBeUndefined();
  });

  it('preserves ambiguous stable-id admission failures for reconciliation', async () => {
    const onAdmissionStarted = vi.fn();
    const session = {
      ...createMockSession('session-a'),
      enqueueMidTurnMessage: vi
        .fn()
        .mockRejectedValueOnce(new Error('response lost')),
    };
    const { actions } = createActionsHarness({ session });

    await expect(
      actions.enqueueMidTurnMessage('follow up', {
        messageId: 'stable-id',
        onAdmissionStarted,
      }),
    ).rejects.toThrow('response lost');
    expect(onAdmissionStarted).toHaveBeenCalledOnce();
    // The stable id must reach the session client verbatim: the daemon's
    // messageId-keyed idempotency and the reconciliation rings never match
    // if this hop drops the option.
    expect(session.enqueueMidTurnMessage).toHaveBeenCalledWith('follow up', {
      messageId: 'stable-id',
    });
  });

  it('does not mark a stable-id admission started without a session', async () => {
    const onAdmissionStarted = vi.fn();
    const { actions } = createActionsHarness();

    await expect(
      actions.enqueueMidTurnMessage('follow up', {
        messageId: 'stable-id',
        onAdmissionStarted,
      }),
    ).resolves.toEqual({ accepted: false });
    expect(onAdmissionStarted).not.toHaveBeenCalled();
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

  it('applies a reasoning effort only when the daemon confirms it', async () => {
    const session = createMockSession('session-a');
    session.setConfigOption.mockResolvedValueOnce({
      configOptions: reasoningConfigOptions('medium'),
    });
    const { actions, getConnection } = createActionsHarness({
      connection: {
        status: 'connected',
        sessionId: 'session-a',
        currentModel: 'qwen3.8-max',
      },
      session,
    });

    await expect(actions.setReasoningEffort('medium')).resolves.toBeUndefined();

    expect(session.setConfigOption).toHaveBeenCalledWith(
      'reasoning_effort',
      'medium',
    );
    expect(getConnection().reasoning).toEqual({
      enabled: true,
      effort: 'medium',
      efforts: ['low', 'medium', 'xhigh'],
    });
  });

  it('rejects a reasoning effort when live config options do not confirm it', async () => {
    const session = createMockSession('session-a');
    session.setConfigOption.mockResolvedValueOnce({ configOptions: [] });
    const { actions, getConnection } = createActionsHarness({
      connection: {
        status: 'connected',
        sessionId: 'session-a',
        currentModel: 'qwen3.8-max',
      },
      session,
    });

    await expect(actions.setReasoningEffort('medium')).rejects.toThrow(
      'Daemon did not confirm reasoning effort "medium"',
    );

    expect(getConnection().reasoning).toBeUndefined();
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
      removeSessionAttachment: vi.fn(async () => true),
    },
    cancel: vi.fn(async () => undefined),
    context: vi.fn(async () => contextStatus(sessionId)),
    detach: vi.fn(async () => undefined),
    setModel: vi.fn(async () => ({})),
    setConfigOption: vi.fn(async (_configId: string, value: string) => ({
      configOptions: reasoningConfigOptions(value),
    })),
    uploadAttachment: vi.fn(
      async (data: Blob, name: string, mimeType: string) => ({
        type: mimeType.startsWith('image/')
          ? ('image' as const)
          : ('resource' as const),
        attachmentId: name,
        mimeType,
        size: data.size,
      }),
    ),
    readAttachment: vi.fn(async () => ({
      data: 'aGVsbG8=',
      mimeType: 'text/plain',
    })),
    removeAttachment: vi.fn(async () => true),
    removePendingPrompt: vi.fn(async () => ({ removed: true })),
    submitPrompt: vi.fn(async () => ({ promptId: 'prompt-1' })),
    supportedCommands: vi.fn(async () => supportedCommandsStatus(sessionId)),
    stats: vi.fn(),
    tasks: vi.fn(async () => ({ v: 1 as const, sessionId, tasks: [] })),
    goal: vi.fn(),
    controlGoal: vi.fn(),
  };
}

function reasoningConfigOptions(currentValue: string) {
  return [
    {
      id: 'reasoning_effort',
      currentValue,
      options: [
        { value: 'none' },
        { value: 'low' },
        { value: 'medium' },
        { value: 'xhigh' },
      ],
    },
  ];
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
