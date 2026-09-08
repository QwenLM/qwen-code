// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { StandaloneAuth } from './StandaloneAuth';
import AppStyles from '../App.module.css';
import { getDaemonToken } from '../config/daemon';
import type { WebShellLanguage } from '../i18n';
import type { WebShellTheme } from '../themeContext';

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
async function mount(
  initialToken?: string,
  language?: WebShellLanguage,
  theme?: WebShellTheme,
) {
  await act(async () =>
    root.render(
      <StandaloneAuth
        baseUrl="http://daemon.test"
        initialToken={initialToken}
        language={language}
        theme={theme}
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
  const fetch = vi.fn().mockResolvedValue(
    stubResponse({
      status: 503,
      body: { code: 'daemon_runtime_failed', error: 'boom' },
    }),
  );
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
  // The token-safety hint is the only in-UI warning distinguishing the real
  // gate from a look-alike page; pin it per language.
  expect(container.textContent).toContain('完整访问权限');
});

it('probes the daemon capabilities endpoint', async () => {
  const fetch = vi.fn().mockResolvedValue(stubResponse({ status: 200 }));
  vi.stubGlobal('fetch', fetch);
  await mount();
  expect(fetch.mock.calls[0][0]).toBe('http://daemon.test/capabilities');
});

it('auto-retries a generic 5xx and then mounts', async () => {
  vi.useFakeTimers();
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(stubResponse({ status: 500 }))
    .mockResolvedValueOnce(stubResponse({ status: 200 }));
  vi.stubGlobal('fetch', fetch);
  await mount();
  expect(container.textContent).toContain('Daemon is not ready. Retrying…');
  await act(async () => {
    vi.advanceTimersByTime(2_000);
  });
  expect(container.textContent).toBe('Connected ');
});

it('honors Retry-After on rate limiting without claiming a cold start', async () => {
  vi.useFakeTimers();
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(stubResponse({ status: 429, retryAfter: '1' }))
    .mockResolvedValueOnce(stubResponse({ status: 200 }));
  vi.stubGlobal('fetch', fetch);
  await mount();
  expect(container.textContent).toContain('Daemon is not ready. Retrying…');
  expect(container.textContent).not.toContain('Daemon is starting…');
  await act(async () => {
    vi.advanceTimersByTime(1_000);
  });
  expect(container.textContent).toBe('Connected ');
});

it('parses an HTTP-date Retry-After', async () => {
  vi.useFakeTimers();
  const when = new Date(Date.now() + 1_000).toUTCString();
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(stubResponse({ status: 503, retryAfter: when }))
    .mockResolvedValueOnce(stubResponse({ status: 200 }));
  vi.stubGlobal('fetch', fetch);
  await mount();
  expect(container.textContent).toContain('Daemon is starting…');
  await act(async () => {
    vi.advanceTimersByTime(1_500);
  });
  expect(container.textContent).toBe('Connected ');
});

it('clamps an outsized Retry-After to the retry ceiling', async () => {
  vi.useFakeTimers();
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(stubResponse({ status: 503, retryAfter: '3600' }))
    .mockResolvedValueOnce(stubResponse({ status: 200 }));
  vi.stubGlobal('fetch', fetch);
  await mount();
  expect(container.textContent).toContain('Daemon is starting…');
  await act(async () => {
    vi.advanceTimersByTime(29_000);
  });
  expect(fetch).toHaveBeenCalledTimes(1);
  await act(async () => {
    vi.advanceTimersByTime(1_000);
  });
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(container.textContent).toBe('Connected ');
});

it('floors a zero Retry-After at one second', async () => {
  vi.useFakeTimers();
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(stubResponse({ status: 503, retryAfter: '0' }))
    .mockResolvedValueOnce(stubResponse({ status: 200 }));
  vi.stubGlobal('fetch', fetch);
  await mount();
  await act(async () => {
    vi.advanceTimersByTime(999);
  });
  expect(fetch).toHaveBeenCalledTimes(1);
  await act(async () => {
    vi.advanceTimersByTime(1);
  });
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(container.textContent).toBe('Connected ');
});

it('floors an already-past HTTP-date Retry-After', async () => {
  vi.useFakeTimers();
  const past = new Date(Date.now() - 60_000).toUTCString();
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(stubResponse({ status: 503, retryAfter: past }))
    .mockResolvedValueOnce(stubResponse({ status: 200 }));
  vi.stubGlobal('fetch', fetch);
  await mount();
  await act(async () => {
    vi.advanceTimersByTime(1_000);
  });
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(container.textContent).toBe('Connected ');
});

it('falls back to the fixed delay for an unparsable Retry-After', async () => {
  vi.useFakeTimers();
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(stubResponse({ status: 503, retryAfter: 'soon' }))
    .mockResolvedValueOnce(stubResponse({ status: 200 }));
  vi.stubGlobal('fetch', fetch);
  await mount();
  await act(async () => {
    vi.advanceTimersByTime(1_999);
  });
  expect(fetch).toHaveBeenCalledTimes(1);
  await act(async () => {
    vi.advanceTimersByTime(1);
  });
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(container.textContent).toBe('Connected ');
});

it('leaves the submit button enabled once the token form is up', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(stubResponse({ status: 401 })),
  );
  await mount();
  expect(container.querySelector('input')).not.toBeNull();
  expect(submitButton().disabled).toBe(false);
  expect(container.textContent).toContain('grants full access to the daemon');
});

it('resets the live region when a retry probe starts', async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(stubResponse({ status: 401 }))
    .mockImplementation(hangingFetch());
  vi.stubGlobal('fetch', fetch);
  await mount('wrong');
  expect(container.textContent).toContain('Invalid or expired');
  act(() => {
    const input = container.querySelector('input')!;
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )!.set!.call(input, 'good');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(submitForm);
  // The operator must see the submit accepted, not the stale 401 copy, for
  // the whole in-flight probe.
  const live = container.querySelector('[role="status"]');
  expect(live?.textContent).toContain('Connecting');
  expect(live?.textContent).not.toContain('Invalid or expired');
});

it('keeps a manually typed token after a rejected submit', async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(stubResponse({ status: 401 }))
    .mockResolvedValueOnce(stubResponse({ status: 401 }));
  vi.stubGlobal('fetch', fetch);
  await mount();
  act(() => {
    const input = container.querySelector('input')!;
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )!.set!.call(input, 'typo-token');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(submitForm);
  expect(container.textContent).toContain('Invalid or expired');
  // Only a rejected initial credential is cleared; a typo the operator just
  // made must stay editable instead of vanishing behind the masked input.
  expect(container.querySelector('input')!.value).toBe('typo-token');
});

it('treats a bare 503 without the failure code as transient', async () => {
  vi.useFakeTimers();
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(stubResponse({ status: 503, body: { code: 'x' } }))
    .mockResolvedValueOnce(stubResponse({ status: 200 }));
  vi.stubGlobal('fetch', fetch);
  await mount();
  await act(async () => {
    vi.advanceTimersByTime(2_000);
  });
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(container.textContent).toBe('Connected ');
});

it('clears a rejected stored credential instead of pre-filling it', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(stubResponse({ status: 401 })),
  );
  await mount('stale-token');
  expect(container.querySelector('input[type="password"]')?.value).toBe('');
  expect(container.textContent).toContain('Invalid or expired');
});

it('scopes and themes the gate root like the app root', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(stubResponse({ status: 401 })),
  );
  await mount();
  const gate = container.querySelector('[data-web-shell-gate]');
  expect(gate).not.toBeNull();
  expect(gate?.hasAttribute('data-web-shell-root')).toBe(true);
  expect(gate?.hasAttribute('data-web-shell-shadcn')).toBe(true);
  expect(gate?.classList.contains('dark')).toBe(true);
  expect(gate?.classList.contains(AppStyles.themeDark)).toBe(true);
});

it('applies the light palette when requested', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(stubResponse({ status: 401 })),
  );
  await mount(undefined, 'en', 'light');
  const gate = container.querySelector('[data-web-shell-gate]');
  expect(gate?.classList.contains('dark')).toBe(false);
  expect(gate?.classList.contains(AppStyles.themeLight)).toBe(true);
});

it('keeps the transient status and an enabled button during automatic retries', async () => {
  vi.useFakeTimers();
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(stubResponse({ status: 503, retryAfter: '1' }))
    .mockImplementation(hangingFetch());
  vi.stubGlobal('fetch', fetch);
  await mount();
  expect(container.textContent).toContain('Daemon is starting');
  // Mid-cycle: the automatic probe is in flight, but the transient copy and
  // the button stay put — a manual retry can always jump the queue, and a
  // screen reader is not re-announced once per cycle.
  await act(async () => {
    vi.advanceTimersByTime(1_000);
  });
  expect(fetch).toHaveBeenCalledTimes(2);
  const live = container.querySelector('[role="status"]');
  expect(live?.textContent).toContain('Daemon is starting');
  expect(submitButton().disabled).toBe(false);
});

it('clamps an HTTP-date Retry-After to the ceiling too', async () => {
  vi.useFakeTimers();
  const when = new Date(Date.now() + 3_600_000).toUTCString();
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(stubResponse({ status: 503, retryAfter: when }))
    .mockResolvedValueOnce(stubResponse({ status: 200 }));
  vi.stubGlobal('fetch', fetch);
  await mount();
  await act(async () => {
    vi.advanceTimersByTime(29_000);
  });
  expect(fetch).toHaveBeenCalledTimes(1);
  await act(async () => {
    vi.advanceTimersByTime(1_000);
  });
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(container.textContent).toBe('Connected ');
});

it('treats a failed runtime as permanent even with Retry-After attached', async () => {
  vi.useFakeTimers();
  const fetch = vi.fn().mockResolvedValue(
    stubResponse({
      status: 503,
      retryAfter: '5',
      body: { code: 'daemon_runtime_failed', error: 'boom' },
    }),
  );
  vi.stubGlobal('fetch', fetch);
  await mount();
  expect(container.textContent).toContain('Daemon failed to start. boom');
  expect(container.textContent).not.toContain('Connected ');
  await act(async () => {
    vi.advanceTimersByTime(60_000);
  });
  expect(fetch).toHaveBeenCalledTimes(1);
});

it.each([401, 403])('never auto-retries a %i answer', async (status) => {
  vi.useFakeTimers();
  const fetch = vi.fn().mockResolvedValue(stubResponse({ status }));
  vi.stubGlobal('fetch', fetch);
  await mount();
  await act(async () => {
    vi.advanceTimersByTime(60_000);
  });
  expect(fetch).toHaveBeenCalledTimes(1);
});

it('asks a first-visit operator to enter the token, not correct an invalid one', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(stubResponse({ status: 401 })),
  );
  await mount();
  expect(container.textContent).toContain(
    'Enter the bearer token from the daemon terminal.',
  );
  expect(container.textContent).not.toContain('Invalid or expired');
  expect(container.textContent).not.toContain('Connected ');
  // The destination is on screen — the only in-UI cue distinguishing this
  // gate from a look-alike page asking for the same credential.
  expect(container.textContent).toContain('http://daemon.test');
});

it('asks a first-visit zh-CN operator for the bearer token', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(stubResponse({ status: 401 })),
  );
  await mount(undefined, 'zh-CN');
  // The shared prefix appears in both zh messages, so key on the tail.
  expect(container.textContent).toContain('bearer token');
  expect(container.textContent).not.toContain('令牌无效或已过期');
});

it('trims a whitespace-padded typed token before probing and persisting', async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(stubResponse({ status: 401 }))
    .mockResolvedValueOnce(stubResponse({ status: 200 }));
  vi.stubGlobal('fetch', fetch);
  await mount();
  act(() => {
    const input = container.querySelector('input')!;
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )!.set!.call(input, '  padded-token  ');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(submitForm);
  expect(container.textContent).toContain('Connected padded-token');
  expect(sessionStorage.getItem('qwen-daemon-token')).toBe('padded-token');
  expect(fetch.mock.calls[1][1].headers).toEqual({
    Authorization: 'Bearer padded-token',
  });
});

it('lets a manual retry supersede an armed auto-retry', async () => {
  vi.useFakeTimers();
  const fetch = vi
    .fn()
    .mockRejectedValueOnce(new Error('Failed to fetch'))
    .mockResolvedValueOnce(stubResponse({ status: 200 }));
  vi.stubGlobal('fetch', fetch);
  await mount();
  expect(container.textContent).toContain('Cannot reach the daemon');
  // The auto-retry is armed for 2 s; a manual submit inside that window
  // supersedes it, so exactly one more probe fires.
  await act(submitForm);
  expect(container.textContent).toBe('Connected ');
  await act(async () => {
    vi.advanceTimersByTime(60_000);
  });
  expect(fetch).toHaveBeenCalledTimes(2);
});
