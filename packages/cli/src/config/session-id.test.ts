/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  isValidSessionId,
  normalizeSessionIdForLookup,
  parseCallerSuppliedSessionId,
} from './session-id.js';

describe('parseCallerSuppliedSessionId', () => {
  it.each([
    '550e8400-e29b-11d4-a716-446655440000',
    '550e8400-e29b-21d4-a716-446655440000',
    '550e8400-e29b-31d4-a716-446655440000',
    '550e8400-e29b-41d4-a716-446655440000',
    '550e8400-e29b-51d4-a716-446655440000',
  ])('accepts RFC-variant UUID %s', (sessionId) => {
    expect(parseCallerSuppliedSessionId(sessionId)).toEqual({
      kind: 'valid',
      sessionId,
    });
  });

  it('normalizes mixed case and treats nullish values as absent', () => {
    expect(
      parseCallerSuppliedSessionId('550E8400-E29B-41D4-A716-446655440000'),
    ).toEqual({
      kind: 'valid',
      sessionId: '550e8400-e29b-41d4-a716-446655440000',
    });
    expect(parseCallerSuppliedSessionId(undefined)).toEqual({ kind: 'absent' });
    expect(parseCallerSuppliedSessionId(null)).toEqual({ kind: 'absent' });
  });

  it.each([
    '',
    42,
    false,
    {},
    [],
    '00000000-0000-0000-0000-000000000000',
    '01930000-0000-6000-a000-000000000001',
    '01930000-0000-7000-a000-000000000001',
    '550e8400-e29b-41d4-c716-446655440000',
    '550e8400-e29b-41d4-a716-446655440000-agent-a',
    '../../550e8400-e29b-41d4-a716-446655440000',
  ])('rejects caller value %j', (value) => {
    expect(parseCallerSuppliedSessionId(value)).toEqual({ kind: 'invalid' });
  });
});

describe('normalizeSessionIdForLookup', () => {
  it('lowercases caller-visible UUIDs', () => {
    expect(
      normalizeSessionIdForLookup('550E8400-E29B-41D4-A716-446655440000'),
    ).toBe('550e8400-e29b-41d4-a716-446655440000');
  });

  it.each([
    '550e8400-e29b-41d4-a716-446655440000-agent-WorkerA',
    'legacy-session-ID',
  ])('leaves internal or legacy ID %s unchanged', (sessionId) => {
    expect(normalizeSessionIdForLookup(sessionId)).toBe(sessionId);
  });
});

describe('isValidSessionId', () => {
  it('keeps internal Arena agent session IDs valid', () => {
    expect(
      isValidSessionId('550e8400-e29b-41d4-a716-446655440000-agent-arena_1'),
    ).toBe(true);
  });
});
