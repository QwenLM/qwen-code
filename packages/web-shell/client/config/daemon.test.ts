// @vitest-environment jsdom

import { describe, expect, it, beforeEach, vi } from 'vitest';

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
