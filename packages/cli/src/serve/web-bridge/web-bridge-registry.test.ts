/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import {
  WebBridgeRegistry,
  WebBridgeTimeoutError,
} from './web-bridge-registry.js';

describe('WebBridgeRegistry', () => {
  it('correlates results from the registered extension connection', async () => {
    const registry = new WebBridgeRegistry(1_000);
    let requestId = '';
    registry.register({
      connectionId: 'extension-1',
      send(frame) {
        requestId = frame.requestId;
      },
    });

    const pending = registry.call('snapshot', {});
    expect(
      registry.routeInbound('extension-2', {
        type: 'webbridge_result',
        responseToRequestId: requestId,
        payload: { data: 'wrong connection' },
      }),
    ).toBe(true);
    registry.routeInbound('extension-1', {
      type: 'webbridge_result',
      responseToRequestId: requestId,
      payload: { data: { ok: true } },
    });
    await expect(pending).resolves.toEqual({ ok: true });
  });

  it('lets old calls finish while new calls use the replacement extension', async () => {
    const registry = new WebBridgeRegistry(1_000);
    let oldRequestId = '';
    let newRequestId = '';
    registry.register({
      connectionId: 'old',
      send(frame) {
        oldRequestId = frame.requestId;
      },
    });
    const oldPending = registry.call('snapshot', {});

    registry.register({
      connectionId: 'new',
      send(frame) {
        newRequestId = frame.requestId;
      },
    });
    const newPending = registry.call('snapshot', {});
    registry.routeInbound('old', {
      type: 'webbridge_result',
      responseToRequestId: oldRequestId,
      payload: { data: 'old result' },
    });
    registry.routeInbound('new', {
      type: 'webbridge_result',
      responseToRequestId: newRequestId,
      payload: { data: 'new result' },
    });

    await expect(oldPending).resolves.toBe('old result');
    await expect(newPending).resolves.toBe('new result');
  });

  it('falls back to the previous extension when its replacement disconnects', async () => {
    const registry = new WebBridgeRegistry(1_000);
    const oldSend = vi.fn();
    registry.register({ connectionId: 'old', send: oldSend });
    const unregisterNew = registry.register({ connectionId: 'new', send() {} });

    unregisterNew();
    void registry.call('snapshot', {}).catch(() => {});

    expect(oldSend).toHaveBeenCalledOnce();
  });

  it('ignores stale unregister callbacks for replaced connections', async () => {
    const registry = new WebBridgeRegistry(1_000);
    const unregisterOld = registry.register({
      connectionId: 'extension',
      send() {},
    });
    let requestId = '';
    registry.register({
      connectionId: 'extension',
      send(frame) {
        requestId = frame.requestId;
      },
    });

    const pending = registry.call('snapshot', {});
    unregisterOld();
    registry.routeInbound('extension', {
      type: 'webbridge_result',
      responseToRequestId: requestId,
      payload: { data: 'new result' },
    });

    await expect(pending).resolves.toBe('new result');
  });

  it('times out calls and removes their pending state', async () => {
    vi.useFakeTimers();
    try {
      const registry = new WebBridgeRegistry(100);
      registry.register({ connectionId: 'extension-1', send() {} });

      const pending = registry.call('snapshot', {});
      const rejection = pending.catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(100);

      expect(await rejection).toBeInstanceOf(WebBridgeTimeoutError);
    } finally {
      vi.useRealTimers();
    }
  });

  it('preserves extension action timeout semantics', async () => {
    const registry = new WebBridgeRegistry(1_000);
    let requestId = '';
    registry.register({
      connectionId: 'extension-1',
      send(frame) {
        requestId = frame.requestId;
      },
    });

    const pending = registry.call('evaluate', {});
    registry.routeInbound('extension-1', {
      type: 'webbridge_result',
      responseToRequestId: requestId,
      payload: {
        error: 'WebBridge action timed out after 55s',
        timeout: true,
      },
    });

    await expect(pending).rejects.toBeInstanceOf(WebBridgeTimeoutError);
  });

  it('reassembles chunked artifact results', async () => {
    const registry = new WebBridgeRegistry(1_000);
    let requestId = '';
    registry.register({
      connectionId: 'extension-1',
      send(frame) {
        requestId = frame.requestId;
      },
    });

    const pending = registry.call('screenshot', {});
    for (const chunk of ['abc', 'def']) {
      registry.routeInbound('extension-1', {
        type: 'webbridge_result_chunk',
        responseToRequestId: requestId,
        payload: { chunk },
      });
    }
    registry.routeInbound('extension-1', {
      type: 'webbridge_result',
      responseToRequestId: requestId,
      payload: { data: { format: 'png' }, chunked: true },
    });

    await expect(pending).resolves.toEqual({
      format: 'png',
      data: 'abcdef',
    });
  });

  it('reassembles chunked JSON results', async () => {
    const registry = new WebBridgeRegistry(1_000);
    let requestId = '';
    registry.register({
      connectionId: 'extension-1',
      send(frame) {
        requestId = frame.requestId;
      },
    });

    const pending = registry.call('network', {});
    for (const chunk of ['{"body":"abc', 'def"}']) {
      registry.routeInbound('extension-1', {
        type: 'webbridge_result_chunk',
        responseToRequestId: requestId,
        payload: { chunk },
      });
    }
    registry.routeInbound('extension-1', {
      type: 'webbridge_result',
      responseToRequestId: requestId,
      payload: { chunked: true, encoding: 'json' },
    });

    await expect(pending).resolves.toEqual({ body: 'abcdef' });
  });

  it('preserves an empty chunked data field', async () => {
    const registry = new WebBridgeRegistry(1_000);
    let requestId = '';
    registry.register({
      connectionId: 'extension-1',
      send(frame) {
        requestId = frame.requestId;
      },
    });

    const pending = registry.call('cdp', {});
    registry.routeInbound('extension-1', {
      type: 'webbridge_result',
      responseToRequestId: requestId,
      payload: { data: { eof: true }, chunked: true },
    });

    await expect(pending).resolves.toEqual({ data: '', eof: true });
  });
});
