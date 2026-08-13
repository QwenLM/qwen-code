/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MAX_JOURNAL_BYTES,
  DEFAULT_MAX_JOURNAL_EVENTS,
  normalizeJournalGrowthPoolBytes,
  normalizeMaxJournalBytes,
  normalizeMaxJournalEvents,
} from './replayWindowLimits.js';

describe('normalizeJournalGrowthPoolBytes', () => {
  it('treats undefined as "growth disabled"', () => {
    expect(normalizeJournalGrowthPoolBytes(undefined)).toBeUndefined();
  });

  it('accepts valid safe integers', () => {
    expect(normalizeJournalGrowthPoolBytes(1)).toBe(1);
    expect(normalizeJournalGrowthPoolBytes(8 * 1024 * 1024)).toBe(
      8 * 1024 * 1024,
    );
    expect(normalizeJournalGrowthPoolBytes(Number.MAX_SAFE_INTEGER)).toBe(
      Number.MAX_SAFE_INTEGER,
    );
  });

  it.each([
    ['zero', 0],
    ['a negative', -1],
    ['a fraction', 1.5],
    ['NaN', Number.NaN],
    ['positive infinity', Number.POSITIVE_INFINITY],
    ['negative infinity', Number.NEGATIVE_INFINITY],
    ['an unsafe integer', Number.MAX_SAFE_INTEGER + 1],
  ])('rejects %s', (_name, value) => {
    expect(() => normalizeJournalGrowthPoolBytes(value)).toThrow(TypeError);
    expect(() => normalizeJournalGrowthPoolBytes(value)).toThrow(
      /positive safe integer/,
    );
  });
});

describe('normalizeMaxJournalEvents', () => {
  it('defaults when undefined', () => {
    expect(normalizeMaxJournalEvents(undefined)).toBe(
      DEFAULT_MAX_JOURNAL_EVENTS,
    );
  });

  it('accepts valid safe integers', () => {
    expect(normalizeMaxJournalEvents(1)).toBe(1);
    expect(normalizeMaxJournalEvents(Number.MAX_SAFE_INTEGER)).toBe(
      Number.MAX_SAFE_INTEGER,
    );
  });

  it.each([
    ['zero', 0],
    ['a negative', -1],
    ['a fraction', 1.5],
    ['NaN', Number.NaN],
    ['positive infinity', Number.POSITIVE_INFINITY],
    ['negative infinity', Number.NEGATIVE_INFINITY],
    ['an unsafe integer', Number.MAX_SAFE_INTEGER + 1],
  ])('rejects %s', (_name, value) => {
    expect(() => normalizeMaxJournalEvents(value)).toThrow(
      /positive safe integer/,
    );
  });
});

describe('normalizeMaxJournalBytes', () => {
  it('defaults when undefined', () => {
    expect(normalizeMaxJournalBytes(undefined)).toBe(DEFAULT_MAX_JOURNAL_BYTES);
  });

  it('accepts valid safe integers', () => {
    expect(normalizeMaxJournalBytes(1)).toBe(1);
    expect(normalizeMaxJournalBytes(Number.MAX_SAFE_INTEGER)).toBe(
      Number.MAX_SAFE_INTEGER,
    );
  });

  it.each([
    ['zero', 0],
    ['a negative', -1],
    ['a fraction', 1.5],
    ['NaN', Number.NaN],
    ['positive infinity', Number.POSITIVE_INFINITY],
    ['negative infinity', Number.NEGATIVE_INFINITY],
    ['an unsafe integer', Number.MAX_SAFE_INTEGER + 1],
  ])('rejects %s', (_name, value) => {
    expect(() => normalizeMaxJournalBytes(value)).toThrow(
      /positive safe integer/,
    );
  });
});
