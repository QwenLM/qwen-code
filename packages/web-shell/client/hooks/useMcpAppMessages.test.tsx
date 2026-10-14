// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DaemonHttpError } from '@qwen-code/sdk/daemon';
import { I18nProvider, type WebShellLanguage } from '../i18n';
import { WebShellPortalRootContext } from '../portalRoot';
import type { McpAppMessages } from '../mcpAppHostContext';
import { PromptDispatchCancelledError } from '../utils/promptAdmission';
import {
  useMcpAppMessages,
  type McpAppPromptSubmission,
} from './useMcpAppMessages';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const mounted: Array<{ root: Root; container: HTMLElement }> = [];
afterEach(() => {
  for (const { root, container } of mounted.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
  vi.useRealTimers();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function setup() {
  const submit = vi
    .fn<(text: string, options: McpAppPromptSubmission) => Promise<unknown>>()
    .mockResolvedValue(undefined);
  let owner = {};
  let context: McpAppMessages | undefined;
  const captureOwner = () => {
    const captured = owner;
    return { isCurrent: () => captured === owner };
  };
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  function Harness({
    sessionId = 'session-a',
    clientId = 'client-a',
    enabled = true,
    language = 'en' as WebShellLanguage,
  }) {
    const message = useMcpAppMessages({
      sessionId,
      clientId,
      enabled,
      captureOwner,
      submit,
    });
    context = message.context;
    return (
      <I18nProvider language={language}>
        <WebShellPortalRootContext.Provider value={container}>
          {message.review}
        </WebShellPortalRootContext.Provider>
      </I18nProvider>
    );
  }
  const render = (props = {}) => act(() => root.render(<Harness {...props} />));
  render();
  mounted.push({ root, container });
  const request = (signal = new AbortController().signal) => {
    let result!: ReturnType<McpAppMessages['requestMessage']>;
    act(() => {
      result = context!.requestMessage({
        serverName: 'trusted-host-server',
        resourceUri: 'ui://host/resource',
        text: '<script>untrusted text</script>\nFull message',
        signal,
      });
    });
    return result;
  };
  const button = (text: string) =>
    Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === text,
    )!;
  return {
    submit,
    container,
    render,
    request,
    button,
    context: () => context,
    recover: () => {
      owner = {};
      render();
    },
  };
}

describe('MCP App host message review', () => {
  it('uses the host language inside the portal', async () => {
    const h = setup();
    h.render({ language: 'zh-CN' });
    const result = h.request();
    expect(h.container.textContent).toContain('审阅 App 消息');
    expect(h.container.textContent).toContain('目标会话');
    await act(async () => h.button('取消').click());
    expect(await result).toEqual({ isError: true });
  });
  it('waits for host confirmation and resolves at the real receipt, before turn completion', async () => {
    const modelTurn = deferred<unknown>();
    const h = setup();
    h.submit.mockReturnValue(modelTurn.promise);
    const result = h.request();
    let settled = false;
    void result.then(() => {
      settled = true;
    });
    expect(h.submit).not.toHaveBeenCalled();
    expect(h.container.textContent).toContain('trusted-host-server');
    expect(h.container.textContent).toContain('ui://host/resource');
    expect(h.container.textContent).toContain('session-a');
    expect(h.container.querySelector('pre')?.textContent).toBe(
      '<script>untrusted text</script>\nFull message',
    );
    expect(h.container.querySelector('script')).toBeNull();
    await act(async () => {
      const send = h.button('Send to session');
      send.click();
      send.click();
    });
    expect(h.submit).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);
    const submission = h.submit.mock.calls[0][1];
    act(() => submission.onDispatched());
    expect(settled).toBe(false);
    await act(async () =>
      submission.onAdmitted({ promptId: 'real-daemon-receipt' }),
    );
    expect(await result).toEqual({});
    expect(h.container.textContent).toContain('real-daemon-receipt');
    expect(h.container.textContent).toContain('Analysis may still be running');
    await act(async () => modelTurn.reject(new Error('later model failure')));
    expect(h.container.textContent).toContain('The session accepted');
  });

  it('rejects duplicate reviews and cancels with zero submissions', async () => {
    const h = setup();
    const first = h.request();
    expect(await h.request()).toEqual({ isError: true });
    await act(async () => h.button('cancel').click());
    expect(await first).toEqual({ isError: true });
    expect(h.submit).not.toHaveBeenCalled();
    expect(h.container.querySelector('[role="dialog"]')).toBeNull();
  });

  it.each(['cancel', 'rpc', 'recovery', 'session', 'client', 'disconnected'])(
    'invalidates async preparation on %s without a late write',
    async (reason) => {
      const h = setup();
      const gate = deferred<void>();
      const writes = vi.fn();
      h.submit.mockImplementation(async (_text, submission) => {
        await gate.promise;
        if (!submission.isCurrent() || submission.signal.aborted) return;
        submission.onDispatched();
        writes();
        submission.onAdmitted({ promptId: 'unexpected' });
      });
      const rpc = new AbortController();
      const result = h.request(rpc.signal);
      await act(async () => h.button('Send to session').click());
      await act(async () => {
        if (reason === 'cancel') h.button('cancel').click();
        if (reason === 'rpc') rpc.abort();
        if (reason === 'recovery') h.recover();
        if (reason === 'session') {
          h.render({ sessionId: 'session-b' });
        }
        if (reason === 'client') h.render({ clientId: 'client-b' });
        if (reason === 'disconnected') h.render({ enabled: false });
      });
      if (reason === 'session') h.render({ sessionId: 'session-a' });
      expect(await result).toEqual({ isError: true });
      await act(async () => gate.resolve());
      expect(writes).not.toHaveBeenCalled();
      expect(h.submit).toHaveBeenCalledTimes(1);
    },
  );

  it('keeps an unknown receipt visible after card cancellation and never resubmits', async () => {
    const h = setup();
    const turn = deferred<void>();
    h.submit.mockImplementation(async (_text, submission) => {
      submission.onDispatched();
      await turn.promise;
    });
    const rpc = new AbortController();
    const result = h.request(rpc.signal);
    const settled = vi.fn();
    void result.then(settled);
    await act(async () => h.button('Send to session').click());
    await act(async () => rpc.abort());
    expect(await result).toEqual({ isError: true });
    expect(settled).toHaveBeenCalledOnce();
    expect(h.container.textContent).toContain(
      'Acceptance could not be confirmed',
    );
    expect(h.container.textContent).toContain('session-a');
    expect(await h.request()).toEqual({ isError: true });
    expect(h.submit).toHaveBeenCalledTimes(1);
    await act(async () =>
      h.submit.mock.calls[0][1].onAdmitted({ promptId: 'late-real-receipt' }),
    );
    expect(h.container.textContent).toContain('The session accepted');
    expect(h.container.textContent).toContain('late-real-receipt');
    expect(await result).toEqual({ isError: true });
    await act(async () => turn.resolve());
  });

  it.each(['timeout', 'stop waiting'])(
    'releases an unknown request after %s when the App RPC ends',
    async (reason) => {
      vi.useFakeTimers();
      const h = setup();
      const turn = deferred<void>();
      h.submit.mockImplementation(async (_text, submission) => {
        submission.onDispatched();
        await turn.promise;
      });
      const rpc = new AbortController();
      const settled = vi.fn();
      const result = h.request(rpc.signal);
      void result.then(settled);
      await act(async () => h.button('Send to session').click());
      await act(async () => {
        if (reason === 'timeout') vi.advanceTimersByTime(90_000);
        else h.button('Stop waiting for receipt').click();
      });
      expect(settled).not.toHaveBeenCalled();
      await act(async () => rpc.abort());
      expect(settled).toHaveBeenCalledWith({ isError: true });
      expect(h.container.textContent).toContain(
        'Acceptance could not be confirmed',
      );
      await act(async () => h.button('close').click());
      const next = h.request();
      expect(h.container.textContent).toContain('Review the full message');
      await act(async () =>
        h.submit.mock.calls[0][1].onAdmitted({ promptId: 'late-old-receipt' }),
      );
      expect(h.container.textContent).not.toContain('late-old-receipt');
      expect(h.container.textContent).toContain('Review the full message');
      expect(h.submit).toHaveBeenCalledOnce();
      await act(async () => h.button('cancel').click());
      expect(await next).toEqual({ isError: true });
      await act(async () => turn.resolve());
    },
  );

  it.each([false, true])(
    'classifies dispatch failure using the real rejection boundary (definite=%s)',
    async (definite) => {
      const h = setup();
      h.submit.mockImplementation(async (_text, submission) => {
        submission.onDispatched();
        throw definite
          ? new DaemonHttpError(413, undefined, 'too large')
          : new Error('response lost');
      });
      const result = h.request();
      await act(async () => h.button('Send to session').click());
      expect(await result).toEqual({ isError: true });
      expect(h.container.textContent).toContain(
        definite
          ? 'The message was not accepted'
          : 'Acceptance could not be confirmed',
      );
      expect(h.container.querySelector('pre')).not.toBeNull();
      if (definite) expect(h.container.textContent).toContain('too large');
      expect(h.submit).toHaveBeenCalledTimes(1);
    },
  );

  it('does not treat a resolved send without an admission callback as success', async () => {
    const h = setup();
    const result = h.request();
    await act(async () => h.button('Send to session').click());
    expect(await result).toEqual({ isError: true });
    expect(h.container.textContent).toContain('Cancelled before sending');
  });

  it('settles a finished submission without a receipt as unknown after dispatch', async () => {
    const h = setup();
    h.submit.mockImplementation(async (_text, submission) => {
      submission.onDispatched();
    });
    const result = h.request();
    await act(async () => h.button('Send to session').click());
    expect(await result).toEqual({ isError: true });
    expect(h.container.textContent).toContain(
      'Acceptance could not be confirmed',
    );
    expect(await h.request()).toEqual({ isError: true });
  });

  it('shows a host refusal before dispatch as a failed review with its reason', async () => {
    const h = setup();
    h.submit.mockRejectedValue(new Error('The session is busy'));
    const result = h.request();
    await act(async () => h.button('Send to session').click());
    expect(await result).toEqual({ isError: true });
    expect(h.container.textContent).toContain('The message was not accepted');
    expect(h.container.textContent).toContain('The session is busy');
    expect(h.container.textContent).not.toContain(
      'Acceptance could not be confirmed',
    );
  });

  it('keeps the original session and text when the user stops waiting for a dispatched request', async () => {
    const h = setup();
    const pending = deferred<void>();
    h.submit.mockImplementation(async (_text, submission) => {
      submission.onDispatched();
      await pending.promise;
    });
    const result = h.request();
    const settled = vi.fn();
    void result.then(settled);
    await act(async () => h.button('Send to session').click());
    await act(async () => h.button('Stop waiting for receipt').click());
    expect(settled).not.toHaveBeenCalled();
    expect(h.container.textContent).toContain(
      'Acceptance could not be confirmed',
    );
    expect(h.container.textContent).toContain('session-a');
    expect(h.container.querySelector('pre')?.textContent).toBe(
      '<script>untrusted text</script>\nFull message',
    );
    expect(await h.request()).toEqual({ isError: true });
    await act(async () => pending.reject(new Error('lost response')));
    expect(await result).toEqual({ isError: true });
    expect(h.submit).toHaveBeenCalledTimes(1);
  });

  it('supports keyboard cancellation in the host portal', async () => {
    const h = setup();
    const result = h.request();
    expect(h.container.querySelector('[role="dialog"]')).not.toBeNull();
    await act(async () => {
      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
    });
    expect(await result).toEqual({ isError: true });
    expect(h.submit).not.toHaveBeenCalled();
  });

  it('expires review at 90 seconds without sending', async () => {
    vi.useFakeTimers();
    const h = setup();
    const result = h.request();
    await act(async () => vi.advanceTimersByTime(90_000));
    expect(await result).toEqual({ isError: true });
    expect(h.container.textContent).toContain('Review expired before sending');
    expect(h.submit).not.toHaveBeenCalled();
  });

  it('does not cancel accepted work when the iframe or review closes', async () => {
    const h = setup();
    const turn = deferred<void>();
    h.submit.mockImplementation(async (_text, submission) => {
      submission.onDispatched();
      submission.onAdmitted({ promptId: 'p' });
      await turn.promise;
    });
    const rpc = new AbortController();
    const result = h.request(rpc.signal);
    await act(async () => h.button('Send to session').click());
    expect(await result).toEqual({});
    await act(async () => {
      rpc.abort();
      h.button('close').click();
    });
    expect(h.submit).toHaveBeenCalledTimes(1);
    await act(async () => turn.resolve());
  });

  it('keeps capability stable while disconnected but refuses new requests', async () => {
    const h = setup();
    expect(h.context()).toMatchObject({
      sessionId: 'session-a',
    });
    const requestMessage = h.context()!.requestMessage;
    h.render({ enabled: false });
    expect(h.context()!.requestMessage).toBe(requestMessage);
    expect(await h.request()).toEqual({ isError: true });
    expect(h.submit).not.toHaveBeenCalled();
    h.render({ clientId: '' });
    expect(h.context()).toBeUndefined();
  });

  it.each(['stop waiting', 'timeout', 'disconnect'])(
    'waits for a late receipt after %s and settles before the turn completes',
    async (reason) => {
      vi.useFakeTimers();
      const h = setup();
      const turn = deferred<void>();
      h.submit.mockImplementation(async (_text, submission) => {
        submission.onDispatched();
        await turn.promise;
      });
      const result = h.request();
      const settled = vi.fn();
      void result.then(settled);
      await act(async () => h.button('Send to session').click());
      await act(async () => {
        if (reason === 'timeout') vi.advanceTimersByTime(90_000);
        else if (reason === 'disconnect') h.render({ enabled: false });
        else h.button('Stop waiting for receipt').click();
      });
      expect(h.container.textContent).toContain(
        'Acceptance could not be confirmed',
      );
      expect(settled).not.toHaveBeenCalled();
      expect(await h.request()).toEqual({ isError: true });
      await act(async () =>
        h.submit.mock.calls[0][1].onAdmitted({ promptId: 'late-receipt' }),
      );
      expect(await result).toEqual({});
      expect(h.container.textContent).toContain('late-receipt');
      expect(h.submit).toHaveBeenCalledOnce();
      await act(async () => turn.resolve());
    },
  );

  it('does not reopen a dismissed unknown review when its receipt arrives', async () => {
    const h = setup();
    const turn = deferred<void>();
    h.submit.mockImplementation(async (_text, submission) => {
      submission.onDispatched();
      await turn.promise;
    });
    const result = h.request();
    await act(async () => h.button('Send to session').click());
    await act(async () => h.button('Stop waiting for receipt').click());
    await act(async () => h.button('close').click());
    await act(async () =>
      h.submit.mock.calls[0][1].onAdmitted({ promptId: 'late' }),
    );
    expect(await result).toEqual({});
    expect(h.container.querySelector('[role="dialog"]')).toBeNull();
    const next = h.request();
    expect(h.container.textContent).toContain('Review the full message');
    await act(async () => h.button('cancel').click());
    expect(await next).toEqual({ isError: true });
    await act(async () => turn.resolve());
  });

  it('starts a fresh bounded admission wait after reviewing near expiry', async () => {
    vi.useFakeTimers();
    const h = setup();
    const turn = deferred<void>();
    h.submit.mockImplementation(async (_text, submission) => {
      submission.onDispatched();
      await turn.promise;
    });
    const result = h.request();
    await act(async () => vi.advanceTimersByTime(89_000));
    await act(async () => h.button('Send to session').click());
    await act(async () => vi.advanceTimersByTime(2_000));
    expect(h.container.textContent).toContain('Waiting for the session');
    await act(async () =>
      h.submit.mock.calls[0][1].onAdmitted({ promptId: 'p' }),
    );
    expect(await result).toEqual({});
    await act(async () => turn.resolve());
  });

  it.each([false, true])(
    'shows a definite veto as cancelled after previous attempt=%s',
    async (attempted) => {
      const h = setup();
      h.submit.mockImplementation(async (_text, submission) => {
        if (attempted) submission.onDispatched();
        throw new PromptDispatchCancelledError('Session client changed');
      });
      const result = h.request();
      await act(async () => h.button('Send to session').click());
      expect(await result).toEqual({ isError: true });
      expect(h.container.textContent).toContain('Cancelled before sending');
      expect(h.container.textContent).not.toContain(
        'Acceptance could not be confirmed',
      );
      expect(h.container.textContent).not.toContain('Session client changed');
      const next = h.request();
      await act(async () => h.button('cancel').click());
      expect(await next).toEqual({ isError: true });
    },
  );

  it.each([403, 404, 409, 500, 503])(
    'reports HTTP %s admission accurately',
    async (status) => {
      const h = setup();
      h.submit.mockImplementation(async (_text, submission) => {
        submission.onDispatched();
        throw new DaemonHttpError(
          status,
          undefined,
          'daemon rejected this request',
        );
      });
      const result = h.request();
      await act(async () => h.button('Send to session').click());
      expect(await result).toEqual({ isError: true });
      expect(h.container.textContent).toContain(
        status < 500
          ? 'The message was not accepted'
          : 'Acceptance could not be confirmed',
      );
      if (status < 500)
        expect(h.container.textContent).toContain(
          'daemon rejected this request',
        );
    },
  );
});
