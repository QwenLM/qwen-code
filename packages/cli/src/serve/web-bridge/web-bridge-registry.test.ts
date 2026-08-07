/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { WebBridgeRegistry } from './web-bridge-registry.js';

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
    expect(registry.pendingCount()).toBe(1);

    registry.routeInbound('extension-1', {
      type: 'webbridge_result',
      responseToRequestId: requestId,
      payload: { data: { ok: true } },
    });
    await expect(pending).resolves.toEqual({ ok: true });
  });

  it('rejects pending calls when the active extension is replaced', async () => {
    const registry = new WebBridgeRegistry(1_000);
    registry.register({ connectionId: 'old', send() {} });
    const pending = registry.call('snapshot', {});

    registry.register({ connectionId: 'new', send() {} });

    await expect(pending).rejects.toThrow('replaced');
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
