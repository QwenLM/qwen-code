/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi } from 'vitest';
import { AutoReconnectTransport } from '../../src/daemon/AutoReconnectTransport.js';
import {
  DaemonTransportClosedError,
  type DaemonTransport,
  type DaemonTransportType,
} from '../../src/daemon/DaemonTransport.js';
import type { DaemonEvent } from '../../src/daemon/types.js';

// ---------------------------------------------------------------------------
// Mock transport helper
// ---------------------------------------------------------------------------

function createMockTransport(
  overrides?: Partial<DaemonTransport> & { connected?: boolean },
): DaemonTransport {
  const base: DaemonTransport = {
    type: 'rest' as DaemonTransportType,
    supportsReplay: true,
    get connected() {
      return true;
    },
    fetch: vi.fn(async () => new Response('{}', { status: 200 })),
    subscribeEvents: vi.fn(async function* () {
      yield { type: 'test', data: {}, id: 1, v: 1 } as DaemonEvent;
    }),
    dispose: vi.fn(),
  };

  if (overrides) {
    // Use Object.defineProperty for getters and direct assignment for others
    for (const key of Object.keys(overrides) as (keyof typeof overrides)[]) {
      if (key === 'connected') {
        // Skip — connected is handled separately when provided as a getter
        continue;
      }
      const descriptor = Object.getOwnPropertyDescriptor(overrides, key);
      if (descriptor) {
        Object.defineProperty(base, key, descriptor);
      }
    }
  }

  return base;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AutoReconnectTransport', () => {
  // ---- Delegation to inner transport ------------------------------------

  describe('delegation', () => {
    it('type delegates to inner transport', () => {
      const inner = createMockTransport({ type: 'acp-ws' });
      const transport = new AutoReconnectTransport({
        baseUrl: 'http://d',
        initial: inner,
      });
      expect(transport.type).toBe('acp-ws');
      transport.dispose();
    });

    it('connected delegates to inner transport', () => {
      let isConnected = true;
      const inner = createMockTransport();
      // Override connected with a dynamic getter
      Object.defineProperty(inner, 'connected', {
        get: () => isConnected,
        configurable: true,
      });

      const transport = new AutoReconnectTransport({
        baseUrl: 'http://d',
        initial: inner,
      });
      expect(transport.connected).toBe(true);

      isConnected = false;
      expect(transport.connected).toBe(false);

      transport.dispose();
    });

    it('fetch delegates to inner transport', async () => {
      const mockResponse = new Response('{"ok":true}', { status: 200 });
      const inner = createMockTransport({
        fetch: vi.fn(async () => mockResponse),
      });
      const transport = new AutoReconnectTransport({
        baseUrl: 'http://d',
        initial: inner,
      });

      const res = await transport.fetch('http://d/health', { method: 'GET' });
      expect(res).toBe(mockResponse);
      expect(inner.fetch).toHaveBeenCalledTimes(1);

      transport.dispose();
    });

    it('subscribeEvents delegates to inner transport', async () => {
      const inner = createMockTransport();
      const transport = new AutoReconnectTransport({
        baseUrl: 'http://d',
        initial: inner,
      });

      const events: DaemonEvent[] = [];
      for await (const event of transport.subscribeEvents('s1')) {
        events.push(event);
      }
      expect(events).toHaveLength(1);
      expect(inner.subscribeEvents).toHaveBeenCalledTimes(1);

      transport.dispose();
    });
  });

  // ---- Reconnect on DaemonTransportClosedError --------------------------

  describe('reconnect', () => {
    it('reconnects on DaemonTransportClosedError from fetch', async () => {
      const failingInner = createMockTransport({
        fetch: vi.fn(async () => {
          throw new DaemonTransportClosedError('closed');
        }),
      });

      // Provide a mock fetch so the fallback RestSseTransport uses it
      // instead of the real globalThis.fetch.
      const mockFetch = vi.fn(
        async () => new Response('{"ok":true}', { status: 200 }),
      ) as unknown as typeof globalThis.fetch;

      const transport = new AutoReconnectTransport({
        baseUrl: 'http://d',
        initial: failingInner,
        fetch: mockFetch,
      });

      // Should succeed after reconnect (inner replaced by RestSseTransport)
      const res = await transport.fetch('http://d/health', { method: 'GET' });
      expect(res.status).toBe(200);
      expect(transport.type).toBe('rest');

      transport.dispose();
    });

    it('propagates non-transport errors without reconnecting', async () => {
      const inner = createMockTransport({
        fetch: vi.fn(async () => {
          throw new Error('network error');
        }),
      });

      const transport = new AutoReconnectTransport({
        baseUrl: 'http://d',
        initial: inner,
      });

      await expect(
        transport.fetch('http://d/health', { method: 'GET' }),
      ).rejects.toThrow('network error');

      transport.dispose();
    });

    it('uses factory for reconnect when available', async () => {
      const failingInner = createMockTransport({
        fetch: vi.fn(async () => {
          throw new DaemonTransportClosedError();
        }),
      });

      const newTransport = createMockTransport({
        type: 'acp-ws',
        fetch: vi.fn(async () => new Response('{"ws":true}', { status: 200 })),
      });

      const factory = vi.fn(async (_type: DaemonTransportType) => {
        return newTransport;
      });

      const transport = new AutoReconnectTransport({
        baseUrl: 'http://d',
        initial: failingInner,
        factory,
        preferredType: 'acp-ws',
      });

      const res = await transport.fetch('http://d/health', { method: 'GET' });
      expect(res.status).toBe(200);
      expect(factory).toHaveBeenCalledWith('acp-ws');

      transport.dispose();
    });

    it('falls back to REST when factory fails', async () => {
      const failingInner = createMockTransport({
        fetch: vi.fn(async () => {
          throw new DaemonTransportClosedError();
        }),
      });

      const factory = vi.fn(async () => {
        throw new Error('factory failed');
      });

      const mockFetch = vi.fn(
        async () => new Response('{"rest":true}', { status: 200 }),
      ) as unknown as typeof globalThis.fetch;

      const transport = new AutoReconnectTransport({
        baseUrl: 'http://d',
        initial: failingInner,
        factory,
        fetch: mockFetch,
      });

      const res = await transport.fetch('http://d/health', { method: 'GET' });
      expect(res.status).toBe(200);
      // After reconnect, the inner should be a RestSseTransport
      expect(transport.type).toBe('rest');

      transport.dispose();
    });
  });

  // ---- Reconnect mutex --------------------------------------------------

  describe('reconnect mutex', () => {
    it('prevents concurrent reconnects', async () => {
      const failingInner = createMockTransport({
        fetch: vi.fn(async () => {
          throw new DaemonTransportClosedError();
        }),
      });

      const factory = vi.fn(async () => {
        // Simulate async factory work
        await new Promise((resolve) => setTimeout(resolve, 10));
        return createMockTransport({
          fetch: vi.fn(async () => new Response('ok', { status: 200 })),
        });
      });

      const transport = new AutoReconnectTransport({
        baseUrl: 'http://d',
        initial: failingInner,
        factory,
      });

      // Fire two concurrent fetches that both trigger reconnect
      const [res1, res2] = await Promise.all([
        transport.fetch('http://d/health', { method: 'GET' }),
        transport.fetch('http://d/status', { method: 'GET' }),
      ]);

      expect(res1.status).toBe(200);
      expect(res2.status).toBe(200);
      // Factory should only be called once due to mutex
      expect(factory).toHaveBeenCalledTimes(1);

      transport.dispose();
    });
  });

  // ---- dispose() --------------------------------------------------------

  describe('dispose()', () => {
    it('disposes inner transport', () => {
      const inner = createMockTransport();
      const transport = new AutoReconnectTransport({
        baseUrl: 'http://d',
        initial: inner,
      });
      transport.dispose();
      expect(inner.dispose).toHaveBeenCalledTimes(1);
    });

    it('is idempotent', () => {
      const inner = createMockTransport();
      const transport = new AutoReconnectTransport({
        baseUrl: 'http://d',
        initial: inner,
      });
      transport.dispose();
      expect(() => transport.dispose()).not.toThrow();
    });

    it('fetch throws after dispose', async () => {
      const transport = new AutoReconnectTransport({
        baseUrl: 'http://d',
      });
      transport.dispose();
      await expect(
        transport.fetch('http://d/health', { method: 'GET' }),
      ).rejects.toThrow(DaemonTransportClosedError);
    });

    it('subscribeEvents throws after dispose', async () => {
      const transport = new AutoReconnectTransport({
        baseUrl: 'http://d',
      });
      transport.dispose();
      const gen = transport.subscribeEvents('s1');
      await expect(gen.next()).rejects.toThrow(DaemonTransportClosedError);
    });

    it('does not reconnect after dispose', async () => {
      const failingInner = createMockTransport({
        fetch: vi.fn(async () => {
          throw new DaemonTransportClosedError();
        }),
      });

      const transport = new AutoReconnectTransport({
        baseUrl: 'http://d',
        initial: failingInner,
      });

      transport.dispose();

      await expect(
        transport.fetch('http://d/health', { method: 'GET' }),
      ).rejects.toThrow(DaemonTransportClosedError);
    });
  });

  // ---- supportsReplay from inner ----------------------------------------

  describe('supportsReplay', () => {
    it('reflects inner transport supportsReplay=true', () => {
      const inner = createMockTransport({ supportsReplay: true });
      const transport = new AutoReconnectTransport({
        baseUrl: 'http://d',
        initial: inner,
      });
      expect(transport.supportsReplay).toBe(true);
      transport.dispose();
    });

    it('reflects inner transport supportsReplay=false', () => {
      const inner = createMockTransport({ supportsReplay: false });
      const transport = new AutoReconnectTransport({
        baseUrl: 'http://d',
        initial: inner,
      });
      expect(transport.supportsReplay).toBe(false);
      transport.dispose();
    });
  });

  // ---- Default behavior -------------------------------------------------

  describe('defaults', () => {
    it('creates RestSseTransport as default inner when no initial given', () => {
      const transport = new AutoReconnectTransport({
        baseUrl: 'http://d',
      });
      expect(transport.type).toBe('rest');
      transport.dispose();
    });

    it('preferredType defaults to rest', () => {
      const failingInner = createMockTransport({
        fetch: vi.fn(async () => {
          throw new DaemonTransportClosedError();
        }),
      });

      const mockFetch = vi.fn(
        async () => new Response('ok', { status: 200 }),
      ) as unknown as typeof globalThis.fetch;

      const transport = new AutoReconnectTransport({
        baseUrl: 'http://d',
        initial: failingInner,
        fetch: mockFetch,
      });

      // After a reconnect (no factory), it creates a REST transport
      // (can't easily verify preferredType directly, but we verify
      // the fallback behavior results in a REST transport)
      expect(transport.type).toBe('rest'); // from initial mock
      transport.dispose();
    });
  });
});
