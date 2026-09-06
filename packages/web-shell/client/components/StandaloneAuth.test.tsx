// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { StandaloneAuth } from './StandaloneAuth';
import { getDaemonToken } from '../config/daemon';
import type { WebShellLanguage } from '../i18n';

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  sessionStorage.clear();
});
async function mount(initialToken?: string, language?: WebShellLanguage) {
  await act(async () =>
    root.render(
      <StandaloneAuth
        baseUrl="http://daemon.test"
        initialToken={initialToken}
        language={language}
      >
        {(token) => <p>Connected {token}</p>}
      </StandaloneAuth>,
    ),
  );
}
function stubResponse({
  status,
  retryAfter,
  body,
}: {
  status: number;
  retryAfter?: string;
  body?: unknown;
}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: new Headers(retryAfter ? { 'Retry-After': retryAfter } : {}),
    json: async () => {
      if (body === undefined) throw new Error('no body');
      return body;
    },
  };
}
/** A fetch that only ever settles when the probe's own signal aborts it. */
function hangingFetch() {
  return vi.fn(
    (_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(new Error('The user aborted a request.')),
        );
      }),
  );
}
function submitButton() {
  return container.querySelector('button')!;
}
async function submitForm() {
  container
    .querySelector('form')!
    .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
}
it('retries an invalid token and stores the accepted token per tab', async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(stubResponse({ status: 401 }))
    .mockResolvedValueOnce(stubResponse({ status: 200 }));
  vi.stubGlobal('fetch', fetch);
  await mount('wrong');
  expect(container.textContent).toContain('Invalid or expired');
  expect(container.querySelector('input')?.type).toBe('password');
  act(() => {
    const input = container.querySelector('input')!;
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )!.set!.call(input, 'good');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(submitForm);
  expect(container.textContent).toContain('Connected good');
  expect(getDaemonToken()).toBe('good');
  expect(sessionStorage.getItem('qwen-daemon-token')).toBe('good');
  expect(fetch.mock.calls[1][1].headers).toEqual({
    Authorization: 'Bearer good',
  });
});
it('distinguishes policy rejection from authentication failure', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(stubResponse({ status: 403 })),
  );
  await mount();
  expect(container.textContent).toContain('Origin or Host policy');
  expect(container.querySelector('input')).toBeNull();
});
it('keeps tokenless loopback access working', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(stubResponse({ status: 200 })),
  );
  await mount();
  expect(container.textContent).toBe('Connected ');
});
it('times out a hung probe and re-probes without a click', async () => {
  vi.useFakeTimers();
  const fetch = hangingFetch();
  vi.stubGlobal('fetch', fetch);
  await mount();
  expect(fetch).toHaveBeenCalledTimes(1);
  await act(async () => {
    vi.advanceTimersByTime(9_000);
  });
  expect(container.textContent).toContain('Connecting');
  await act(async () => {
    vi.advanceTimersByTime(1_000);
  });
  expect(container.textContent).toContain('Cannot reach the daemon');
  expect(submitButton().disabled).toBe(false);
  await act(async () => {
    vi.advanceTimersByTime(2_000);
  });
  expect(fetch).toHaveBeenCalledTimes(2);
});
it('aborts the in-flight probe when the user submits again', async () => {
  const fetch = hangingFetch();
  vi.stubGlobal('fetch', fetch);
  await mount();
  const first = fetch.mock.calls[0]?.[1]?.signal as AbortSignal;
  await act(submitForm);
  expect(first.aborted).toBe(true);
  expect(fetch).toHaveBeenCalledTimes(2);
  // The superseded probe must not report its own abort as a failure.
  expect(container.textContent).toContain('Connecting');
});
it('waits out a cold start advertised by Retry-After', async () => {
  vi.useFakeTimers();
  const cold = stubResponse({ status: 503, retryAfter: '1' });
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(cold)
    .mockResolvedValueOnce(cold)
    .mockResolvedValueOnce(stubResponse({ status: 200 }));
  vi.stubGlobal('fetch', fetch);
  await mount();
  expect(container.textContent).toContain('Daemon is starting');
  await act(async () => {
    vi.advanceTimersByTime(1_000);
  });
  // Still cold: the scheduled retry keeps going until the daemon answers.
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(container.textContent).toContain('Daemon is starting');
  await act(async () => {
    vi.advanceTimersByTime(1_000);
  });
  expect(fetch).toHaveBeenCalledTimes(3);
  expect(container.textContent).toBe('Connected ');
});
it('reports a permanent startup failure and stops probing', async () => {
  vi.useFakeTimers();
  const fetch = vi
    .fn()
    .mockResolvedValue(stubResponse({ status: 503, body: { error: 'boom' } }));
  vi.stubGlobal('fetch', fetch);
  await mount();
  expect(container.textContent).toContain('Daemon failed to start. boom');
  expect(submitButton().disabled).toBe(false);
  await act(async () => {
    vi.advanceTimersByTime(60_000);
  });
  expect(fetch).toHaveBeenCalledTimes(1);
});
it('re-probes by itself after a network error', async () => {
  vi.useFakeTimers();
  const fetch = vi
    .fn()
    .mockRejectedValueOnce(new Error('Failed to fetch'))
    .mockResolvedValueOnce(stubResponse({ status: 200 }));
  vi.stubGlobal('fetch', fetch);
  await mount();
  expect(container.textContent).toContain('Cannot reach the daemon');
  await act(async () => {
    vi.advanceTimersByTime(2_000);
  });
  expect(container.textContent).toBe('Connected ');
});
it('renders the zh-CN copy for an invalid token', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(stubResponse({ status: 401 })),
  );
  await mount('wrong', 'zh-CN');
  expect(container.textContent).toContain('连接到 Qwen Code');
  expect(container.textContent).toContain('令牌无效或已过期');
  expect(container.textContent).not.toContain('Invalid or expired');
});
