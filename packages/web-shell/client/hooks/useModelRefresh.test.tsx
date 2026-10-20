// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useModelRefresh } from './useModelRefresh';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const mock = vi.hoisted(() => ({
  actions: { refreshModels: vi.fn() },
  connection: {
    status: 'connected',
    sessionId: 'a',
    workspaceCwd: '/a',
    sessionContext: { kind: 'workspace' as const, cwd: '/a' },
    capabilities: { features: ['workspace_model_reload'] },
  },
  guard: { capture: () => ({ isCurrent: () => true }) },
}));
vi.mock('@qwen-code/web-shell/daemon-react-sdk', () => ({
  useActions: () => mock.actions,
  useConnection: () => mock.connection,
  useDaemonSessionOwnerGuard: () => mock.guard,
}));
let root: Root;
let container: HTMLDivElement;
let state: ReturnType<typeof useModelRefresh>;
function Host() {
  state = useModelRefresh();
  return null;
}
beforeEach(async () => {
  mock.actions.refreshModels.mockReset();
  mock.connection.sessionId = 'a';
  mock.connection.capabilities.features = ['workspace_model_reload'];
  container = document.createElement('div');
  root = createRoot(container);
  await act(async () => root.render(<Host />));
});
afterEach(async () => {
  await act(async () => root.unmount());
});

describe('model refresh controls', () => {
  it('keeps composer props stable across unrelated parent renders', async () => {
    const before = state;
    await act(async () => root.render(<Host />));
    expect(state).toBe(before);
  });

  it('coalesces duplicate clicks and exposes a retryable error', async () => {
    let reject!: (error: Error) => void;
    mock.actions.refreshModels.mockImplementation(
      () =>
        new Promise<void>((_resolve, fail) => {
          reject = fail;
        }),
    );
    let first!: Promise<void>;
    await act(async () => {
      first = state.refresh!();
      void state.refresh!();
    });
    expect(state.refreshing).toBe(true);
    expect(mock.actions.refreshModels).toHaveBeenCalledOnce();
    await act(async () => {
      reject(new Error('offline'));
      await first;
    });
    expect(state.error).toBe('offline');
    expect(state.refreshing).toBe(false);
    mock.actions.refreshModels.mockResolvedValue(undefined);
    await act(async () => {
      await state.refresh!();
    });
    expect(state.error).toBeUndefined();
    expect(mock.actions.refreshModels).toHaveBeenCalledTimes(2);
  });

  it('keeps an in-flight refresh pending across equivalent context objects', async () => {
    const completions: Array<() => void> = [];
    mock.actions.refreshModels.mockImplementation(
      () =>
        new Promise<void>((done) => {
          completions.push(done);
        }),
    );
    let first!: Promise<void>;
    await act(async () => {
      first = state.refresh!();
    });
    mock.connection.sessionContext = { kind: 'workspace', cwd: '/a' };
    await act(async () => root.render(<Host />));
    const stayedPending = state.refreshing;
    await act(async () => {
      void state.refresh!();
    });
    const calls = mock.actions.refreshModels.mock.calls.length;
    await act(async () => {
      completions.forEach((done) => done());
    });
    expect(stayedPending).toBe(true);
    expect(calls).toBe(1);
    await first;
  });

  it('ignores an old request failure after changing sessions', async () => {
    let reject!: (error: Error) => void;
    mock.actions.refreshModels.mockImplementation(
      () =>
        new Promise<void>((_resolve, fail) => {
          reject = fail;
        }),
    );
    let pending!: Promise<void>;
    await act(async () => {
      pending = state.refresh!();
    });
    mock.connection.sessionId = 'b';
    await act(async () => root.render(<Host />));
    await act(async () => {
      reject(new Error('old failure'));
      await pending;
    });
    expect(state.error).toBeUndefined();
    expect(state.refreshing).toBe(false);
  });

  it('hides refresh when the daemon has not advertised it', async () => {
    mock.connection.capabilities.features = [];
    await act(async () => root.render(<Host />));
    expect(state.refresh).toBeUndefined();
  });
});
