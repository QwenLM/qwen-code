// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DaemonConnectionState } from '../daemon/session/types';
import { I18nProvider } from '../i18n';
import { SessionRecoveryBanner } from './SessionRecoveryBanner';

const state = vi.hoisted(() => ({
  connection: {} as DaemonConnectionState,
  streaming: 'idle',
  generation: 0,
  recoveryGeneration: 0,
  continueSession: vi.fn<() => Promise<void>>(),
}));

vi.mock('@qwen-code/web-shell/daemon-react-sdk', () => ({
  useConnection: () => state.connection,
  useActions: () => ({ continueSession: state.continueSession }),
  useStreamingState: () => state.streaming,
  useDaemonSessionOwnerGuard: () => ({
    capture: (options?: { includeRecovery?: boolean }) => {
      const generation = state.generation;
      const recoveryGeneration = state.recoveryGeneration;
      return {
        isCurrent: () =>
          generation === state.generation &&
          (!options?.includeRecovery ||
            recoveryGeneration === state.recoveryGeneration),
      };
    },
  }),
}));

describe('SessionRecoveryBanner', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    state.connection = {
      status: 'connected',
      sessionId: 'session-a',
      workspaceCwd: '/workspace',
      context: {
        v: 1,
        sessionId: 'session-a',
        workspaceCwd: '/workspace',
        state: {},
        recovery: { kind: 'interrupted_prompt', canContinue: true },
      },
    };
    state.streaming = 'idle';
    state.generation = 0;
    state.recoveryGeneration = 0;
    state.continueSession.mockReset().mockResolvedValue(undefined);
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function render(blocked = false, language: 'en' | 'zh-CN' = 'en') {
    act(() => {
      root.render(
        <I18nProvider language={language}>
          <SessionRecoveryBanner blocked={blocked} />
        </I18nProvider>,
      );
    });
  }

  it('waits for an explicit click and prevents duplicate submissions', async () => {
    let finish!: () => void;
    state.continueSession.mockReturnValue(
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
    );
    render();
    expect(container.textContent).toContain('Continue execution');
    expect(state.continueSession).not.toHaveBeenCalled();
    const button = container.querySelector('button')!;
    act(() => {
      button.click();
      button.click();
    });
    expect(state.continueSession).toHaveBeenCalledOnce();
    expect(button.disabled).toBe(true);
    await act(async () => finish());
  });

  it('shows tool interruption in Chinese and history gaps without a button', () => {
    state.connection.context!.recovery = {
      kind: 'interrupted_turn',
      canContinue: true,
    };
    render(false, 'zh-CN');
    expect(container.textContent).toContain('部分工具结果未保存');
    expect(container.querySelector('button')?.textContent).toBe('继续执行');
    state.connection.context!.recovery = {
      kind: 'degraded_history',
      canContinue: false,
    };
    render(false, 'zh-CN');
    expect(container.textContent).toContain('会话历史不完整');
    expect(container.querySelector('button')).toBeNull();
  });

  it.each([
    'unsupported',
    'clean',
    'busy',
    'disconnected',
    'loading',
    'catching-up',
    'wrong-session',
    'blocked',
  ])('does not offer continuation when %s', (condition) => {
    if (condition === 'unsupported')
      state.connection.context!.recovery = undefined;
    if (condition === 'clean')
      state.connection.context!.recovery = {
        kind: 'clean',
        canContinue: false,
      };
    if (condition === 'busy') state.streaming = 'responding';
    if (condition === 'disconnected') state.connection.status = 'disconnected';
    if (condition === 'loading') state.connection.loadingTranscript = true;
    if (condition === 'catching-up') state.connection.catchingUp = true;
    if (condition === 'wrong-session')
      state.connection.context!.sessionId = 'other';
    render(condition === 'blocked');
    expect(container.querySelector('button')).toBeNull();
    expect(state.continueSession).not.toHaveBeenCalled();
  });

  it.each(['session-a', 'session-b'])(
    'clears an old attempt without showing its failure after replacing the owner with %s',
    async (sessionId) => {
      let fail!: (error: Error) => void;
      state.continueSession.mockReturnValue(
        new Promise<void>((_resolve, reject) => {
          fail = reject;
        }),
      );
      render();
      act(() => container.querySelector('button')!.click());
      state.generation++;
      state.connection.sessionId = sessionId;
      state.connection.context!.sessionId = sessionId;
      render();
      await act(async () => fail(new Error('old session failed')));
      expect(container.querySelector('[role="alert"]')).toBeNull();
      expect(container.querySelector('button')?.disabled).toBe(false);
    },
  );

  it('does not report an admitted turn error as a continuation failure', async () => {
    state.continueSession.mockRejectedValue(
      Object.assign(new Error('Model rate limit'), { _daemonTurnError: true }),
    );
    render();
    await act(async () => container.querySelector('button')!.click());
    expect(state.continueSession).toHaveBeenCalledOnce();
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.querySelector('button')?.disabled).toBe(false);
  });

  it.each([
    'owner-replaced',
    'new-activity',
    'reconciled-clean',
    'reconciled-interrupted',
  ])(
    'keeps an unknown failure visible without retry until %s',
    async (transition) => {
      state.continueSession.mockImplementation(async () => {
        state.connection.context!.recovery = {
          ...state.connection.context!.recovery!,
          canContinue: false,
        };
        throw new TypeError('Failed to fetch');
      });
      render();
      await act(async () => container.querySelector('button')!.click());
      expect(container.querySelector('[role="alert"]')?.textContent).toBe(
        'Could not continue the conversation.',
      );
      expect(container.querySelector('button')).toBeNull();
      expect(state.continueSession).toHaveBeenCalledOnce();

      if (transition === 'owner-replaced') {
        state.generation++;
      } else if (transition === 'new-activity') {
        state.streaming = 'responding';
        render();
        state.streaming = 'idle';
      } else {
        state.recoveryGeneration++;
        state.connection.context!.recovery = {
          kind:
            transition === 'reconciled-clean' ? 'clean' : 'interrupted_prompt',
          canContinue: transition === 'reconciled-interrupted',
        };
      }
      render();
      expect(container.querySelector('[role="alert"]')).toBeNull();
      expect(container.querySelector('button') !== null).toBe(
        transition === 'reconciled-interrupted',
      );
      expect(state.continueSession).toHaveBeenCalledOnce();
    },
  );
});
