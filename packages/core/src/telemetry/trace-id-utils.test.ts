/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  deriveTraceId,
  randomSpanId,
  randomHexString,
} from './trace-id-utils.js';

describe('deriveTraceId', () => {
  it('returns a 32-char hex string', () => {
    const traceId = deriveTraceId('test-session-id');
    expect(traceId).toHaveLength(32);
    expect(traceId).toMatch(/^[0-9a-f]{32}$/);
  });

  it('is deterministic for the same session ID', () => {
    const id = 'stable-session-id';
    expect(deriveTraceId(id)).toBe(deriveTraceId(id));
  });

  it('produces different trace IDs for different session IDs', () => {
    expect(deriveTraceId('session-a')).not.toBe(deriveTraceId('session-b'));
  });
});

describe('randomSpanId', () => {
  it('returns a 16-char hex string', () => {
    const spanId = randomSpanId();
    expect(spanId).toHaveLength(16);
    expect(spanId).toMatch(/^[0-9a-f]{16}$/);
  });

  it('returns different values on each call', () => {
    expect(randomSpanId()).not.toBe(randomSpanId());
  });
});

describe('randomHexString', () => {
  it('returns a string of the requested length', () => {
    expect(randomHexString(32)).toHaveLength(32);
    expect(randomHexString(16)).toHaveLength(16);
  });

  it('handles odd lengths correctly', () => {
    expect(randomHexString(15)).toHaveLength(15);
    expect(randomHexString(7)).toHaveLength(7);
  });

  it('returns only hex characters', () => {
    expect(randomHexString(32)).toMatch(/^[0-9a-f]+$/);
  });
});
