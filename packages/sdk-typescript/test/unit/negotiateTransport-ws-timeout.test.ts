/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { AcpWsTransport } from '../../src/daemon/AcpWsTransport.js';
import { negotiateTransport } from '../../src/daemon/negotiateTransport.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const capabilitiesFetch: typeof fetch = async () =>
  new Response(JSON.stringify({ transports: ['acp-ws', 'acp-http'] }));

describe('WebSocket negotiation deadline cleanup', () => {
  it('clears the actual deadline when the WebSocket probe succeeds', async () => {
    vi.useFakeTimers();
    vi.spyOn(AcpWsTransport.prototype, 'fetch').mockResolvedValue(
      new Response('{}'),
    );

    const transport = await negotiateTransport('http://daemon', undefined, {
      probeTimeoutMs: 100,
      fetchFn: capabilitiesFetch,
    });

    expect(transport.type).toBe('acp-ws');
    expect(vi.getTimerCount()).toBe(0);
    transport.dispose();
  });

  it('clears the deadline and disposes a rejected WebSocket probe', async () => {
    vi.useFakeTimers();
    vi.spyOn(AcpWsTransport.prototype, 'fetch').mockRejectedValue(
      new Error('WebSocket rejected'),
    );
    const dispose = vi.spyOn(AcpWsTransport.prototype, 'dispose');

    const transport = await negotiateTransport('http://daemon', undefined, {
      probeTimeoutMs: 100,
      fetchFn: capabilitiesFetch,
    });

    expect(transport.type).toBe('acp-http');
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    transport.dispose();
  });

  it('still falls back and disposes a WebSocket probe at its deadline', async () => {
    vi.useFakeTimers();
    let signalStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    let finishFetch!: (response: Response) => void;
    vi.spyOn(AcpWsTransport.prototype, 'fetch').mockImplementation(() => {
      signalStarted();
      return new Promise<Response>((resolve) => {
        finishFetch = resolve;
      });
    });
    const dispose = vi.spyOn(AcpWsTransport.prototype, 'dispose');
    let settled = false;
    const pending = negotiateTransport('http://daemon', undefined, {
      probeTimeoutMs: 100,
      fetchFn: capabilitiesFetch,
    }).then((transport) => {
      settled = true;
      return transport;
    });

    try {
      await started;
      await vi.advanceTimersByTimeAsync(99);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      const transport = await pending;
      expect(transport.type).toBe('acp-http');
      expect(dispose).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
      transport.dispose();
    } finally {
      finishFetch(new Response('{}'));
      (await pending).dispose();
    }
  });
});
