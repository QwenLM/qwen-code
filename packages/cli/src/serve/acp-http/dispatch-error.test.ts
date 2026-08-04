/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { DaemonDrainingError } from '../server/session-archive.js';
import { ChildHeapPoolExhaustedError } from '../acp-session-bridge.js';
import { toRpcError } from './dispatch.js';
import { RPC } from './json-rpc.js';

describe('toRpcError', () => {
  it('maps sealed maintenance to a JSON-RPC server error', () => {
    expect(toRpcError(new DaemonDrainingError())).toEqual({
      code: RPC.INTERNAL_ERROR,
      message:
        'The daemon is draining and no longer accepts session maintenance.',
      data: { errorKind: 'daemon_draining' },
    });
  });

  it('maps a child heap pool refusal to a retryable 503-equivalent', () => {
    // The ACP mapping is hand-written beside the REST one and drifts silently
    // otherwise; both carry the same contract over different transports.
    const rpc = toRpcError(new ChildHeapPoolExhaustedError(3_687, 8, 512));
    expect(rpc.code).toBe(RPC.INTERNAL_ERROR);
    expect(rpc.data).toMatchObject({
      errorKind: 'child_heap_pool_exhausted',
      childPoolMb: 3_687,
      concurrentChildren: 8,
      httpStatus: 503,
      retryable: true,
    });
  });
});
