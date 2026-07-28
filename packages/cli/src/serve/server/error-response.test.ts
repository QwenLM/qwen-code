/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Response } from 'express';
import { describe, expect, it, vi } from 'vitest';
import {
  SessionTranscriptChangedError,
  SessionWriterConflictError,
  SessionWriterLostError,
  SessionWriterUnavailableError,
} from '@qwen-code/qwen-code-core';
import { sendBridgeError } from './error-response.js';

function responseMock(): {
  response: Response;
  status: ReturnType<typeof vi.fn>;
  json: ReturnType<typeof vi.fn>;
} {
  const status = vi.fn();
  const json = vi.fn();
  const response = { status, json };
  status.mockReturnValue(response);
  json.mockReturnValue(response);
  return { response: response as unknown as Response, status, json };
}

describe('sendBridgeError session writer errors', () => {
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
});
