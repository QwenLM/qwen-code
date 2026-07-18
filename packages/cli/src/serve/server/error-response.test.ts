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

describe('sendBridgeError session writer errors', () => {
  it.each([
    [new SessionWriterConflictError(), 409, 'session_writer_conflict'],
    [new SessionWriterLostError(), 409, 'session_writer_lost'],
    [new SessionTranscriptChangedError(), 409, 'session_transcript_changed'],
    [new SessionWriterUnavailableError(), 503, 'session_writer_unavailable'],
  ] as const)('maps %s to HTTP %i', (error, expectedStatus, errorKind) => {
    const json = vi.fn();
    const status = vi.fn(() => ({ json }));

    sendBridgeError({ status } as unknown as Response, error);

    expect(status).toHaveBeenCalledWith(expectedStatus);
    expect(json).toHaveBeenCalledWith({
      error: error.message,
      code: errorKind,
      errorKind,
    });
  });

  it('does not forward structural ACP writer error details', () => {
    const json = vi.fn();
    const status = vi.fn(() => ({ json }));

    sendBridgeError({ status } as unknown as Response, {
      message: "EACCES: '/private/transcripts/session.jsonl'",
      data: { errorKind: 'session_writer_unavailable' },
    });

    expect(status).toHaveBeenCalledWith(503);
    expect(json).toHaveBeenCalledWith({
      error: 'Session write ownership could not be verified.',
      code: 'session_writer_unavailable',
      errorKind: 'session_writer_unavailable',
    });
  });
});
