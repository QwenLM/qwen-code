import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const source = readFileSync(
  new URL('./public/service-worker.js', import.meta.url),
  'utf8',
);

function worker() {
  const fetch = vi.fn();
  const listeners = new Map<string, (event: unknown) => void>();
  runInNewContext(source, {
    self: {
      location: { origin: 'https://qwen.example' },
      addEventListener: (type: string, listener: (event: unknown) => void) =>
        listeners.set(type, listener),
    },
    URL,
    Response,
    fetch,
    // Any attempt to persist responses or force activation fails this harness.
  });
  function dispatch(path: string, overrides = {}) {
    const respondWith = vi.fn();
    const request = {
      url: new URL(path, 'https://qwen.example').href,
      method: 'GET',
      mode: 'navigate',
      destination: 'document',
      ...overrides,
    };
    listeners.get('fetch')!({ request, respondWith });
    return { request, respondWith };
  }
  return { fetch, dispatch };
}

describe('standalone connection-loss page', () => {
  it('retries by reloading the full URL under a hash-restricted CSP', async () => {
    const { dispatch, fetch } = worker();
    fetch.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const response: Response = await dispatch('/').respondWith.mock.calls[0][0];
    const html = await response.text();
    const script = html.match(/<script>([\s\S]*?)<\/script>/)![1];
    const hash = createHash('sha256').update(script).digest('base64');
    expect(response.headers.get('content-security-policy')).toContain(
      `script-src 'sha256-${hash}'`,
    );
    const addEventListener = vi.fn();
    const location = {
      href: 'https://qwen.example/#token=example-secret',
      reload: vi.fn(),
    };
    runInNewContext(script, {
      document: { getElementById: () => ({ addEventListener }) },
      location,
    });
    expect(addEventListener).toHaveBeenCalledWith(
      'click',
      expect.any(Function),
    );
    addEventListener.mock.calls[0][1]();
    expect(location.reload).toHaveBeenCalledOnce();
    expect(location.href).toBe('https://qwen.example/#token=example-secret');
  });

  it.each(['/', '/session/abc', '/session/abc/'])(
    'recovers %s without caching',
    async (path) => {
      const { dispatch, fetch } = worker();
      fetch.mockRejectedValueOnce(new TypeError('Failed to fetch'));
      const { respondWith } = dispatch(path);
      const response: Response = await respondWith.mock.calls[0][0];
      expect(response.status).toBe(503);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(response.headers.get('content-type')).toContain('text/html');
      expect(await response.text()).toContain('Connection unavailable');
      const online = new Response('back online');
      fetch.mockResolvedValueOnce(online);
      expect(await dispatch(path).respondWith.mock.calls[0][0]).toBe(online);
    },
  );

  it.each([200, 401, 403, 500])(
    'preserves a real HTTP %s response',
    async (status) => {
      const { dispatch, fetch } = worker();
      const response = new Response('server response', { status });
      fetch.mockResolvedValueOnce(response);
      const result = dispatch('/');
      expect(fetch).toHaveBeenCalledWith(result.request);
      expect(await result.respondWith.mock.calls[0][0]).toBe(response);
    },
  );

  it.each([
    ['/session/abc', { mode: 'cors', destination: '' }],
    ['/session/abc/events', {}],
    ['/capabilities', {}],
    ['/health', {}],
    ['/permission/request', { method: 'POST' }],
    ['/assets/main.js', { mode: 'same-origin', destination: 'script' }],
    ['/', { method: 'POST' }],
    ['/', { destination: 'iframe' }],
    ['https://other.example/', {}],
  ])('leaves %s untouched (%j)', (path, overrides) => {
    const { dispatch, fetch } = worker();
    expect(dispatch(path, overrides).respondWith).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
});
