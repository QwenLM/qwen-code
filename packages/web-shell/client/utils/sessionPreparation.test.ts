import { describe, expect, it, vi } from 'vitest';
import { createAndAttachSessionForPrompt } from './sessionPreparation';

type CreateSessionArgs = Parameters<typeof createAndAttachSessionForPrompt>[0];
const sessionResult = { sessionId: 'session-1' };
const modelResult = { model: 'qwen3' };

function createActions(
  overrides: Partial<CreateSessionArgs['sessionActions']> = {},
): CreateSessionArgs['sessionActions'] {
  return {
    createSession: vi.fn(async () => sessionResult),
    attachSession: vi.fn(async () => {}),
    closeSession: vi.fn(async () => {}),
    clearSession: vi.fn(async () => {}),
    setModel: vi.fn(async () => modelResult),
    ...overrides,
  };
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

    await createAndAttachSessionForPrompt({
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

    await createAndAttachSessionForPrompt({
      sessionActions: actions,
      modeId: 'not-a-mode',
    });

    expect(actions.createSession).toHaveBeenCalledWith({
      workspaceCwd: undefined,
    });
  });

  it('creates the session without a model call when no model is selected', async () => {
    const actions = createActions();

    await createAndAttachSessionForPrompt({
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
      createAndAttachSessionForPrompt({
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
      createAndAttachSessionForPrompt({
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
    // Nothing was created client-side, so there is nothing to close/clear.
    expect(actions.closeSession).not.toHaveBeenCalled();
    expect(actions.clearSession).not.toHaveBeenCalled();
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

  it('forwards workspaceCwd to createSession', async () => {
    const actions = createActions();
    await createAndAttachSessionForPrompt({
      sessionActions: actions,
      workspaceCwd: '/ws/secondary',
    });
    expect(actions.createSession).toHaveBeenCalledWith({
      workspaceCwd: '/ws/secondary',
    });
  });
});
