/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Response } from 'express';
import { describe, expect, it, vi } from 'vitest';
import { SessionNotFoundError } from '@qwen-code/acp-bridge/bridgeErrors';
import {
  SessionIdCaseConflictError,
  SessionTranscriptChangedError,
  SessionWriterConflictError,
  SessionWriterLostError,
  SessionWriterUnavailableError,
} from '@qwen-code/qwen-code-core';
import { sendBridgeError } from './error-response.js';
import { DaemonDrainingError } from './session-archive.js';
import { StandaloneSessionServiceError } from '../conversations/standalone-session-service.js';
import { ConversationRuntimeOwnershipError } from '../conversations/conversation-runtime-errors.js';
import type { DaemonLogger } from '../daemon-logger.js';

function responseMock(): {
  response: Response;
  status: ReturnType<typeof vi.fn>;
  json: ReturnType<typeof vi.fn>;
  set: ReturnType<typeof vi.fn>;
} {
  const status = vi.fn();
  const json = vi.fn();
  const set = vi.fn();
  const response = { status, json, set };
  status.mockReturnValue(response);
  json.mockReturnValue(response);
  set.mockReturnValue(response);
  return { response: response as unknown as Response, status, json, set };
}

describe('sendBridgeError session writer errors', () => {
  it('serializes the structured session-closing code', () => {
    const { response, status, json } = responseMock();

    sendBridgeError(
      response,
      new SessionNotFoundError(
        'session-1',
        'The session is closing',
        'session_closing',
      ),
    );

    expect(status).toHaveBeenCalledWith(404);
    expect(json).toHaveBeenCalledWith({
      error: 'No session with id "session-1". The session is closing',
      code: 'session_closing',
      sessionId: 'session-1',
    });
  });

  it('maps sealed session maintenance to daemon_draining', () => {
    const { response, status, json } = responseMock();

    sendBridgeError(response, new DaemonDrainingError());

    expect(status).toHaveBeenCalledWith(503);
    expect(json).toHaveBeenCalledWith({
      error:
        'The daemon is draining and no longer accepts session maintenance.',
      code: 'daemon_draining',
      errorKind: 'daemon_draining',
    });
  });

  it.each([
    ['conversation_runtime_in_use', true],
    ['conversation_runtime_unavailable', true],
    ['conversation_root_compromised', false],
    ['conversation_runtime_ownership_compromised', false],
  ] as const)(
    'maps Conversations runtime ownership %s to 503',
    (code, retryable) => {
      const { response, status, json } = responseMock();
      const error = new ConversationRuntimeOwnershipError(code, retryable);

      sendBridgeError(response, error);

      expect(status).toHaveBeenCalledWith(503);
      expect(json).toHaveBeenCalledWith({
        error: error.message,
        code,
        retryable,
      });
    },
  );

  it.each([
    ['invalid_request', 400, false],
    ['standalone_session_not_found', 404, false],
    ['session_busy', 409, true],
    ['working_directory_compromised', 409, false],
    ['deletion_recovery_compromised', 409, false],
    ['standalone_session_operation_failed', 500, false],
    ['standalone_creation_rolled_back', 500, true],
    ['standalone_creation_outcome_unknown', 500, false],
    ['transcript_deletion_failed', 500, true],
    ['transcript_deletion_outcome_unknown', 500, false],
    ['working_directory_recovery_failed', 500, true],
  ] as const)(
    'maps standalone service %s to %i',
    (code, expectedStatus, retryable) => {
      const { response, status, json, set } = responseMock();
      const error = new StandaloneSessionServiceError(
        code,
        'session-1',
        'public standalone error',
        retryable,
      );

      sendBridgeError(response, error);

      expect(status).toHaveBeenCalledWith(expectedStatus);
      expect(json).toHaveBeenCalledWith({
        error: 'public standalone error',
        code,
        errorKind: code,
        retryable,
        sessionId: 'session-1',
      });
      expect(set).toHaveBeenCalledTimes(retryable ? 1 : 0);
    },
  );

  it('records 500-class standalone failures with request context', () => {
    const { response } = responseMock();
    const daemonLog = {
      warn: vi.fn(),
    } as unknown as DaemonLogger;
    const error = new StandaloneSessionServiceError(
      'standalone_creation_outcome_unknown',
      'session-1',
      'standalone outcome unknown',
    );

    sendBridgeError(
      response,
      error,
      { route: 'POST /standalone/session', sessionId: 'session-1' },
      daemonLog,
    );

    expect(daemonLog.warn).toHaveBeenCalledWith('standalone outcome unknown', {
      route: 'POST /standalone/session',
      sessionId: 'session-1',
      errorType: 'StandaloneSessionServiceError',
    });
  });

  it('maps case-only persisted conflicts without active/archive guidance', () => {
    const { response, status, json } = responseMock();
    const sessionId = '550e8400-e29b-41d4-a716-446655440000';

    sendBridgeError(response, new SessionIdCaseConflictError(sessionId));

    expect(status).toHaveBeenCalledWith(409);
    expect(json).toHaveBeenCalledWith({
      error: `Multiple persisted sessions match "${sessionId}" by case.`,
      code: 'session_conflict',
      sessionId,
    });
  });

  it.each([
    {
      error: new SessionWriterConflictError(),
      status: 409,
      kind: 'session_writer_conflict',
      message: 'This session is already open in another Qwen process.',
    },
    {
      error: new SessionWriterLostError(),
      status: 409,
      kind: 'session_writer_lost',
      message: 'Write ownership for this session was lost.',
    },
    {
      error: new SessionTranscriptChangedError(),
      status: 409,
      kind: 'session_transcript_changed',
      message: 'The session transcript changed outside its active writer.',
    },
    {
      error: new SessionWriterUnavailableError({
        cause: new Error('private lock details'),
      }),
      status: 503,
      kind: 'session_writer_unavailable',
      message: 'Session write ownership could not be verified.',
    },
  ])(
    'maps $kind without exposing diagnostics',
    ({ error, status: expectedStatus, kind, message }) => {
      const { response, status, json } = responseMock();

      sendBridgeError(response, error);

      expect(status).toHaveBeenCalledWith(expectedStatus);
      expect(json).toHaveBeenCalledWith({
        error: message,
        code: kind,
        errorKind: kind,
      });
    },
  );

  it('maps a serialized writer error with the fixed public message', () => {
    const { response, status, json } = responseMock();
    const error = Object.assign(new Error('private lock details'), {
      data: { errorKind: 'session_writer_unavailable' },
    });

    sendBridgeError(response, error);

    expect(status).toHaveBeenCalledWith(503);
    expect(json).toHaveBeenCalledWith({
      error: 'Session write ownership could not be verified.',
      code: 'session_writer_unavailable',
      errorKind: 'session_writer_unavailable',
    });
  });

  it('maps an untrusted workspace bridge error to 403', () => {
    const { response, status, json } = responseMock();
    const error = Object.assign(new Error('Workspace is not trusted'), {
      data: { errorKind: 'untrusted_workspace', httpStatus: 403 },
    });

    sendBridgeError(response, error);

    expect(status).toHaveBeenCalledWith(403);
    expect(json).toHaveBeenCalledWith({
      error: 'Workspace is not trusted',
      code: 'untrusted_workspace',
    });
  });

  it.each([
    {
      kind: 'session_busy',
      message: 'The session is busy.',
      retryable: true,
    },
    {
      kind: 'working_directory_missing',
      message: 'The standalone working directory is missing.',
      retryable: true,
    },
    {
      kind: 'working_directory_compromised',
      message: 'The standalone working directory identity is compromised.',
      retryable: false,
    },
  ] as const)(
    'maps $kind without exposing child error details',
    ({ kind, message, retryable }) => {
      const { response, status, json, set } = responseMock();
      const error = Object.assign(new Error('/private/path leaked'), {
        data: { errorKind: kind, path: '/private/path' },
      });

      sendBridgeError(response, error, { sessionId: 'session-1' });

      expect(status).toHaveBeenCalledWith(409);
      expect(json).toHaveBeenCalledWith({
        error: message,
        code: kind,
        errorKind: kind,
        retryable,
        sessionId: 'session-1',
      });
      expect(set).toHaveBeenCalledTimes(retryable ? 1 : 0);
    },
  );

  it.each([
    ['goal_conflict', 409],
    ['goal_invalid_transition', 409],
    ['goal_persist_failed', 500],
  ] as const)('maps %s to %i', (kind, expectedStatus) => {
    // A persistence failure is not retryable; surfacing it as a 409 sends the
    // client back to re-sync `current` and retry a write that cannot succeed,
    // and the inverse turns an ordinary conflict into a 500.
    const { response, status, json } = responseMock();
    const error = Object.assign(new Error('goal control failed'), {
      data: { errorKind: kind },
    });

    sendBridgeError(response, error);

    expect(status).toHaveBeenCalledWith(expectedStatus);
    expect(json).toHaveBeenCalledWith({
      error: 'goal control failed',
      code: kind,
    });
  });

  it('forwards the current Goal snapshot on a conflict', () => {
    // The client re-syncs from `current` before retrying; dropping it leaves it
    // retrying against the revision the daemon just rejected.
    const { response, json } = responseMock();
    const current = { v: 2, activity: 'idle', goal: null };
    const error = Object.assign(new Error('goal revision changed'), {
      data: { errorKind: 'goal_conflict', current },
    });

    sendBridgeError(response, error);

    expect(json).toHaveBeenCalledWith({
      error: 'goal revision changed',
      code: 'goal_conflict',
      current,
    });
  });

  it.each([
    ['invalid_session_attachment_reference', 400],
    ['session_attachment_gone', 410],
  ] as const)('maps %s to %i', (code, expectedStatus) => {
    const { response, status, json } = responseMock();
    const error = Object.assign(new Error('media reference failed'), { code });

    sendBridgeError(response, error);

    expect(status).toHaveBeenCalledWith(expectedStatus);
    expect(json).toHaveBeenCalledWith({
      error: 'media reference failed',
      code,
    });
  });
});
