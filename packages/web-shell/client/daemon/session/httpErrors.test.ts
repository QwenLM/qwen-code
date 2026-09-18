/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { DaemonHttpError } from '@qwen-code/sdk/daemon';
import {
  extractHttpStatus,
  isRecord,
  isAcpChildCapacityError,
} from './httpErrors';

describe('child capacity classification', () => {
  const code = 'acp_child_capacity_exhausted';
  it.each([
    { code },
    { data: { errorKind: code } },
    { data: { code } },
    { code: 'standalone_creation_rolled_back', capacity: { code } },
    { data: { code: 'standalone_creation_rolled_back', capacity: { code } } },
  ])('recognizes a capacity cause in %j', (body) => {
    expect(
      isAcpChildCapacityError(new DaemonHttpError(503, body, 'capacity')),
    ).toBe(true);
  });
  it.each([
    { code: 'daemon_draining' },
    { code: 'standalone_creation_rolled_back' },
    undefined,
    null,
    [],
  ])('does not classify unrelated 503s (%j)', (body) => {
    expect(isAcpChildCapacityError(new DaemonHttpError(503, body, code))).toBe(
      false,
    );
  });
});

describe('httpErrors', () => {
  it('extracts status from DaemonHttpError', () => {
    expect(
      extractHttpStatus(
        new DaemonHttpError(429, undefined, 'Too many requests'),
      ),
    ).toBe(429);
  });

  it('extracts duck-typed numeric status values', () => {
    expect(extractHttpStatus({ status: 500 })).toBe(500);
  });

  it('ignores non-numeric status values and non-record inputs', () => {
    expect(extractHttpStatus({ status: '500' })).toBeUndefined();
    expect(extractHttpStatus(null)).toBeUndefined();
  });

  it('recognizes records without treating arrays or null as records', () => {
    expect(isRecord({ status: 500 })).toBe(true);
    expect(isRecord([])).toBe(false);
    expect(isRecord(null)).toBe(false);
  });
});
