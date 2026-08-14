/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  DaemonHttpError,
  isSessionLevelNotFound,
  isSubagentSessionNotFound,
} from '../../src/daemon/DaemonHttpError.js';

const missingAgentBody = {
  code: 'session_not_found',
  sessionId: 'session-1',
  toolCallId: 'call-1',
};

describe('isSubagentSessionNotFound', () => {
  it('matches a 404 whose body identifies the missing agent', () => {
    expect(
      isSubagentSessionNotFound(
        new DaemonHttpError(404, missingAgentBody, 'not found'),
        'call-1',
      ),
    ).toBe(true);
  });

  it('matches a session-level 404 when no toolCallId is required', () => {
    expect(
      isSubagentSessionNotFound(
        new DaemonHttpError(
          404,
          { code: 'session_not_found', sessionId: 'session-1' },
          'not found',
        ),
      ),
    ).toBe(true);
  });

  it.each([
    ['non-DaemonHttpError', new Error('not found'), 'call-1'],
    [
      'non-404 status',
      new DaemonHttpError(500, missingAgentBody, 'server error'),
      'call-1',
    ],
    [
      'missing code',
      new DaemonHttpError(404, { toolCallId: 'call-1' }, 'not found'),
      'call-1',
    ],
    [
      'wrong code',
      new DaemonHttpError(
        404,
        { ...missingAgentBody, code: 'workspace_not_found' },
        'not found',
      ),
      'call-1',
    ],
    [
      'missing toolCallId in body',
      new DaemonHttpError(
        404,
        { code: 'session_not_found', sessionId: 'session-1' },
        'not found',
      ),
      'call-1',
    ],
    [
      'null toolCallId in body',
      new DaemonHttpError(
        404,
        { code: 'session_not_found', sessionId: 'session-1', toolCallId: null },
        'not found',
      ),
      'call-1',
    ],
    [
      'mismatched toolCallId',
      new DaemonHttpError(404, missingAgentBody, 'not found'),
      'call-other',
    ],
  ])('rejects %s', (_label, error, toolCallId) => {
    expect(isSubagentSessionNotFound(error, toolCallId as string)).toBe(false);
  });

  it('rejects non-object bodies', () => {
    expect(
      isSubagentSessionNotFound(
        new DaemonHttpError(404, 'session_not_found', 'not found'),
        'call-1',
      ),
    ).toBe(false);
  });
});

describe('isSessionLevelNotFound', () => {
  it('matches a 404 whose body has no toolCallId', () => {
    expect(
      isSessionLevelNotFound(
        new DaemonHttpError(
          404,
          { code: 'session_not_found', sessionId: 'session-1' },
          'not found',
        ),
      ),
    ).toBe(true);
  });

  it('matches a 404 whose body carries a null toolCallId', () => {
    expect(
      isSessionLevelNotFound(
        new DaemonHttpError(
          404,
          {
            code: 'session_not_found',
            sessionId: 'session-1',
            toolCallId: null,
          },
          'not found',
        ),
      ),
    ).toBe(true);
  });

  it('rejects an agent-level 404', () => {
    expect(
      isSessionLevelNotFound(
        new DaemonHttpError(404, missingAgentBody, 'not found'),
      ),
    ).toBe(false);
  });

  it('rejects a 404 whose body carries a different code', () => {
    expect(
      isSessionLevelNotFound(
        new DaemonHttpError(
          404,
          { code: 'workspace_not_found', sessionId: 'session-1' },
          'not found',
        ),
      ),
    ).toBe(false);
  });

  it('rejects non-404 and non-matching errors', () => {
    expect(
      isSessionLevelNotFound(
        new DaemonHttpError(
          500,
          { code: 'session_not_found', sessionId: 'session-1' },
          'server error',
        ),
      ),
    ).toBe(false);
    expect(isSessionLevelNotFound(new Error('not found'))).toBe(false);
  });
});
