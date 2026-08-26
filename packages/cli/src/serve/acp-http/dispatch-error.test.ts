/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { SessionIdCaseConflictError } from '@qwen-code/qwen-code-core';
import { DaemonDrainingError } from '../server/session-archive.js';
import { StandaloneSessionServiceError } from '../conversations/standalone-session-service.js';
import {
  BridgeChannelQuarantinedError,
  InvalidSessionMetadataError,
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

  it('maps a missing standalone directory as retryable', () => {
    const error = new StandaloneSessionServiceError(
      'working_directory_missing',
      'standalone-1',
      'The standalone working directory is missing.',
      true,
    );
    expect(toRpcError(error)).toEqual({
      code: RPC.INTERNAL_ERROR,
      message: error.message,
      data: {
        code: 'working_directory_missing',
        errorKind: 'working_directory_missing',
        httpStatus: 409,
        retryable: true,
        sessionId: 'standalone-1',
      },
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

  it('maps invalid session metadata to the REST-equivalent invalid_metadata contract', () => {
    // Without an arm, every invalid `pr`/`displayName` over ACP degrades to
    // an opaque -32603 Internal error and clients cannot tell their own bad
    // input from a daemon fault. REST maps the same error to 400
    // `invalid_metadata` with the offending `field`.
    const error = new InvalidSessionMetadataError(
      'pr',
      'must be an object with a positive integer `number`',
    );
    expect(toRpcError(error)).toEqual({
      code: RPC.INVALID_PARAMS,
      message: error.message,
      data: { httpStatus: 400, errorKind: 'invalid_metadata', field: 'pr' },
    });
  });

  it('maps persisted case conflicts to the session_conflict contract', () => {
    const error = new SessionIdCaseConflictError(
      '550e8400-e29b-41d4-a716-446655440149',
      '550E8400-E29B-41D4-A716-446655440149',
    );
    expect(toRpcError(error)).toEqual({
      code: RPC.INTERNAL_ERROR,
      message: error.message,
      data: {
        errorKind: 'session_conflict',
        sessionId: '550e8400-e29b-41d4-a716-446655440149',
      },
    });
  });
});
