// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DaemonConnectionState } from '../daemon/session/types';
import type { DaemonTranscriptBlock } from '@qwen-code/sdk/daemon';
import { I18nProvider } from '../i18n';
import { SessionRecoveryBanner } from './SessionRecoveryBanner';

const state = vi.hoisted(() => ({
  connection: {} as DaemonConnectionState,
  streaming: 'idle',
  generation: 0,
  recoveryGeneration: 0,
  continueSession: vi.fn<() => Promise<void>>(),
  blocks: [] as DaemonTranscriptBlock[],
}));

vi.mock('@qwen-code/web-shell/daemon-react-sdk', () => ({
  useConnection: () => state.connection,
  useActions: () => ({ continueSession: state.continueSession }),
  useStreamingState: () => state.streaming,
  useTranscriptBlocks: () => state.blocks,
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
    state.blocks = [];
    state.continueSession.mockReset().mockResolvedValue(undefined);
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
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

  function quota(
    id = 'quota-1',
    text = '403 用户 Token 限额已触发（每5小时）',
  ) {
    state.blocks = [{ id, kind: 'error', source: 'turn_error', text }];
  }

  function button(text: string) {
    return Array.from(container.querySelectorAll('button')).find(
      (element) => element.textContent === text,
    )!;
  }

  async function advance(ms: number) {
    await act(async () => vi.advanceTimersByTimeAsync(ms));
  }

  it('waits for opt-in, displays Chinese actions, resumes once after the delay', async () => {
    vi.useFakeTimers();
    quota();
    render(false, 'zh-CN');
    expect(button('继续执行')).toBeDefined();
    expect(button('可用时继续')).toBeDefined();
    await advance(60_000);
    expect(state.continueSession).not.toHaveBeenCalled();
    act(() => button('可用时继续').click());
    expect(container.textContent).toContain('等待模型恢复可用');
    await advance(59_999);
    expect(state.continueSession).not.toHaveBeenCalled();
    await advance(1);
    expect(state.continueSession).toHaveBeenCalledOnce();
    await advance(20 * 60_000);
    expect(state.continueSession).toHaveBeenCalledOnce();
    expect(container.textContent).not.toContain('等待模型恢复可用');
  });

  it.each([
    'cancel',
    'manual',
    'unmount',
    'model',
    'owner',
    'blocked',
    'disconnect',
    'new-turn',
    'recovery-generation',
  ])('stops scheduled retries on %s', async (transition) => {
    vi.useFakeTimers();
    quota();
    render();
    act(() => button('Resume when available').click());
    if (transition === 'cancel') act(() => button('Cancel waiting').click());
    if (transition === 'manual')
      await act(async () => button('Continue execution').click());
    if (transition === 'unmount') act(() => root.render(null));
    if (transition === 'model') state.connection.currentModel = 'other-model';
    if (transition === 'owner') state.generation++;
    if (transition === 'recovery-generation') state.recoveryGeneration++;
    if (transition === 'disconnect') state.connection.status = 'disconnected';
    if (transition === 'new-turn')
      state.blocks = [
        ...state.blocks,
        {
          id: 'new',
          kind: 'text',
          role: 'user',
          text: 'Other task',
        },
      ];
    if (!['cancel', 'manual', 'unmount'].includes(transition))
      render(transition === 'blocked');
    await advance(10 * 60_000);
    expect(state.continueSession).toHaveBeenCalledTimes(
      transition === 'manual' ? 1 : 0,
    );
  });

  it('backs off only after recovery is refreshed and survives its own active turn', async () => {
    vi.useFakeTimers();
    quota();
    let reject!: (error: Error) => void;
    state.continueSession.mockImplementationOnce(() => {
      state.recoveryGeneration++;
      state.connection.context!.recovery!.canContinue = false;
      return new Promise<void>((_resolve, fail) => {
        reject = fail;
      });
    });
    render();
    act(() => button('Resume when available').click());
    await advance(60_000);
    state.streaming = 'responding';
    render(true);
    expect(container.querySelector('button')).toBeNull();
    state.streaming = 'idle';
    state.recoveryGeneration++;
    quota('quota-2');
    render();
    await act(async () =>
      reject(
        Object.assign(new Error('Rate limit exceeded. Try again later.'), {
          _daemonTurnError: true,
        }),
      ),
    );
    render();
    expect(button('Cancel waiting')).toBeDefined();
    await advance(120_000);
    expect(state.continueSession).toHaveBeenCalledOnce();
    state.connection.context!.recovery!.canContinue = true;
    render();
    await advance(0);
    expect(state.continueSession).toHaveBeenCalledTimes(2);
    await advance(20 * 60_000);
    expect(state.continueSession).toHaveBeenCalledTimes(2);
  });

  it.each(['auth', 'unknown-admission', 'degraded', 'clean'])(
    'stops an automatic attempt after %s',
    async (failure) => {
      vi.useFakeTimers();
      quota();
      state.continueSession.mockImplementationOnce(async () => {
        state.recoveryGeneration++;
        if (failure === 'degraded' || failure === 'clean') {
          state.connection.context!.recovery = {
            kind: failure === 'clean' ? 'clean' : 'degraded_history',
            canContinue: false,
          };
        }
        quota(
          'quota-2',
          failure === 'auth' ? '403 Forbidden' : '429 Rate limit exceeded',
        );
        throw Object.assign(
          new Error(
            failure === 'unknown-admission'
              ? 'Failed to fetch'
              : state.blocks[0].kind === 'error'
                ? state.blocks[0].text
                : '',
          ),
          failure === 'unknown-admission' ? {} : { _daemonTurnError: true },
        );
      });
      render();
      act(() => button('Resume when available').click());
      await advance(60_000);
      render();
      await advance(6 * 60 * 60_000);
      expect(state.continueSession).toHaveBeenCalledOnce();
      expect(container.textContent).not.toContain(
        'Waiting for model availability',
      );
    },
  );

  it('does not offer waiting for ordinary auth errors or an older quota failure', () => {
    quota('auth', '403 Invalid API key');
    render();
    expect(button('Resume when available')).toBeUndefined();
    quota();
    state.blocks = [
      ...state.blocks,
      { id: 'cancelled', kind: 'prompt_cancelled' },
    ];
    render();
    expect(button('Resume when available')).toBeUndefined();
  });

  it('backs off to five minutes and recognizes a terminal 429 code without matching text', async () => {
    vi.useFakeTimers();
    quota();
    state.continueSession.mockImplementation(async () => {
      state.recoveryGeneration++;
      state.blocks = [
        {
          id: `quota-${state.continueSession.mock.calls.length + 1}`,
          kind: 'error',
          source: 'turn_error',
          text: 'Capacity exhausted',
          code: '429',
        },
      ];
      throw Object.assign(new Error('Capacity exhausted'), {
        _daemonTurnError: true,
        body: '429',
      });
    });
    render();
    act(() => button('Resume when available').click());
    for (const [index, delay] of [
      60_000, 120_000, 240_000, 300_000, 300_000,
    ].entries()) {
      await advance(delay - 1);
      expect(state.continueSession).toHaveBeenCalledTimes(index);
      await advance(1);
      expect(state.continueSession).toHaveBeenCalledTimes(index + 1);
    }
    act(() => button('Cancel waiting').click());
    await advance(6 * 60 * 60_000);
    expect(state.continueSession).toHaveBeenCalledTimes(5);
  });

  it('cancels consent if other activity overtakes an outstanding recovery read', async () => {
    vi.useFakeTimers();
    quota();
    state.continueSession.mockImplementationOnce(async () => {
      state.recoveryGeneration++;
      state.connection.context!.recovery!.canContinue = false;
      quota('quota-2');
      throw Object.assign(new Error('Rate limit exceeded'), {
        _daemonTurnError: true,
      });
    });
    render();
    act(() => button('Resume when available').click());
    await advance(60_000);
    state.recoveryGeneration++;
    state.connection.context!.recovery!.canContinue = true;
    quota('other-task-quota');
    render();
    await advance(300_000);
    expect(state.continueSession).toHaveBeenCalledOnce();
  });

  it('honors a surfaced retry delay and stops at the six-hour deadline', async () => {
    vi.useFakeTimers();
    quota('quota-1', 'Quota exceeded. Will reset at 2099-01-01T00:00:00Z');
    render();
    act(() => button('Resume when available').click());
    await advance(6 * 60 * 60_000);
    expect(state.continueSession).not.toHaveBeenCalled();
    expect(container.textContent).toContain('Waiting stopped after six hours');
    quota('quota-2', '429 Too many requests. Retry after 2 seconds');
    render();
    act(() => button('Resume when available').click());
    await advance(1999);
    expect(state.continueSession).not.toHaveBeenCalled();
    await advance(1);
    expect(state.continueSession).toHaveBeenCalledOnce();
  });

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
