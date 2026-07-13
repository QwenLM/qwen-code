import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAndAttachSessionForPrompt } from './sessionPreparation';

type CreateSessionArgs = Parameters<typeof createAndAttachSessionForPrompt>[0];
const sessionResult = { sessionId: 'session-1' };
const modelResult = { model: 'qwen3' };

afterEach(() => vi.useRealTimers());

function createActions(
  overrides: Partial<CreateSessionArgs['sessionActions']> = {},
): CreateSessionArgs['sessionActions'] {
  return {
    createSession: vi.fn(async () => sessionResult),
    attachSession: vi.fn(async () => {}),
    clearSession: vi.fn(async () => {}),
    releaseSession: vi.fn(async () => {}),
    setModel: vi.fn(async () => modelResult),
    ...overrides,
  };
}

function prepareSession(
  args: Omit<CreateSessionArgs, 'getCurrentSessionId'> &
    Partial<Pick<CreateSessionArgs, 'getCurrentSessionId'>>,
): Promise<void> {
  return createAndAttachSessionForPrompt({
    getCurrentSessionId: () => sessionResult.sessionId,
    ...args,
  });
}

describe('createAndAttachSessionForPrompt', () => {
  it('folds the approval mode into createSession and applies the model after attach', async () => {
    const order: string[] = [];
    const actions = createActions({
      createSession: vi.fn(async () => {
        order.push('create');
        return sessionResult;
      }),
      attachSession: vi.fn(async () => {
        order.push('attach');
      }),
      setModel: vi.fn(async () => {
        order.push('model');
        return modelResult;
      }),
    });

    await prepareSession({
      sessionActions: actions,
      modelId: 'qwen3',
      modeId: 'yolo',
      workspaceCwd: '/ws/secondary',
    });

    // Approval mode rides along with creation — no follow-up round-trip.
    expect(actions.createSession).toHaveBeenCalledWith({
      workspaceCwd: '/ws/secondary',
      approvalMode: 'yolo',
    });
    // Model is still a post-create call, sequenced after attach.
    expect(order).toEqual(['create', 'attach', 'model']);
    expect(actions.setModel).toHaveBeenCalledWith('qwen3');
  });

  it('omits approvalMode when the mode is not a recognized daemon approval mode', async () => {
    const actions = createActions();

    await prepareSession({
      sessionActions: actions,
      modeId: 'not-a-mode',
    });

    expect(actions.createSession).toHaveBeenCalledWith({
      workspaceCwd: undefined,
    });
  });

  it('creates the session without a model call when no model is selected', async () => {
    const actions = createActions();

    await prepareSession({
      sessionActions: actions,
      modeId: 'plan',
    });

    expect(actions.createSession).toHaveBeenCalledWith({
      workspaceCwd: undefined,
      approvalMode: 'plan',
    });
    expect(actions.setModel).not.toHaveBeenCalled();
  });

  it('warns but resolves when the post-create model switch fails', async () => {
    const order: string[] = [];
    const error = new Error('model failed');
    const warn = vi.fn();
    const actions = createActions({
      createSession: vi.fn(async () => {
        order.push('create');
        return sessionResult;
      }),
      attachSession: vi.fn(async () => {
        order.push('attach');
      }),
      setModel: vi.fn(async () => {
        order.push('model');
        throw error;
      }),
    });

    await expect(
      prepareSession({
        sessionActions: actions,
        modelId: 'qwen3',
        modeId: 'yolo',
        warn,
      }),
    ).resolves.toBeUndefined();

    expect(order).toEqual(['create', 'attach', 'model']);
    expect(warn).toHaveBeenCalledWith(
      '[WebShell] failed to set model for new session:',
      error,
    );
  });

  it('propagates a create failure (fail-closed approval mode) without attaching or setting the model', async () => {
    // The daemon tears the session down and rejects `POST /session` when the
    // requested approval mode can't be applied at spawn. That rejection must
    // abort the whole flow — no session, no model call — rather than leaving a
    // half-created session in the wrong mode.
    const error = new Error('approval_mode_initialization_failed');
    const actions = createActions({
      createSession: vi.fn(async () => {
        throw error;
      }),
    });

    await expect(
      prepareSession({
        sessionActions: actions,
        modelId: 'qwen3',
        modeId: 'yolo',
      }),
    ).rejects.toThrow(error);

    expect(actions.createSession).toHaveBeenCalledWith({
      workspaceCwd: undefined,
      approvalMode: 'yolo',
    });
    expect(actions.attachSession).not.toHaveBeenCalled();
    expect(actions.setModel).not.toHaveBeenCalled();
    // Nothing was created client-side, so there is nothing to release/clear.
    expect(actions.releaseSession).not.toHaveBeenCalled();
    expect(actions.clearSession).not.toHaveBeenCalled();
  });

  it('releases and clears the created session when attach fails', async () => {
    const order: string[] = [];
    const error = new Error('attach failed');
    const warn = vi.fn();
    const actions = createActions({
      releaseSession: vi.fn(async () => {
        order.push('release');
      }),
      clearSession: vi.fn(async () => {
        order.push('clear');
      }),
      attachSession: vi.fn(async () => {
        throw error;
      }),
    });

    await expect(
      prepareSession({
        sessionActions: actions,
        modelId: 'qwen3',
        modeId: 'yolo',
        warn,
      }),
    ).rejects.toThrow(error);

    expect(actions.releaseSession).toHaveBeenCalledWith('session-1');
    expect(actions.clearSession).toHaveBeenCalledOnce();
    expect(order).toEqual(['release', 'clear']);
    expect(actions.setModel).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      '[WebShell] failed to attach new session:',
      error,
    );
  });

  it('still clears the created session when release after attach failure fails', async () => {
    const attachError = new Error('attach failed');
    const releaseError = new Error('release failed');
    const warn = vi.fn();
    const actions = createActions({
      attachSession: vi.fn(async () => {
        throw attachError;
      }),
      releaseSession: vi.fn(async () => {
        throw releaseError;
      }),
    });

    await expect(
      prepareSession({
        sessionActions: actions,
        warn,
      }),
    ).rejects.toThrow(attachError);

    expect(actions.releaseSession).toHaveBeenCalledWith('session-1');
    expect(actions.clearSession).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(
      '[WebShell] failed to release unattached session:',
      releaseError,
    );
  });

  it('forwards workspaceCwd to createSession', async () => {
    const actions = createActions();
    await prepareSession({
      sessionActions: actions,
      workspaceCwd: '/ws/secondary',
    });
    expect(actions.createSession).toHaveBeenCalledWith({
      workspaceCwd: '/ws/secondary',
    });
  });

  it('waits for onSessionCreated before attaching the session', async () => {
    const order: string[] = [];
    const callbackFinished = createDeferred<void>();
    const actions = createActions({
      createSession: vi.fn(async () => {
        order.push('create');
        return sessionResult;
      }),
      attachSession: vi.fn(async () => {
        order.push('attach');
      }),
    });

    const result = prepareSession({
      sessionActions: actions,
      onSessionCreated: vi.fn(async (sessionId) => {
        order.push(`callback:${sessionId}`);
        await callbackFinished.promise;
        order.push('callback-finished');
      }),
    });

    await vi.waitFor(() => {
      expect(order).toEqual(['create', 'callback:session-1']);
    });
    callbackFinished.resolve();
    await result;

    expect(order).toEqual([
      'create',
      'callback:session-1',
      'callback-finished',
      'attach',
    ]);
  });

  it('releases only the created session when the current session changes', async () => {
    let currentSessionId = 'session-1';
    const callbackFinished = createDeferred<void>();
    const actions = createActions();
    const warn = vi.fn();

    const result = prepareSession({
      sessionActions: actions,
      getCurrentSessionId: () => currentSessionId,
      onSessionCreated: () => callbackFinished.promise,
      warn,
    });
    await vi.waitFor(() => {
      expect(actions.createSession).toHaveBeenCalledOnce();
    });
    currentSessionId = 'session-2';
    callbackFinished.resolve();

    await expect(result).rejects.toThrow(
      'Session changed during onSessionCreated: expected session-1, found session-2',
    );
    expect(actions.attachSession).not.toHaveBeenCalled();
    expect(actions.releaseSession).toHaveBeenCalledWith('session-1');
    expect(actions.clearSession).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      '[WebShell] skipping clearSession: expected session-1, found session-2',
    );
  });

  it('does not set the model when the session changes during attach', async () => {
    let currentSessionId = 'session-1';
    const attachFinished = createDeferred<void>();
    const actions = createActions({
      attachSession: vi.fn(() => attachFinished.promise),
    });
    const warn = vi.fn();

    const result = prepareSession({
      sessionActions: actions,
      modelId: 'qwen3',
      getCurrentSessionId: () => currentSessionId,
      warn,
    });
    await vi.waitFor(() => {
      expect(actions.attachSession).toHaveBeenCalledOnce();
    });
    currentSessionId = 'session-2';
    attachFinished.resolve();

    await expect(result).rejects.toThrow(
      'Session changed while attaching: expected session-1, found session-2',
    );
    expect(actions.setModel).not.toHaveBeenCalled();
    expect(actions.releaseSession).toHaveBeenCalledWith('session-1');
    expect(actions.clearSession).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      '[WebShell] skipping clearSession: expected session-1, found session-2',
    );
  });

  it('cleans up the created session when onSessionCreated rejects', async () => {
    const error = new Error('callback failed');
    const actions = createActions();
    const warn = vi.fn();

    await expect(
      prepareSession({
        sessionActions: actions,
        onSessionCreated: vi.fn(async () => {
          throw error;
        }),
        warn,
      }),
    ).rejects.toThrow(error);

    expect(actions.attachSession).not.toHaveBeenCalled();
    expect(actions.releaseSession).toHaveBeenCalledWith('session-1');
    expect(actions.clearSession).toHaveBeenCalledOnce();
    expect(actions.setModel).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      '[WebShell] failed to run onSessionCreated:',
      error,
    );
  });

  it('cleans up when onSessionCreated times out', async () => {
    vi.useFakeTimers();
    const actions = createActions();

    const result = prepareSession({
      sessionActions: actions,
      onSessionCreated: () => new Promise<void>(() => {}),
      warn: vi.fn(),
    });
    const rejection = result.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(29_999);

    expect(actions.attachSession).not.toHaveBeenCalled();
    expect(actions.releaseSession).not.toHaveBeenCalled();
    expect(actions.clearSession).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);

    expect(await rejection).toEqual(new Error('onSessionCreated timed out'));
    expect(actions.attachSession).not.toHaveBeenCalled();
    expect(actions.releaseSession).toHaveBeenCalledWith('session-1');
    expect(actions.clearSession).toHaveBeenCalledOnce();
  });
});

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value?: T | PromiseLike<T>) => void;
} {
  let resolve!: (value?: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => {
    resolve = (value) => res(value as T | PromiseLike<T>);
  });
  return { promise, resolve };
}
