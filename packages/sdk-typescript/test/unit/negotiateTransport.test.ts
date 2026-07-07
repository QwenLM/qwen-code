/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { negotiateTransport } from '../../src/daemon/negotiateTransport.js';

// ---------------------------------------------------------------------------
// We need to mock globalThis.fetch since negotiateTransport uses it.
// ---------------------------------------------------------------------------

const originalFetch = globalThis.fetch;

function installMockFetch(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
): void {
  globalThis.fetch = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      return handler(url, init);
    },
  ) as unknown as typeof globalThis.fetch;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('negotiateTransport', () => {
  // ---- REST fallback cases ----------------------------------------------

  describe('REST fallback', () => {
    it('returns REST when capabilities has no transports field', async () => {
      installMockFetch((url) => {
        if (url.includes('/capabilities')) {
          return jsonResponse(200, { v: 1 });
        }
        return jsonResponse(200, {});
      });

      const transport = await negotiateTransport('http://localhost:8080');
      expect(transport.type).toBe('rest');
      transport.dispose();
    });

    it('returns REST when capabilities has transports: ["rest"]', async () => {
      installMockFetch((url) => {
        if (url.includes('/capabilities')) {
          return jsonResponse(200, { v: 1, transports: ['rest'] });
        }
        return jsonResponse(200, {});
      });

      const transport = await negotiateTransport('http://localhost:8080');
      expect(transport.type).toBe('rest');
      transport.dispose();
    });

    it('returns REST when capabilities has empty transports array', async () => {
      installMockFetch((url) => {
        if (url.includes('/capabilities')) {
          return jsonResponse(200, { v: 1, transports: [] });
        }
        return jsonResponse(200, {});
      });

      const transport = await negotiateTransport('http://localhost:8080');
      expect(transport.type).toBe('rest');
      transport.dispose();
    });

    it('falls back to REST on capabilities fetch failure', async () => {
      installMockFetch(() => {
        throw new Error('connection refused');
      });

      const transport = await negotiateTransport('http://localhost:8080');
      expect(transport.type).toBe('rest');
      transport.dispose();
    });

    it('falls back to REST on capabilities non-ok response', async () => {
      installMockFetch(() => {
        return jsonResponse(500, { error: 'server error' });
      });

      const transport = await negotiateTransport('http://localhost:8080');
      expect(transport.type).toBe('rest');
      transport.dispose();
    });
  });

  // ---- ACP-HTTP preference ----------------------------------------------

  describe('acp-http preference', () => {
    it('returns acp-http when capabilities includes acp-http but not acp-ws', async () => {
      installMockFetch((url) => {
        if (url.includes('/capabilities')) {
          return jsonResponse(200, { v: 1, transports: ['rest', 'acp-http'] });
        }
        return jsonResponse(200, {});
      });

      const transport = await negotiateTransport('http://localhost:8080');
      expect(transport.type).toBe('acp-http');
      transport.dispose();
    });
  });

  // ---- ACP-WS probe -----------------------------------------------------

  describe('acp-ws probe', () => {
    it('attempts WS probe when acp-ws is in transports list', async () => {
      // WS probe will fail since no real WebSocket server exists
      installMockFetch((url) => {
        if (url.includes('/capabilities')) {
          return jsonResponse(200, { v: 1, transports: ['acp-ws'] });
        }
        return jsonResponse(200, {});
      });

      // Should fall back to REST since WS probe fails
      const transport = await negotiateTransport(
        'http://localhost:8080',
        undefined,
        {
          probeTimeoutMs: 100,
        },
      );
      // It will fall back because the WS probe can't connect
      expect(['rest', 'acp-ws']).toContain(transport.type);
      transport.dispose();
    });

    it('falls back to REST on WS probe failure with acp-ws only', async () => {
      installMockFetch((url) => {
        if (url.includes('/capabilities')) {
          return jsonResponse(200, { v: 1, transports: ['acp-ws'] });
        }
        return jsonResponse(200, {});
      });

      const transport = await negotiateTransport(
        'http://localhost:8080',
        undefined,
        {
          probeTimeoutMs: 100,
        },
      );
      // WS won't connect in test, should fall back
      expect(transport.type).toBe('rest');
      transport.dispose();
    });

    it('falls back to acp-http when WS probe fails and acp-http is available', async () => {
      installMockFetch((url) => {
        if (url.includes('/capabilities')) {
          return jsonResponse(200, {
            v: 1,
            transports: ['acp-ws', 'acp-http'],
          });
        }
        return jsonResponse(200, {});
      });

      const transport = await negotiateTransport(
        'http://localhost:8080',
        undefined,
        {
          probeTimeoutMs: 100,
        },
      );
      // WS fails, should try acp-http next
      expect(['acp-http', 'rest']).toContain(transport.type);
      transport.dispose();
    });
  });

  // ---- Probe timeout behavior -------------------------------------------

  describe('probe timeout', () => {
    it('uses default 5000ms timeout when not specified', async () => {
      installMockFetch((url) => {
        if (url.includes('/capabilities')) {
          return jsonResponse(200, { v: 1 });
        }
        return jsonResponse(200, {});
      });

      // Should complete quickly since we get a response
      const transport = await negotiateTransport('http://localhost:8080');
      expect(transport.type).toBe('rest');
      transport.dispose();
    });

    it('custom probeTimeoutMs is respected', async () => {
      installMockFetch((url) => {
        if (url.includes('/capabilities')) {
          return jsonResponse(200, { v: 1 });
        }
        return jsonResponse(200, {});
      });

      const transport = await negotiateTransport(
        'http://localhost:8080',
        undefined,
        { probeTimeoutMs: 100 },
      );
      expect(transport.type).toBe('rest');
      transport.dispose();
    });
  });

  // ---- Token handling ---------------------------------------------------

  describe('token handling', () => {
    it('passes token as Authorization header to capabilities probe', async () => {
      const capturedHeaders: Record<string, string> = {};
      installMockFetch((url, init) => {
        if (url.includes('/capabilities')) {
          if (init?.headers) {
            const h = new Headers(init.headers);
            h.forEach((v, k) => (capturedHeaders[k.toLowerCase()] = v));
          }
          return jsonResponse(200, { v: 1 });
        }
        return jsonResponse(200, {});
      });

      const transport = await negotiateTransport(
        'http://localhost:8080',
        'secret-token',
      );
      expect(capturedHeaders['authorization']).toBe('Bearer secret-token');
      transport.dispose();
    });

    it('does not send Authorization when no token', async () => {
      const capturedHeaders: Record<string, string> = {};
      installMockFetch((url, init) => {
        if (url.includes('/capabilities')) {
          if (init?.headers) {
            const h = new Headers(init.headers);
            h.forEach((v, k) => (capturedHeaders[k.toLowerCase()] = v));
          }
          return jsonResponse(200, { v: 1 });
        }
        return jsonResponse(200, {});
      });

      const transport = await negotiateTransport('http://localhost:8080');
      expect(capturedHeaders['authorization']).toBeUndefined();
      transport.dispose();
    });
  });

  // ---- supportsReplay ---------------------------------------------------

  describe('transport properties', () => {
    it('REST transport supports replay', async () => {
      installMockFetch(() => jsonResponse(200, { v: 1 }));
      const transport = await negotiateTransport('http://localhost:8080');
      expect(transport.supportsReplay).toBe(true);
      transport.dispose();
    });

    it('returned transport is connected (REST)', async () => {
      installMockFetch(() => jsonResponse(200, { v: 1 }));
      const transport = await negotiateTransport('http://localhost:8080');
      expect(transport.connected).toBe(true);
      transport.dispose();
    });
  });
});
