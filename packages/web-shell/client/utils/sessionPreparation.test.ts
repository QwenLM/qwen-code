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
      setApprovalMode: vi.fn(async () => {
        order.push('approval');
        return approvalModeResult;
      }),
    });

    await createAndAttachSessionForPrompt({
      sessionActions: actions,
      modelId: 'qwen3',
      modeId: 'yolo',
      warn,
    });

    expect(order).toEqual(['create', 'attach', 'model', 'approval']);
    expect(warn).toHaveBeenCalledWith(
      '[WebShell] failed to set model for new session:',
      error,
    );
  });

  it('keeps the attached session when approval mode setup fails', async () => {
    const order: string[] = [];
    const error = new Error('mode failed');
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
        return modelResult;
      }),
      setApprovalMode: vi.fn(async () => {
        order.push('approval');
        throw error;
      }),
    });

    await createAndAttachSessionForPrompt({
      sessionActions: actions,
      modelId: 'qwen3',
      modeId: 'yolo',
      warn,
    });

    expect(order).toEqual(['create', 'attach', 'model', 'approval']);
    expect(warn).toHaveBeenCalledWith(
      '[WebShell] failed to set approval mode for new session:',
      error,
    );
  });
});
