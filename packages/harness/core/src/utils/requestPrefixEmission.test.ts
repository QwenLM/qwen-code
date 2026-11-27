/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ENV_EXPOSE_REQUEST_PREFIX_DIAGNOSTICS,
  emitModelRequestPrefix,
} from './diagnosticInterceptors.js';
import { sessionLogger } from './sessionLogger.js';

// Core setup imports diagnostics transitively before this file's mocks.
vi.hoisted(() => vi.resetModules());
vi.mock('./sessionLogger.js', () => ({
  sessionLogger: { event: vi.fn() },
  normalizeDiagnosticValue: vi.fn(),
  summarizeDiagnosticText: vi.fn(),
}));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.mocked(sessionLogger.event).mockReset();
});

describe('request prefix emission', () => {
  const input = {
    sessionId: 'session-id',
    requestId: 'request-id',
    prompt: {
      messages: [{ role: 'user' as const, content: 'private-prompt' }],
    },
  };

  it('requires explicit opt-in and logs only fingerprints with request identity', () => {
    vi.stubEnv(ENV_EXPOSE_REQUEST_PREFIX_DIAGNOSTICS, '0');
    emitModelRequestPrefix(input);
    expect(sessionLogger.event).not.toHaveBeenCalled();
    vi.stubEnv(ENV_EXPOSE_REQUEST_PREFIX_DIAGNOSTICS, '1');
    emitModelRequestPrefix(input);
    expect(sessionLogger.event).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'model.request.prefix',
        ids: { session_id: 'session-id', request_id: 'request-id' },
      }),
    );
    expect(
      JSON.stringify(vi.mocked(sessionLogger.event).mock.calls),
    ).not.toContain('private-prompt');
  });

  it('does not propagate diagnostic failures into inference', () => {
    vi.stubEnv(ENV_EXPOSE_REQUEST_PREFIX_DIAGNOSTICS, '1');
    vi.mocked(sessionLogger.event).mockImplementation(() => {
      throw new Error('write failed');
    });
    expect(() => emitModelRequestPrefix(input)).not.toThrow();
  });
});
