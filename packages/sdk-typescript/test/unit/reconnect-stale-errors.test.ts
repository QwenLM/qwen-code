/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { AutoReconnectTransport } from '../../src/daemon/AutoReconnectTransport.js';
import {
  DaemonTransportClosedError,
  type DaemonTransport,
} from '../../src/daemon/DaemonTransport.js';
import type { DaemonEvent } from '../../src/daemon/types.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const event: DaemonEvent = { type: 'ready', data: {}, v: 1, id: 1 };

function replacement(): DaemonTransport {
  return {
    type: 'rest',
    supportsReplay: true,
    connected: true,
    fetch: vi.fn(async () => new Response(null, { status: 204 })),
    async *subscribeEvents() {
      yield event;
    },
    dispose: vi.fn(),
  };
}

describe('reconnect errors from an old transport', () => {
  it.each(['fetch', 'subscription'] as const)(
    'keeps the healthy replacement after a delayed %s error',
    async (operation) => {
      const oldRequest = deferred<Response>();
      const oldSubscription = deferred<void>();
      const inner = replacement();
      inner.fetch = vi
        .fn()
        .mockRejectedValueOnce(new DaemonTransportClosedError())
        .mockImplementation(() => oldRequest.promise);
      inner.subscribeEvents = async function* () {
        await oldSubscription.promise;
        yield event;
      };
      const healthy = replacement();
      const factory = vi.fn(() => healthy);
      const transport = new AutoReconnectTransport({
        baseUrl: 'https://daemon.example',
        initial: inner,
        factory,
      });
      try {
        const first = transport.fetch('https://daemon.example/health', {});
        const delayed =
          operation === 'fetch'
            ? transport.fetch('https://daemon.example/health', {})
            : transport.subscribeEvents('session-a').next();
        expect((await first).status).toBe(204);

        if (operation === 'fetch') {
          oldRequest.reject(new DaemonTransportClosedError());
        } else {
          oldSubscription.reject(new DaemonTransportClosedError());
        }
        await delayed;

        expect(factory).toHaveBeenCalledTimes(1);
        expect(healthy.dispose).not.toHaveBeenCalled();
      } finally {
        transport.dispose();
      }
    },
  );

  it('can still reconnect after the current replacement fails', async () => {
    const original = replacement();
    original.fetch = vi
      .fn()
      .mockRejectedValue(new DaemonTransportClosedError());
    const first = replacement();
    first.fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockRejectedValue(new DaemonTransportClosedError());
    const second = replacement();
    const factory = vi
      .fn()
      .mockReturnValueOnce(first)
      .mockReturnValueOnce(second);
    const transport = new AutoReconnectTransport({
      baseUrl: 'https://daemon.example',
      initial: original,
      factory,
    });
    try {
      await transport.fetch('https://daemon.example/health', {});
      await transport.fetch('https://daemon.example/health', {});
      expect(factory).toHaveBeenCalledTimes(2);
      expect(first.dispose).toHaveBeenCalledOnce();
      expect(second.dispose).not.toHaveBeenCalled();
    } finally {
      transport.dispose();
    }
  });
});
