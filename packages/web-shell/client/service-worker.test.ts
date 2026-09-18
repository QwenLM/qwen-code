import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const source = readFileSync(new URL('./sw.js', import.meta.url), 'utf8');

function basicResponse(body: string, init?: ResponseInit) {
  const response = new Response(body, init);
  Object.defineProperty(response, 'type', { value: 'basic' });
  return response;
}

function worker() {
  const fetch = vi.fn();
  const store = new Map<string, Response>();
  const listeners = new Map<string, (event: unknown) => void>();
  const cache = {
    match: vi.fn(async (request: Request) => store.get(request.url)?.clone()),
    put: vi.fn(async (request: Request, response: Response) => {
      store.set(request.url, response);
    }),
  };
  const caches = {
    open: vi.fn(async () => cache),
    keys: vi.fn(async (): Promise<string[]> => []),
    delete: vi.fn(async () => true),
  };
  const self = {
    location: { origin: 'https://qwen.example' },
    addEventListener: (type: string, listener: (event: unknown) => void) =>
      listeners.set(type, listener),
    skipWaiting: vi.fn(async () => undefined),
    clients: { claim: vi.fn(async () => undefined) },
  };
  runInNewContext(source, { self, caches, fetch, URL, Response });
  function fetchEvent(path: string, overrides: Record<string, unknown> = {}) {
    const respondWith = vi.fn();
    const pending: Array<Promise<unknown>> = [];
    const request = {
      url: new URL(path, self.location.origin).href,
      method: 'GET',
      mode: 'cors',
      headers: new Headers(),
      ...overrides,
    };
    listeners.get('fetch')!({
      request,
      respondWith,
      waitUntil: (promise: Promise<unknown>) => pending.push(promise),
    });
    return { respondWith, request, pending };
  }
  async function lifecycle(type: string) {
    const pending: Array<Promise<unknown>> = [];
    listeners.get(type)!({
      waitUntil: (promise: Promise<unknown>) => pending.push(promise),
    });
    await Promise.all(pending);
  }
  return { fetch, cache, caches, self, fetchEvent, lifecycle };
}

describe('service worker shell assets', () => {
  it('keeps an independent cached body after the browser consumes the response', async () => {
    const w = worker();
    w.fetch.mockResolvedValueOnce(basicResponse('asset-v1'));
    const first = w.fetchEvent('/assets/index-abc12345.js');
    const response: Response = await first.respondWith.mock.calls[0][0];
    expect(await response.text()).toBe('asset-v1');
    await Promise.all(first.pending);
    for (let i = 0; i < 2; i++) {
      const hit = w.fetchEvent('/assets/index-abc12345.js');
      const cached: Response = await hit.respondWith.mock.calls[0][0];
      expect(await cached.text()).toBe('asset-v1');
    }
    expect(w.fetch).toHaveBeenCalledOnce();
    expect(w.caches.open).toHaveBeenCalledWith('qwen-code-shell-v1-dev');
  });

  it('still loads assets when CacheStorage is unavailable', async () => {
    const w = worker();
    w.caches.open.mockRejectedValueOnce(new Error('Storage disabled'));
    w.fetch.mockResolvedValueOnce(basicResponse('online'));
    const event = w.fetchEvent('/assets/index-abc12345.js');
    expect(await (await event.respondWith.mock.calls[0][0]).text()).toBe(
      'online',
    );
  });

  it('settles the cache lifetime promise when storage is full', async () => {
    const w = worker();
    w.cache.put.mockRejectedValueOnce(new Error('Quota exceeded'));
    w.fetch.mockResolvedValueOnce(basicResponse('online'));
    const event = w.fetchEvent('/assets/index-abc12345.js');
    expect(await (await event.respondWith.mock.calls[0][0]).text()).toBe(
      'online',
    );
    await expect(Promise.all(event.pending)).resolves.toEqual([undefined]);
  });

  it('does not cache failed responses', async () => {
    const w = worker();
    w.fetch.mockResolvedValueOnce(basicResponse('Not found', { status: 404 }));
    const event = w.fetchEvent('/assets/missing-abc12345.js');
    expect((await event.respondWith.mock.calls[0][0]).status).toBe(404);
    expect(w.cache.put).not.toHaveBeenCalled();
  });
});

describe('service worker bypass', () => {
  it.each([
    ['/manifest.webmanifest', {}],
    ['/assets/icon-192.png', {}],
    ['/assets/icon.svg', {}],
    ['/session/abc/events', {}],
    ['/capabilities', {}],
    ['/health', {}],
    ['/permission/request', { method: 'POST' }],
    ['/assets/main.js', { method: 'POST' }],
    ['/', { method: 'POST' }],
    [
      '/assets/index-abc12345.js',
      { headers: new Headers({ authorization: 'Bearer x' }) },
    ],
    [
      '/assets/index-abc12345.js',
      { headers: new Headers({ accept: 'text/event-stream' }) },
    ],
    ['https://other.example/assets/index.js', {}],
  ])('leaves %s to the browser network stack (%j)', (path, overrides) => {
    const w = worker();
    expect(w.fetchEvent(path, overrides).respondWith).not.toHaveBeenCalled();
    expect(w.fetch).not.toHaveBeenCalled();
    expect(w.caches.open).not.toHaveBeenCalled();
  });
});

describe('service worker navigation', () => {
  it('passes successful navigations through without caching HTML', async () => {
    const w = worker();
    const online = new Response('document html');
    w.fetch.mockResolvedValueOnce(online);
    const event = w.fetchEvent('/', { mode: 'navigate' });
    expect(await event.respondWith.mock.calls[0][0]).toBe(online);
    expect(w.caches.open).not.toHaveBeenCalled();
  });

  it('returns a real 503 retry page when the daemon is offline', async () => {
    const w = worker();
    w.fetch.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const event = w.fetchEvent('/session/123', { mode: 'navigate' });
    const response: Response = await event.respondWith.mock.calls[0][0];
    expect(response.status).toBe(503);
    expect(response.headers.get('content-type')).toContain('text/html');
    expect(response.headers.get('cache-control')).toBe('no-store');
    const html = await response.text();
    expect(html).toContain('Try again');
    expect(html).toContain('重试');
    expect(w.caches.open).not.toHaveBeenCalled();
  });

  it('leaves subframe navigations to the browser network stack', () => {
    const w = worker();
    const event = w.fetchEvent('/frame.html', {
      mode: 'navigate',
      destination: 'iframe',
    });
    expect(event.respondWith).not.toHaveBeenCalled();
    expect(w.fetch).not.toHaveBeenCalled();
  });
});

describe('service worker lifecycle', () => {
  it('activates immediately and removes only older shell caches', async () => {
    const w = worker();
    w.caches.keys.mockResolvedValueOnce([
      'qwen-code-shell-v1-dev',
      'qwen-code-shell-v1-0.1.0',
      'unrelated-cache',
    ]);
    await w.lifecycle('install');
    await w.lifecycle('activate');
    expect(w.self.skipWaiting).toHaveBeenCalledOnce();
    expect(w.self.clients.claim).toHaveBeenCalledOnce();
    expect(w.caches.delete.mock.calls).toEqual([['qwen-code-shell-v1-0.1.0']]);
  });
});
