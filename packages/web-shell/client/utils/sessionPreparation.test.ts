import { describe, expect, it, vi } from 'vitest';
import { createAndAttachSessionForPrompt } from './sessionPreparation';

type CreateSessionArgs = Parameters<typeof createAndAttachSessionForPrompt>[0];
const sessionResult = { sessionId: 'session-1' };
const modelResult = { model: 'qwen3' };
const approvalModeResult = { mode: 'yolo' };

function createActions(
  overrides: Partial<CreateSessionArgs['sessionActions']> = {},
): CreateSessionArgs['sessionActions'] {
  return {
    createSession: vi.fn(async () => sessionResult),
    attachSession: vi.fn(async () => {}),
    closeSession: vi.fn(async () => {}),
    clearSession: vi.fn(async () => {}),
    setModel: vi.fn(async () => modelResult),
    setApprovalMode: vi.fn(async () => approvalModeResult),
    ...overrides,
  };
}

describe('createAndAttachSessionForPrompt', () => {
  it('attaches the session before a model switch failure can abort setup', async () => {
    const order: string[] = [];
    const error = new Error('model failed');
    const warn = vi.fn();
    const waitForModel = createDeferred<void>();
    const approvalStarted = createDeferred<void>();
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
        await waitForModel.promise;
        throw error;
      }),
      setApprovalMode: vi.fn(async () => {
        order.push('approval');
        approvalStarted.resolve();
        return approvalModeResult;
      }),
    });

    const result = createAndAttachSessionForPrompt({
      sessionActions: actions,
      modelId: 'qwen3',
      modeId: 'yolo',
      warn,
    });
    await approvalStarted.promise;
    waitForModel.resolve();
    await result;

    expect(order.slice(0, 2)).toEqual(['create', 'attach']);
    expect(order.slice(2).sort()).toEqual(['approval', 'model']);
    expect(warn).toHaveBeenCalledWith(
      '[WebShell] failed to set model for new session:',
      error,
    );
  });

  it('keeps the attached session when approval mode setup fails', async () => {
    const order: string[] = [];
    const error = new Error('mode failed');
    const warn = vi.fn();
    const waitForModel = createDeferred<void>();
    const approvalStarted = createDeferred<void>();
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
        await waitForModel.promise;
        return modelResult;
      }),
      setApprovalMode: vi.fn(async () => {
        order.push('approval');
        approvalStarted.resolve();
        throw error;
      }),
    });

    const result = createAndAttachSessionForPrompt({
      sessionActions: actions,
      modelId: 'qwen3',
      modeId: 'yolo',
      warn,
    });
    await approvalStarted.promise;
    waitForModel.resolve();
    await result;

    expect(order.slice(0, 2)).toEqual(['create', 'attach']);
    expect(order.slice(2).sort()).toEqual(['approval', 'model']);
    expect(warn).toHaveBeenCalledWith(
      '[WebShell] failed to set approval mode for new session:',
      error,
    );
  });

  it('closes and clears the created session when attach fails', async () => {
    const order: string[] = [];
    const error = new Error('attach failed');
    const warn = vi.fn();
    const actions = createActions({
      closeSession: vi.fn(async () => {
        order.push('close');
      }),
      clearSession: vi.fn(async () => {
        order.push('clear');
      }),
      attachSession: vi.fn(async () => {
        throw error;
      }),
    });

    await expect(
      createAndAttachSessionForPrompt({
        sessionActions: actions,
        modelId: 'qwen3',
        modeId: 'yolo',
        warn,
      }),
    ).rejects.toThrow(error);

    expect(actions.closeSession).toHaveBeenCalledOnce();
    expect(actions.clearSession).toHaveBeenCalledOnce();
    expect(order).toEqual(['close', 'clear']);
    expect(actions.setModel).not.toHaveBeenCalled();
    expect(actions.setApprovalMode).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      '[WebShell] failed to attach new session:',
      error,
    );
  });

  it('still clears the created session when close after attach failure fails', async () => {
    const attachError = new Error('attach failed');
    const closeError = new Error('close failed');
    const warn = vi.fn();
    const actions = createActions({
      attachSession: vi.fn(async () => {
        throw attachError;
      }),
      closeSession: vi.fn(async () => {
        throw closeError;
      }),
    });

    await expect(
      createAndAttachSessionForPrompt({
        sessionActions: actions,
        warn,
      }),
    ).rejects.toThrow(attachError);

    expect(actions.closeSession).toHaveBeenCalledOnce();
    expect(actions.clearSession).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(
      '[WebShell] failed to close unattached session:',
      closeError,
    );
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
