/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { DaemonDrainingError } from '../server/session-archive.js';
import {
  BridgeChannelQuarantinedError,
  RestoreInProgressError,
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
        retryAfterSeconds: 60,
        sessionId: 'persisted-1',
        action: 'resume',
        timeoutMs: 60_000,
      },
    });
  });

  it('maps the abandoned-restore fence with its reason and hint', () => {
    // SDK transport negotiation prefers acp-ws and acp-http over REST, so
    // without this mapping the default arm turns a retryable fence into an
    // opaque internal 500 on exactly the transports most clients use.
    const error = new RestoreInProgressError('persisted-1', 'load', 'load', {
      reason: 'awaiting_abandoned_cleanup',
      retryAfterSeconds: 90,
    });
    expect(toRpcError(error)).toEqual({
      code: RPC.INTERNAL_ERROR,
      message: error.message,
      data: {
        code: 'restore_in_progress',
        errorKind: 'restore_in_progress',
        httpStatus: 409,
        retryable: true,
        reason: 'awaiting_abandoned_cleanup',
        retryAfterSeconds: 90,
        sessionId: 'persisted-1',
        activeAction: 'load',
        requestedAction: 'load',
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
        retryAfterSeconds: 5,
      },
    });
  });

  it('carries the quarantine backoff hint for a settlement-overdue channel', () => {
    // Quarantine outlives the fence, and a fresh-id request never reaches the
    // 409 that carries the real hint — so this payload is the only backoff
    // signal such a caller gets.
    const error = new BridgeChannelQuarantinedError(
      'restore_settlement_overdue',
      90,
    );
    expect(toRpcError(error)).toMatchObject({
      data: {
        reason: 'restore_settlement_overdue',
        retryAfterSeconds: 90,
        httpStatus: 503,
      },
    });
  });
});
