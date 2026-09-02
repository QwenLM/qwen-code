/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import { test } from 'vitest';

import type { BridgeEvent } from '../bridge/index.js';

import {
  applyDiagnosticsEvent,
  type DiagnosticsEventState,
} from './diagnostics-events.js';

test('bounding network diagnostics does not discard in-flight request state', () => {
  const state: DiagnosticsEventState = {
    logs: [],
    network: new Map(),
    hiddenNetworkEntries: new Set(),
    inflight: new Map<string, number | undefined>(),
  };

  for (let index = 0; index <= 1_000; index += 1) {
    applyDiagnosticsEvent(
      state,
      networkEvent('Network.requestWillBeSent', {
        requestId: `request-${index}`,
        type: 'Fetch',
        wallTime: 1_700_000_000 + index,
        request: { url: `https://example.test/${index}`, method: 'GET' },
      }),
    );
  }

  assert.equal(
    state.network.size,
    1_000,
    'model-visible diagnostics remain bounded',
  );
  assert.equal(
    state.network.has('request-0'),
    false,
    'the oldest diagnostic entry was evicted',
  );
  assert.equal(
    state.inflight.size,
    1_001,
    'all unfinished requests still block networkidle',
  );

  applyDiagnosticsEvent(
    state,
    networkEvent('Network.responseReceived', {
      requestId: 'request-0',
      response: { status: 200 },
    }),
  );
  assert.equal(
    typeof state.inflight.get('request-0'),
    'number',
    'response liveness survives diagnostics eviction',
  );

  applyDiagnosticsEvent(
    state,
    networkEvent('Network.loadingFinished', { requestId: 'request-0' }),
  );
  assert.equal(
    state.inflight.has('request-0'),
    false,
    'a completion event clears an evicted request id',
  );
});

function networkEvent(
  method: string,
  params: Record<string, unknown>,
): BridgeEvent {
  return { type: 'event', tabId: 1, method, params };
}
