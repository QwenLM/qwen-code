/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { DaemonDrainingError } from '../server/session-archive.js';
import {
  BridgeChannelQuarantinedError,
  SessionRestoreTimeoutError,
} from '../acp-session-bridge.js';
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

  it('maps session restore timeouts with the REST-equivalent details', () => {
    const error = new SessionRestoreTimeoutError(
      'persisted-1',
      'resume',
      60_000,
    );
    expect(toRpcError(error)).toEqual({
      code: RPC.INTERNAL_ERROR,
      message: error.message,
      data: {
        code: 'session_restore_timeout',
        errorKind: 'restore_timeout',
        httpStatus: 504,
        retryable: true,
        sessionId: 'persisted-1',
        action: 'resume',
        timeoutMs: 60_000,
      },
    });
  });

  it('maps restore cleanup quarantine as channel unavailable', () => {
    const error = new BridgeChannelQuarantinedError();
    expect(toRpcError(error)).toEqual({
      code: RPC.INTERNAL_ERROR,
      message: error.message,
      data: {
        code: 'acp_channel_unavailable',
        errorKind: 'acp_channel_unavailable',
        httpStatus: 503,
        retryable: true,
        reason: 'restore_cleanup_failed',
      },
    });
  });
});
