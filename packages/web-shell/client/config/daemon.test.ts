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

  it('rejects external host', async () => {
    const result = await getDaemonBaseUrlWith(
      'http://localhost:5173',
      'http://evil.com:5173',
    );
    expect(result).toBe('');
  });

  it('rejects non-HTTP scheme', async () => {
    const result = await getDaemonBaseUrlWith(
      'http://localhost:5173',
      'ftp://localhost:5173',
    );
    expect(result).toBe('');
  });

  it('rejects localhost with different port', async () => {
    const result = await getDaemonBaseUrlWith(
      'http://localhost:5173',
      'http://localhost:4170',
    );
    expect(result).toBe('');
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
});

describe('getDaemonToken', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  function setupToken(search: string, hash: string) {
    Object.defineProperty(window, 'location', {
      value: { search, hash, href: `http://localhost:4170/${search}${hash}` },
      writable: true,
      configurable: true,
    });
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
});

describe('removeDaemonTokenFromUrl', () => {
  beforeEach(() => {
    vi.resetModules();
    // The function is a no-op under import.meta.env.DEV; exercise the
    // production-build path where it actually strips the token.
    vi.stubEnv('DEV', false);
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
});
