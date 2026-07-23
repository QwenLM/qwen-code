/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { computeRequestHmac, requestHmacMatches } from './request-binding.js';

const input = {
  method: 'POST',
  route: '/v1/runtime/search',
  operationId: 'operation-a',
  bodyDigest: 'body-digest-a',
};

describe('request binding', () => {
  it('matches an exact canonical SHA-256 HMAC', () => {
    const value = computeRequestHmac(randomBytes(32), input);

    expect(requestHmacMatches(value, value)).toBe(true);
  });

  it.each([
    '',
    'A',
    'A'.repeat(42),
    'A'.repeat(42) + 'B',
    'A'.repeat(44),
    'A'.repeat(43) + '=',
  ])('rejects malformed or non-canonical base64url: %s', (value) => {
    expect(requestHmacMatches(value, value)).toBe(false);
  });

  it('rejects unequal canonical digests', () => {
    const expected = computeRequestHmac(randomBytes(32), input);
    const actual = computeRequestHmac(randomBytes(32), input);

    expect(requestHmacMatches(expected, actual)).toBe(false);
  });
});
