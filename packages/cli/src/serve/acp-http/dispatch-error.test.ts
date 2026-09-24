/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { RequestError } from '@agentclientprotocol/sdk';
import { SessionIdCaseConflictError } from '@qwen-code/qwen-code-core';
import { DaemonDrainingError } from '../server/session-archive.js';
import { StandaloneSessionServiceError } from '../conversations/standalone-session-service.js';
import { WorkspaceRuntimeInitializationError } from '../workspace-runtime-coordinator.js';
import {
  AcpChildCapacityExceededError,
  BridgeChannelQuarantinedError,
  BridgeTimeoutError,
  InvalidSessionMetadataError,
  RestoreInProgressError,
  SessionRestoreTimeoutError,
} from '../acp-session-bridge.js';
import { toRpcError } from './dispatch.js';
import { RPC } from './json-rpc.js';

describe('capacity RPC errors', () => {
  it.each([false, true])(
    'carries capacity through runtime wrapper=%s',
    (wrapped) => {
      const error = new AcpChildCapacityExceededError(6, 6);
      expect(
        toRpcError(
          wrapped ? new WorkspaceRuntimeInitializationError(error) : error,
        ),
      ).toEqual({
        code: RPC.INTERNAL_ERROR,
        message: error.message,
        data: {
          httpStatus: 503,
          errorKind: error.code,
          maxConcurrentChildren: 6,
          committedAcpChildren: 6,
        },
      });
    },
  );
  it('preserves standalone rollback classification with nested capacity', () => {
    const capacity = {
      code: 'acp_child_capacity_exhausted' as const,
      maxConcurrentChildren: 1,
      committedAcpChildren: 1,
    };
    expect(
      toRpcError(
        new StandaloneSessionServiceError(
          'standalone_creation_rolled_back',
          'id',
          'rollback',
          true,
          capacity,
        ),
      ),
    ).toMatchObject({
      data: {
        code: 'standalone_creation_rolled_back',
        httpStatus: 503,
        capacity,
        sessionId: 'id',
      },
    });
  });
});

describe('toRpcError', () => {
  it.each(['request', 'wire'] as const)(
    'preserves workflow parameter details from a %s error',
    (transport) => {
      const source = RequestError.invalidParams(
        { errorKind: 'workflow_invalid_params' },
        '`sourceRef` must contain non-empty id and revision strings',
      );
      const error: unknown =
        transport === 'request'
          ? source
          : JSON.parse(JSON.stringify(source.toErrorResponse()));

      expect(toRpcError(error)).toEqual({
        code: RPC.INVALID_PARAMS,
        message: source.message,
        data: { errorKind: 'workflow_invalid_params', httpStatus: 400 },
      });
    },
  );

  // A run whose stored state rules out the action — no journal to resume,
  // args its snapshot could not keep — is not a daemon fault: the client
  // gets the reason and a status it can branch on.
  it.each([
    'workflow_journal_unavailable',
    'workflow_args_unavailable',
    'workflow_run_live_elsewhere',
  ])('answers %s as a conflict that keeps its message', (errorKind) => {
    const source = RequestError.invalidParams(
      { errorKind },
      'Workflow run wf_1234abcd has no journal on disk',
    );

    expect(toRpcError(source)).toEqual({
      code: RPC.INVALID_PARAMS,
      message: source.message,
      data: { errorKind, httpStatus: 409 },
    });
  });

  // Nothing started, and the daemon is not at fault for it: the write that
  // keeps a second runner off this journal did not land. Retryable.
  it('answers workflow_not_recorded as unavailable, with its message', () => {
    const source = RequestError.invalidParams(
      { errorKind: 'workflow_not_recorded' },
      'Could not record that workflow run wf_1234abcd is running again',
    );

    expect(toRpcError(source)).toEqual({
      code: RPC.INVALID_PARAMS,
      message: source.message,
      data: { errorKind: 'workflow_not_recorded', httpStatus: 503 },
    });
  });

  it.each([
    new Error('Unexpected workflow failure'),
    RequestError.invalidParams(undefined, 'Unclassified parameter error'),
    RequestError.internalError(
      { errorKind: 'unknown_workflow_error' },
      'Unexpected workflow failure',
    ),
  ])('keeps unclassified errors as internal failures: %s', (error) => {
    expect(toRpcError(error)).toEqual({
      code: RPC.INTERNAL_ERROR,
      message: 'Internal error',
      data: { errorKind: 'internal' },
    });
  });

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

  it('maps session initialization timeouts with the public retry contract', () => {
    const error = new BridgeTimeoutError('newSession', 10_000);
    expect(toRpcError(error)).toEqual({
      code: RPC.INTERNAL_ERROR,
      message: error.message,
      data: {
        code: 'init_timeout',
        errorKind: 'init_timeout',
        httpStatus: 504,
        retryable: true,
        retryAfterSeconds: 10,
        timeoutMs: 10_000,
      },
    });
  });

  it('leaves non-session-initialization bridge timeouts on the generic path', () => {
    expect(toRpcError(new BridgeTimeoutError('initialize', 10_000))).toEqual({
      code: RPC.INTERNAL_ERROR,
      message: 'Internal error',
      data: { errorKind: 'internal' },
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

  it('carries every quarantine reason and its backoff hint', () => {
    // A fresh-id request never reaches the same-id 409, so this payload is the
    // only operation-budget-scale backoff signal such a caller gets.
    for (const reason of [
      'restore_cleanup_failed',
      'restore_settlement_overdue',
      'new_session_cleanup_failed',
      'new_session_settlement_overdue',
    ] as const) {
      const error = new BridgeChannelQuarantinedError(reason, 90);
      expect(toRpcError(error)).toMatchObject({
        data: {
          reason,
          retryAfterSeconds: 90,
          httpStatus: 503,
        },
      });
    }
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
