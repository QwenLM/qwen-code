import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const source = readFileSync(new URL('./sw.js', import.meta.url), 'utf8');

/**
 * Mimics a same-origin (basic) Response: Node's built-in Response reports
 * `type: 'default'`, which the worker deliberately does not cache.
 */
class FakeBasicResponse {
  readonly status = 200;
  readonly type = 'basic';
  constructor(readonly bodyText: string) {}
  clone(): FakeBasicResponse {
    return new FakeBasicResponse(this.bodyText);
  }
  async text(): Promise<string> {
    return this.bodyText;
  }
}

/**
 * Loads sw.js into an isolated context with stubbed service-worker globals.
 * The sandbox object is passed through by reference, so its mocks are
 * inspectable from the test.
 */
function worker() {
  const fetch = vi.fn();
  const store = new Map<string, Response>();
  const listeners = new Map<string, (event: unknown) => void>();
  const cache = {
    match: vi.fn(async (request: Request) => {
      const cached = store.get(request.url);
      return cached ? cached.clone() : undefined;
    }),
    put: vi.fn(async (request: Request, response: Response) => {
      store.set(request.url, response);
    }),
  };
  const caches = {
    open: vi.fn(async () => cache),
    match: vi.fn(async (_request: Request) => undefined),
    keys: vi.fn(async () => []),
    delete: vi.fn(async () => true),
  };
  const sandbox = {
    self: {
      location: { origin: 'https://qwen.example' },
      addEventListener: (type: string, listener: (event: unknown) => void) =>
        listeners.set(type, listener),
      skipWaiting: vi.fn(),
      clients: {
        claim: vi.fn(async () => undefined),
        matchAll: vi.fn(async () => []),
        openWindow: vi.fn(async () => undefined),
      },
      registration: {
        showNotification: vi.fn(async () => undefined),
      },
    },
    URL,
    Request,
    Response,
    fetch,
    caches,
  };
  runInNewContext(source, sandbox);

  function fetchEvent(path: string, overrides: Record<string, unknown> = {}) {
    const respondWith = vi.fn();
    const request = {
      url: new URL(path, 'https://qwen.example').href,
      method: 'GET',
      mode: 'navigate',
      destination: 'document',
      headers: new Headers(),
      ...overrides,
    };
    listeners.get('fetch')!({ request, respondWith });
    return { request, respondWith };
  }

  return {
    fetch,
    caches,
    cache,
    listeners,
    sandbox,
    install: () => {
      const event = { waitUntil: vi.fn((p: Promise<unknown>) => p) };
      listeners.get('install')!(event);
      return event;
    },
    activate: () => {
      const event = { waitUntil: vi.fn((p: Promise<unknown>) => p) };
      listeners.get('activate')!(event);
      return event;
    },
    fetchEvent,
  };
}

describe('service worker shell assets', () => {
  it('caches /assets responses cache-first and serves them on the next hit', async () => {
    const { fetch, cache, fetchEvent } = worker();
    const first = new FakeBasicResponse('asset-v1');
    fetch.mockResolvedValueOnce(first);
    const miss = fetchEvent('/assets/index-abc123.js', {
      mode: 'same-origin',
      destination: 'script',
    });
    expect(miss.respondWith).toHaveBeenCalledOnce();
    expect(await miss.respondWith.mock.calls[0][0]).toBe(first);
    expect(fetch).toHaveBeenCalledOnce();
    expect(cache.put).toHaveBeenCalledOnce();

    fetch.mockClear();
    const hit = fetchEvent('/assets/index-abc123.js', {
      mode: 'same-origin',
      destination: 'script',
    });
    expect(fetch).not.toHaveBeenCalled();
    const served = await hit.respondWith.mock.calls[0][0];
    expect(served).not.toBe(first);
    expect(await served.text()).toBe('asset-v1');
  });

  it('treats the manifest as a cacheable shell asset', () => {
    const { fetchEvent, fetch } = worker();
    fetch.mockResolvedValue(new Response('{}', { status: 200 }));
    const { respondWith } = fetchEvent('/manifest.webmanifest', {
      mode: 'same-origin',
      destination: 'manifest',
    });
    expect(respondWith).toHaveBeenCalledOnce();
  });
});

describe('service worker bypass', () => {
  it.each([
    ['/session/abc', {}],
    ['/session/abc/events', {}],
    ['/capabilities', {}],
    ['/health', {}],
    ['/permission/request', { method: 'POST' }],
    ['/assets/main.js', { method: 'POST' }],
    ['/', { method: 'POST' }],
    ['/', { headers: new Headers({ authorization: 'Bearer x' }) }],
    ['/', { headers: new Headers({ accept: 'text/event-stream' }) }],
    ['https://other.example/', {}],
  ])('leaves %s untouched (%j)', (path, overrides) => {
    const { fetchEvent, fetch } = worker();
    const { respondWith } = fetchEvent(path, overrides);
    expect(respondWith).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('service worker navigation', () => {
  it('passes successful navigations through to the network', async () => {
    const { fetch, fetchEvent } = worker();
    const online = new Response('document html', { status: 200 });
    fetch.mockResolvedValueOnce(online);
    const { respondWith, request } = fetchEvent('/');
    expect(fetch).toHaveBeenCalledWith(request);
    expect(await respondWith.mock.calls[0][0]).toBe(online);
  });

  it('falls back to the cache when the network fails', async () => {
    const { fetch, caches, fetchEvent } = worker();
    fetch.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const fallback = new Response('stale document', { status: 503 });
    caches.match.mockResolvedValueOnce(fallback);
    const { respondWith } = fetchEvent('/');
    expect(await respondWith.mock.calls[0][0]).toBe(fallback);
  });
});

describe('service worker lifecycle', () => {
  it('skips waiting on install', () => {
    const { sandbox, install } = worker();
    install();
    expect(sandbox.self.skipWaiting).toHaveBeenCalledOnce();
  });

  it('claims clients and evicts stale shell caches on activate', async () => {
    const { sandbox, caches, activate } = worker();
    caches.keys.mockResolvedValueOnce([
      'qwen-code-shell-v1-dev',
      'qwen-code-shell-v1-0.1.0',
      'unrelated-cache',
    ]);
    const event = activate();
    await event.waitUntil.mock.results[0].value;
    expect(sandbox.self.clients.claim).toHaveBeenCalledOnce();
    expect(caches.delete).toHaveBeenCalledWith('qwen-code-shell-v1-0.1.0');
    expect(caches.delete).not.toHaveBeenCalledWith('qwen-code-shell-v1-dev');
    expect(caches.delete).not.toHaveBeenCalledWith('unrelated-cache');
  });
});

describe('service worker notifications', () => {
  it('shows a notification from JSON push data', async () => {
    const { listeners, sandbox } = worker();
    const event = {
      data: { json: () => ({ title: 'Turn complete', body: 'Hello' }) },
      waitUntil: vi.fn((p: Promise<unknown>) => p),
    };
    listeners.get('push')!(event);
    await event.waitUntil.mock.results[0].value;
    expect(sandbox.self.registration.showNotification).toHaveBeenCalledWith(
      'Turn complete',
      expect.objectContaining({
        body: 'Hello',
        icon: '/assets/icon-192.png',
      }),
    );
  });
});
