// @vitest-environment jsdom

import { afterEach, describe, expect, it, beforeEach, vi } from 'vitest';

describe('getAllowedDaemonOrigin (via getDaemonBaseUrl)', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  function setup(pageUrl: string) {
    const url = new URL(pageUrl);
    Object.defineProperty(window, 'location', {
      value: {
        origin: url.origin,
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port,
        href: url.href,
        search: url.search,
      },
      writable: true,
      configurable: true,
    });
  }

  async function getDaemonBaseUrlWith(pageUrl: string, daemonParam: string) {
    setup(pageUrl);
    Object.defineProperty(window, 'location', {
      value: {
        ...window.location,
        search: `?daemon=${encodeURIComponent(daemonParam)}`,
      },
      writable: true,
      configurable: true,
    });
    const mod = await import('./daemon');
    return mod.getDaemonBaseUrl();
  }

  it('accepts same-origin daemon URL', async () => {
    setup('http://localhost:5173');
    Object.defineProperty(window, 'location', {
      value: {
        ...window.location,
        search: '?daemon=http://localhost:5173',
      },
      writable: true,
      configurable: true,
    });
    const mod = await import('./daemon');
    expect(mod.getDaemonBaseUrl()).toBe('http://localhost:5173');
  });

  it('accepts an external HTTPS daemon', async () => {
    const result = await getDaemonBaseUrlWith(
      'http://localhost:5173',
      'https://daemon.example.com:4170',
    );
    expect(result).toBe('https://daemon.example.com:4170');
  });

  it('rejects non-HTTP scheme', async () => {
    const result = await getDaemonBaseUrlWith(
      'http://localhost:5173',
      'ftp://localhost:5173',
    );
    expect(result).toBe('');
  });

  it('accepts a loopback daemon on a different port', async () => {
    const result = await getDaemonBaseUrlWith(
      'http://localhost:5173',
      'http://localhost:4170',
    );
    expect(result).toBe('http://localhost:4170');
  });

  it('accepts an external HTTP daemon', async () => {
    const result = await getDaemonBaseUrlWith(
      'http://localhost:5173',
      'http://daemon.example.com:4170',
    );
    expect(result).toBe('http://daemon.example.com:4170');

    const sameOrigin = await getDaemonBaseUrlWith(
      'http://daemon.example.com:4170',
      'http://daemon.example.com:4170',
    );
    expect(sameOrigin).toBe('http://daemon.example.com:4170');
  });

  it('rejects credentials, paths, queries, and fragments', async () => {
    for (const raw of [
      'http://evil.example;sandbox',
      'http://evil.example%3Bsandbox',
    ]) {
      await expect(
        getDaemonBaseUrlWith('http://localhost:5173', raw),
      ).resolves.toBe('');
    }
    await expect(
      getDaemonBaseUrlWith(
        'http://localhost:5173',
        'https://user:pass@daemon.example.com',
      ),
    ).resolves.toBe('');
    await expect(
      getDaemonBaseUrlWith(
        'http://localhost:5173',
        'https://daemon.example.com/api',
      ),
    ).resolves.toBe('');
    await expect(
      getDaemonBaseUrlWith(
        'http://localhost:5173',
        'https://daemon.example.com?token=secret',
      ),
    ).resolves.toBe('');
    await expect(
      getDaemonBaseUrlWith(
        'http://localhost:5173',
        'https://daemon.example.com#token=secret',
      ),
    ).resolves.toBe('');
  });

  it('returns empty for non-parseable URL', async () => {
    const result = await getDaemonBaseUrlWith(
      'http://localhost:5173',
      'not-a-valid-url:///',
    );
    expect(result).toBe('');
  });

  it('returns empty when no daemon param', async () => {
    setup('http://localhost:5173');
    Object.defineProperty(window, 'location', {
      value: { ...window.location, search: '' },
      writable: true,
      configurable: true,
    });
    const mod = await import('./daemon');
    expect(mod.getDaemonBaseUrl()).toBe('');
  });

  it('treats a different-origin loopback daemon as remote on a loopback page', async () => {
    setup('http://127.0.0.1:5173/?daemon=http://127.0.0.1:4170');
    const mod = await import('./daemon');
    expect(mod.isLocalDaemon()).toBe(false);
  });

  it('keeps a same-origin loopback daemon host-local', async () => {
    setup('http://127.0.0.1:5173');
    const mod = await import('./daemon');
    expect(mod.isLocalDaemon()).toBe(true);
  });
});

describe('buildDaemonConnectionUrl', () => {
  it('switches daemon while clearing session-scoped state', async () => {
    const { buildDaemonConnectionUrl } = await import('./daemon');
    const result = buildDaemonConnectionUrl(
      'http://remote.example:4170/',
      'http://localhost:5173/app/session/old?workspace=one&context=live&theme=light&split=a,b#token=secret',
    );
    expect(result).toBe(
      'http://localhost:5173/app?theme=light&daemon=http%3A%2F%2Fremote.example%3A4170',
    );
  });

  it('removes the daemon override when switching back to page origin', async () => {
    const { buildDaemonConnectionUrl } = await import('./daemon');
    expect(
      buildDaemonConnectionUrl(
        'http://localhost:5173',
        'http://localhost:5173/?daemon=https%3A%2F%2Fremote.example',
      ),
    ).toBe('http://localhost:5173/');
  });

  it('rejects an invalid target', async () => {
    const { buildDaemonConnectionUrl } = await import('./daemon');
    expect(
      buildDaemonConnectionUrl('file:///tmp/daemon', 'http://localhost:5173/'),
    ).toBeUndefined();
  });
});

describe('navigateToDaemon', () => {
  beforeEach(() => {
    vi.resetModules();
    window.sessionStorage.clear();
  });

  // The split set is per-tab (sessionStorage) and the daemon switch navigates
  // in the same tab on the page origin, so storage — not the URL — is what
  // would carry the previous daemon's split into the new one.
  function setupPage(href: string) {
    const url = new URL(href);
    const assign = vi.fn();
    Object.defineProperty(window, 'location', {
      value: {
        origin: url.origin,
        hostname: url.hostname,
        href: url.href,
        search: url.search,
        assign,
      },
      writable: true,
      configurable: true,
    });
    return assign;
  }

  it('forgets the split set when switching to another daemon', async () => {
    window.sessionStorage.setItem(
      'qwen-webshell-split-sessions',
      JSON.stringify(['old-daemon-session']),
    );
    const assign = setupPage('http://localhost:5173/app');
    const mod = await import('./daemon');
    mod.navigateToDaemon('http://remote.example:4170');
    expect(assign).toHaveBeenCalledTimes(1);
    expect(
      window.sessionStorage.getItem('qwen-webshell-split-sessions'),
    ).toBeNull();
  });

  it('keeps the split set when reconnecting to the page-origin daemon', async () => {
    const saved = JSON.stringify(['local-session']);
    window.sessionStorage.setItem('qwen-webshell-split-sessions', saved);
    const assign = setupPage(
      'http://localhost:5173/app?daemon=https%3A%2F%2Fremote.example',
    );
    const mod = await import('./daemon');
    mod.navigateToDaemon('http://localhost:5173');
    expect(assign).toHaveBeenCalledTimes(1);
    expect(window.sessionStorage.getItem('qwen-webshell-split-sessions')).toBe(
      saved,
    );
  });
});

describe('getDaemonToken', () => {
  beforeEach(() => {
    vi.resetModules();
    // The token now persists per-tab (#7301); isolate tests from each
    // other's persisted copies.
    window.sessionStorage.clear();
  });

  function setupToken(search: string, hash: string) {
    Object.defineProperty(window, 'location', {
      value: { search, hash, href: `http://localhost:4170/${search}${hash}` },
      writable: true,
      configurable: true,
    });
  }

  // The restore half has to re-define the property with value/writable/
  // configurable or window.sessionStorage stays a throwing getter for the
  // rest of the file — keep the dance in one place.
  async function withSessionStorageThrowing<T>(
    run: () => Promise<T>,
  ): Promise<T> {
    const original = window.sessionStorage;
    Object.defineProperty(window, 'sessionStorage', {
      get() {
        throw new Error('storage disabled');
      },
      configurable: true,
    });
    try {
      return await run();
    } finally {
      Object.defineProperty(window, 'sessionStorage', {
        value: original,
        writable: true,
        configurable: true,
      });
    }
  }

  it('reads the token from the URL fragment', async () => {
    setupToken('', '#token=frag-secret');
    const mod = await import('./daemon');
    expect(mod.getDaemonToken()).toBe('frag-secret');
  });

  it('falls back to the query parameter', async () => {
    setupToken('?token=query-secret', '');
    const mod = await import('./daemon');
    expect(mod.getDaemonToken()).toBe('query-secret');
  });

  it('prefers the fragment over the query parameter', async () => {
    setupToken('?token=query-secret', '#token=frag-secret');
    const mod = await import('./daemon');
    expect(mod.getDaemonToken()).toBe('frag-secret');
  });

  it('returns undefined when neither is present', async () => {
    setupToken('', '');
    const mod = await import('./daemon');
    expect(mod.getDaemonToken()).toBeUndefined();
  });

  // Regression for #7301: removeDaemonTokenFromUrl() strips the fragment
  // for history hygiene, so a refreshed page has no token in the URL at
  // all. The first load must persist the token per-tab and later loads
  // must fall back to it.
  it('survives a page refresh via the per-tab persisted copy', async () => {
    setupToken('', '#token=frag-secret');
    const first = await import('./daemon');
    expect(first.getDaemonToken()).toBe('frag-secret');

    // Simulate the refresh: fresh module state (in-memory cache gone),
    // URL already cleaned — sessionStorage is all that remains.
    vi.resetModules();
    setupToken('', '#/chat');
    const second = await import('./daemon');
    expect(second.getDaemonToken()).toBe('frag-secret');
    expect(second.getDaemonAuthHeaders()).toEqual({
      Authorization: 'Bearer frag-secret',
    });
  });

  it('prefers a fresh URL token over a stale persisted one', async () => {
    window.sessionStorage.setItem('qwen-daemon-token', 'stale-secret');
    setupToken('', '#token=new-secret');
    const mod = await import('./daemon');
    expect(mod.getDaemonToken()).toBe('new-secret');
    // The persisted copy is refreshed for the next reload.
    expect(window.sessionStorage.getItem('qwen-daemon-token')).toBe(
      'new-secret',
    );
  });

  it('does not reuse the same-origin token for a selected remote daemon', async () => {
    window.sessionStorage.setItem('qwen-daemon-token', 'local-secret');
    setupToken('?daemon=https%3A%2F%2Fdaemon.example.com', '');
    const mod = await import('./daemon');
    expect(mod.getDaemonToken()).toBeUndefined();
  });

  it('persists and reloads a token under the selected daemon origin', async () => {
    setupToken(
      '?daemon=https%3A%2F%2Fdaemon.example.com%3A4170',
      '#token=remote-secret',
    );
    const first = await import('./daemon');
    expect(first.getDaemonToken()).toBe('remote-secret');
    expect(
      window.sessionStorage.getItem(
        'qwen-daemon-token:https://daemon.example.com:4170',
      ),
    ).toBe('remote-secret');
    expect(window.sessionStorage.getItem('qwen-daemon-token')).toBeNull();

    vi.resetModules();
    setupToken('?daemon=https%3A%2F%2Fdaemon.example.com%3A4170', '');
    const second = await import('./daemon');
    expect(second.getDaemonToken()).toBe('remote-secret');
  });

  it('clears a persisted token when the daemon accepts tokenless access', async () => {
    setupToken('?daemon=https%3A%2F%2Fdaemon.example.com', '');
    const mod = await import('./daemon');
    mod.persistDaemonToken('old-secret');
    mod.persistDaemonToken('');
    expect(mod.getDaemonToken()).toBeUndefined();
    expect(
      window.sessionStorage.getItem(
        'qwen-daemon-token:https://daemon.example.com',
      ),
    ).toBeNull();
  });

  it('degrades gracefully when sessionStorage throws', async () => {
    await withSessionStorageThrowing(async () => {
      setupToken('', '#token=frag-secret');
      const mod = await import('./daemon');
      // Same-load behavior is unaffected; only refresh persistence is lost.
      expect(mod.getDaemonToken()).toBe('frag-secret');
    });
  });

  // An opaque-origin document (file://, srcdoc, about:blank) reports origin
  // 'null', which is not a usable URL base. The token flow runs before the boot
  // fallback panel is removed, so throwing here would leave the shell blank;
  // the pre-persistence behavior is to degrade to the single key.
  it('does not throw for an opaque-origin document', async () => {
    Object.defineProperty(window, 'location', {
      value: { href: 'about:srcdoc', search: '', hash: '#token=opaque-secret' },
      writable: true,
      configurable: true,
    });
    const mod = await import('./daemon');
    expect(() => mod.getDaemonToken()).not.toThrow();
    expect(mod.getDaemonToken()).toBe('opaque-secret');
    expect(() => mod.persistDaemonToken('opaque-secret')).not.toThrow();
    expect(() => mod.hasReloadSurvivableDaemonToken()).not.toThrow();
    expect(window.sessionStorage.getItem('qwen-daemon-token')).toBe(
      'opaque-secret',
    );
  });

  describe('hasReloadSurvivableDaemonToken', () => {
    it('is true when the URL fragment carries a token', async () => {
      setupToken('', '#token=frag-secret');
      const mod = await import('./daemon');
      expect(mod.hasReloadSurvivableDaemonToken()).toBe(true);
    });

    it('is true when the query parameter carries a token', async () => {
      setupToken('?token=query-secret', '');
      const mod = await import('./daemon');
      expect(mod.hasReloadSurvivableDaemonToken()).toBe(true);
    });

    it('is true when a per-tab persisted token exists', async () => {
      window.sessionStorage.setItem('qwen-daemon-token', 'stored-secret');
      setupToken('', '#/chat');
      const mod = await import('./daemon');
      expect(mod.hasReloadSurvivableDaemonToken()).toBe(true);
    });

    it('is false when neither the URL nor storage has a token', async () => {
      setupToken('', '#/chat');
      const mod = await import('./daemon');
      expect(mod.hasReloadSurvivableDaemonToken()).toBe(false);
    });

    it('is false when storage is unavailable and the URL has no token', async () => {
      await withSessionStorageThrowing(async () => {
        setupToken('', '#/chat');
        const mod = await import('./daemon');
        expect(mod.hasReloadSurvivableDaemonToken()).toBe(false);
      });
    });

    it('is false when the in-memory cache holds a token a reload would lose', async () => {
      await withSessionStorageThrowing(async () => {
        setupToken('', '#token=boot-secret');
        const mod = await import('./daemon');
        // Warms the in-memory cache while the persist throws. The predicate
        // must NOT consult getDaemonToken(): after boot it always reports a
        // token, which would fail-open the reload.
        expect(mod.getDaemonToken()).toBe('boot-secret');
        // Models removeDaemonTokenFromUrl(): the URL no longer carries it.
        setupToken('', '#/chat');
        expect(mod.hasReloadSurvivableDaemonToken()).toBe(false);
      });
    });
  });
});

describe('waitForDaemonTokenMessage', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  function mockFramedWindow() {
    Object.defineProperty(window, 'parent', {
      value: {},
      writable: true,
      configurable: true,
    });
  }

  it('accepts a bearer token posted from a browser extension parent', async () => {
    mockFramedWindow();
    const mod = await import('./daemon');
    const token = mod.waitForDaemonTokenMessage(1000);
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { type: 'qwen-daemon-auth', token: 'posted-secret' },
        origin: 'chrome-extension://abcdefghijklmnop',
        source: window.parent,
      }),
    );
    await expect(token).resolves.toBe('posted-secret');
  });

  it('ignores bearer token messages from non-extension origins', async () => {
    mockFramedWindow();
    const mod = await import('./daemon');
    const token = mod.waitForDaemonTokenMessage(1);
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { type: 'qwen-daemon-auth', token: 'evil-secret' },
        origin: 'https://evil.example.com',
        source: window.parent,
      }),
    );
    await expect(token).resolves.toBeUndefined();
  });

  it('does not reuse an extension token message for a remote daemon', async () => {
    mockFramedWindow();
    Object.defineProperty(window, 'location', {
      value: {
        href: 'http://localhost:4170/?daemon=https%3A%2F%2Fdaemon.example.com',
        origin: 'http://localhost:4170',
        hostname: 'localhost',
        search: '?daemon=https%3A%2F%2Fdaemon.example.com',
        hash: '',
      },
      writable: true,
      configurable: true,
    });
    const mod = await import('./daemon');
    await expect(mod.waitForDaemonTokenMessage(1000)).resolves.toBeUndefined();
  });
});

describe('removeDaemonTokenFromUrl', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  function setupHref(href: string) {
    const replaceState = vi.fn();
    Object.defineProperty(window, 'location', {
      value: { href },
      writable: true,
      configurable: true,
    });
    Object.defineProperty(window, 'history', {
      value: { replaceState },
      writable: true,
      configurable: true,
    });
    return replaceState;
  }

  it('strips the token from the fragment', async () => {
    const replaceState = setupHref('http://localhost:4170/#token=secret');
    const mod = await import('./daemon');
    mod.removeDaemonTokenFromUrl();
    expect(replaceState).toHaveBeenCalledTimes(1);
    const next = new URL(String(replaceState.mock.calls[0][2]));
    expect(next.hash).toBe('');
    expect(next.href).not.toContain('token=secret');
  });

  it('strips the token from the query', async () => {
    const replaceState = setupHref('http://localhost:4170/?token=secret');
    const mod = await import('./daemon');
    mod.removeDaemonTokenFromUrl();
    const next = new URL(String(replaceState.mock.calls[0][2]));
    expect(next.searchParams.has('token')).toBe(false);
  });

  it('preserves non-token fragment params', async () => {
    const replaceState = setupHref(
      'http://localhost:4170/#token=secret&session=abc',
    );
    const mod = await import('./daemon');
    mod.removeDaemonTokenFromUrl();
    const next = new URL(String(replaceState.mock.calls[0][2]));
    expect(next.hash).toBe('#session=abc');
    expect(next.hash).not.toContain('token');
  });

  it('is a no-op when no token is present', async () => {
    const replaceState = setupHref('http://localhost:4170/#session=abc');
    const mod = await import('./daemon');
    mod.removeDaemonTokenFromUrl();
    expect(replaceState).not.toHaveBeenCalled();
  });

  it('still scrubs the token in a dev build', async () => {
    vi.stubEnv('DEV', true);
    const replaceState = setupHref('http://localhost:4170/?token=secret');
    const mod = await import('./daemon');
    mod.removeDaemonTokenFromUrl();
    const next = new URL(String(replaceState.mock.calls[0][2]));
    expect(next.searchParams.has('token')).toBe(false);
  });
});

describe('persistDaemonToken', () => {
  it('keeps the token in memory when session storage throws', async () => {
    vi.resetModules();
    vi.stubGlobal('sessionStorage', {
      getItem: () => {
        throw new Error('storage blocked');
      },
      setItem: () => {
        throw new Error('storage blocked');
      },
      removeItem: () => {
        throw new Error('storage blocked');
      },
    });
    const mod = await import('./daemon');
    mod.persistDaemonToken('mem-only');
    expect(mod.getDaemonToken()).toBe('mem-only');
  });
});
