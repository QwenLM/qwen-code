/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';

import {
  redactHeadersForDebug,
  redactTextForDebug,
} from './log-redaction.js';

describe('qoder log redaction', () => {
  it('masks credential-bearing request headers', () => {
    expect(
      redactHeadersForDebug({
        Authorization: 'Bearer token',
        'x-api-key': 'key',
        cookie: 'session=1',
        'Cosy-Paid-Confirmed': 'true',
        'Content-Type': 'application/json',
      }),
    ).toEqual({
      Authorization: '[redacted]',
      'x-api-key': '[redacted]',
      cookie: '[redacted]',
      'Cosy-Paid-Confirmed': 'true',
      'Content-Type': 'application/json',
    });
  });

  it('redacts bearer tokens and sensitive JSON fields', () => {
    const redacted = redactTextForDebug(
      '{"access_token":"abc","message":"bad","machineCode":"xyz"} Bearer token-123',
    );

    expect(redacted).toContain('"access_token":"[redacted]"');
    expect(redacted).toContain('"machineCode":"[redacted]"');
    expect(redacted).toContain('Bearer [redacted]');
    expect(redacted).toContain('"message":"bad"');
    expect(redacted).not.toContain('abc');
    expect(redacted).not.toContain('xyz');
    expect(redacted).not.toContain('token-123');
  });
});
