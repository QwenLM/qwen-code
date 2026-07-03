import { describe, expect, it, vi } from 'vitest';
import type { DaemonSessionClient } from '@qwen-code/sdk/daemon';
import {
  createDaemonSessionActions,
  getConnectionAfterSessionClear,
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
      } as DaemonConnectionState,
      'session-a',
    );

    expect(next).toMatchObject({
      status: 'connected',
      workspaceCwd: '/workspace',
      loadingTranscript: undefined,
      catchingUp: undefined,
      error: undefined,
    });
    expect(next).not.toHaveProperty('sessionId');
    expect(next).not.toHaveProperty('clientId');
    expect(next).not.toHaveProperty('displayName');
    expect(next).not.toHaveProperty('tokenCount');
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
    expect(sessionRef.current).toBeUndefined();
    expect(getConnection()).toMatchObject({
      status: 'connecting',
      sessionId: 'session-b',
      loadingTranscript: true,
      catchingUp: undefined,
    });
    expect(pendingSessionLoadRef.current?.sessionId).toBe('session-b');
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
});

function createActionsHarness(
  opts: {
    activePrompts?: Map<string, ActivePrompt>;
    addNotice?: ReturnType<typeof vi.fn>;
    connection?: DaemonConnectionState;
    createDetachedSession?: ReturnType<typeof vi.fn>;
    manualSessionClearRef?: { current: boolean };
    pendingSessionLoadRef?: { current: PendingSessionLoad | undefined };
    session?: ReturnType<typeof createMockSession>;
    setAttachSessionNonce?: ReturnType<typeof vi.fn>;
  } = {},
) {
  let connection: DaemonConnectionState = opts.connection ?? {
    status: 'connected',
    workspaceCwd: '/workspace',
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
  const actions = createDaemonSessionActions({
    store: {
      reset: vi.fn(),
      appendLocalUserMessage: vi.fn(),
      dispatch: vi.fn(),
    } as never,
    sessionRef,
    activePromptsRef,
    settledPromptsRef: { current: new Map<string, SettledPrompt>() },
    pendingSessionLoadRef,
    pendingSessionLoadIdRef: { current: 0 },
    heartbeatSupportedRef: { current: false },
    manualSessionClearRef: opts.manualSessionClearRef ?? { current: false },
    skipNextCleanupDetachSessionIdRef: { current: undefined },
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
    addNotice: opts.addNotice ?? vi.fn(),
    setConnection: (update) => {
      connection = typeof update === 'function' ? update(connection) : update;
    },
    setPromptStatus: vi.fn(),
    setRestoreSessionId: vi.fn(),
    setRestoreMode: vi.fn(),
    setRestoreSessionNonce: vi.fn(),
    setAttachSessionNonce: opts.setAttachSessionNonce ?? vi.fn(),
    setNewSessionNonce: vi.fn(),
  });
  return {
    actions,
    getConnection: () => connection,
    pendingSessionLoadRef,
    sessionRef,
  };
}

function createMockSession(sessionId: string) {
  return {
    sessionId,
    workspaceCwd: '/workspace',
    clientId: `client-${sessionId}`,
    client: {
      createOrAttachSession: vi.fn(),
      setSessionApprovalMode: vi.fn(),
      listWorkspaceSessions: vi.fn(),
      closeSession: vi.fn(),
    },
    detach: vi.fn(async () => undefined),
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
