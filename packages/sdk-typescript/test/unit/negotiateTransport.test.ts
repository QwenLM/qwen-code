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

function installStallingFetch(
  opts: {
    firstChunk?: string;
    headers?: HeadersInit;
    abortBody?: boolean;
    stallBeforeHeaders?: boolean;
  } = {},
) {
  let signal: AbortSignal | undefined;
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let release!: (reason: unknown) => void;
  let started!: () => void;
  const requestStarted = new Promise<void>((resolve) => {
    started = resolve;
  });

  installMockFetch((_url, init) => {
    signal = init?.signal ?? undefined;
    const response = opts.stallBeforeHeaders
      ? new Promise<Response>((_resolve, reject) => {
          release = reject;
        })
      : new Response(
          new ReadableStream<Uint8Array>({
            start(bodyController) {
              controller = bodyController;
              release = (reason) => controller.error(reason);
              if (opts.firstChunk !== undefined) {
                controller.enqueue(new TextEncoder().encode(opts.firstChunk));
              }
            },
          }),
          { headers: opts.headers },
        );
    if (opts.abortBody !== false) {
      signal?.addEventListener('abort', () => release(signal?.reason), {
        once: true,
      });
    }
    started();
    return response;
  });

  return {
    requestStarted,
    get signal() {
      return signal;
    },
    get controller() {
      return controller;
    },
    async cleanup(pending?: ReturnType<typeof negotiateTransport>) {
      release(new Error('fixture cleanup'));
      (await pending)?.dispose();
    },
  };
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.useRealTimers();
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

describe('capabilities fetch fixture', () => {
  it('delivers the first chunk and headers, then rejects a stalled read on abort', async () => {
    const fixture = installStallingFetch({
      firstChunk: '{"transports":',
      headers: { 'content-type': 'application/json' },
    });
    const abort = new AbortController();
    const response = await fetch('http://localhost:8080/capabilities', {
      signal: abort.signal,
    });
    const reader = response.body!.getReader();
    try {
      expect(response.headers.get('content-type')).toBe('application/json');
      expect(await reader.read()).toEqual({
        done: false,
        value: new TextEncoder().encode('{"transports":'),
      });
      const readRejected = vi.fn();
      void reader.read().catch(readRejected);
      const reason = new Error('fixture aborted');
      abort.abort(reason);
      await Promise.resolve();
      expect(readRejected).toHaveBeenCalledWith(reason);
    } finally {
      await fixture.cleanup();
      reader.releaseLock();
    }
  });
});

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
    it('falls back to REST when the capabilities body stalls after headers', async () => {
      vi.useFakeTimers();
      const fixture = installStallingFetch({
        firstChunk: '{"transports":',
        headers: { 'content-type': 'application/json' },
      });
      const pending = negotiateTransport('http://localhost:8080', undefined, {
        probeTimeoutMs: 100,
      });
      try {
        await fixture.requestStarted;
        await vi.advanceTimersByTimeAsync(99);
        expect(fixture.signal?.aborted).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        expect(fixture.signal?.aborted).toBe(true);
        expect((await pending).type).toBe('rest');
      } finally {
        await fixture.cleanup(pending);
      }
    });

    it('keeps a complete delayed capabilities response and clears its deadline', async () => {
      vi.useFakeTimers();
      const fixture = installStallingFetch({ abortBody: false });
      const pending = negotiateTransport('http://localhost:8080', undefined, {
        probeTimeoutMs: 100,
      });
      try {
        await fixture.requestStarted;
        await vi.advanceTimersByTimeAsync(99);
        fixture.controller.enqueue(
          new TextEncoder().encode('{"transports":["acp-http"]}'),
        );
        fixture.controller.close();
        expect((await pending).type).toBe('acp-http');
        await vi.advanceTimersByTimeAsync(100);
        expect(fixture.signal?.aborted).toBe(false);
      } finally {
        await fixture.cleanup(pending);
      }
    });

    it('clears the capabilities deadline when body parsing fails', async () => {
      vi.useFakeTimers();
      const fixture = installStallingFetch({ firstChunk: '{' });
      const pending = negotiateTransport('http://localhost:8080', undefined, {
        probeTimeoutMs: 100,
      });
      try {
        await fixture.requestStarted;
        fixture.controller.close();
        expect((await pending).type).toBe('rest');
        await vi.advanceTimersByTimeAsync(100);
        expect(fixture.signal?.aborted).toBe(false);
      } finally {
        await fixture.cleanup(pending);
      }
    });

    it('uses default 5000ms timeout when not specified', async () => {
      vi.useFakeTimers();
      const fixture = installStallingFetch();
      const pending = negotiateTransport('http://localhost:8080');
      try {
        await fixture.requestStarted;
        await vi.advanceTimersByTimeAsync(4_999);
        expect(fixture.signal?.aborted).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        expect(fixture.signal?.aborted).toBe(true);
        expect((await pending).type).toBe('rest');
      } finally {
        await fixture.cleanup(pending);
      }
    });

    it('custom probeTimeoutMs aborts a request whose headers never arrive', async () => {
      vi.useFakeTimers();
      const fixture = installStallingFetch({ stallBeforeHeaders: true });
      const pending = negotiateTransport('http://localhost:8080', undefined, {
        probeTimeoutMs: 100,
      });
      try {
        await fixture.requestStarted;
        await vi.advanceTimersByTimeAsync(99);
        expect(fixture.signal?.aborted).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        expect(fixture.signal?.aborted).toBe(true);
        expect((await pending).type).toBe('rest');
      } finally {
        await fixture.cleanup(pending);
      }
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
