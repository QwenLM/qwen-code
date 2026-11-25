/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { parseRetryAfterMs, readRetryAfterHeaderMs } from './retry-after.js';

describe('Retry-After parsing', () => {
  it('parses delta-seconds', () => {
    expect(parseRetryAfterMs('12')).toBe(12_000);
  });

  it('parses HTTP dates relative to the supplied clock', () => {
    const now = Date.parse('2026-07-10T00:00:00.000Z');
    expect(
      parseRetryAfterMs('Fri, 10 Jul 2026 00:00:05 GMT', now),
    ).toBe(5000);
  });

  it('rejects malformed values and reads headers case-insensitively', () => {
    expect(parseRetryAfterMs('later')).toBeUndefined();
    expect(parseRetryAfterMs(String(Number.MAX_SAFE_INTEGER))).toBeUndefined();
    expect(readRetryAfterHeaderMs(new Headers({ 'Retry-After': '3' }))).toBe(
      3000,
    );
  });
});
