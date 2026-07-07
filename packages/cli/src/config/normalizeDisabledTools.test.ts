/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { normalizeDisabledToolList } from './normalizeDisabledTools.js';

describe('normalizeDisabledToolList', () => {
  describe('non-array short-circuit', () => {
    it('returns [] for undefined', () => {
      expect(normalizeDisabledToolList(undefined)).toEqual([]);
    });
    it('returns [] for null', () => {
      expect(normalizeDisabledToolList(null)).toEqual([]);
    });
    it('returns [] for a plain object', () => {
      expect(normalizeDisabledToolList({ 0: 'Foo' })).toEqual([]);
    });
    it('returns [] for a number', () => {
      expect(normalizeDisabledToolList(42)).toEqual([]);
    });
    it('returns [] for a string', () => {
      expect(normalizeDisabledToolList('Foo')).toEqual([]);
    });
    it('returns [] for a boolean', () => {
      expect(normalizeDisabledToolList(true)).toEqual([]);
    });
  });

  describe('typeof-string filter', () => {
    it('drops non-string entries individually without aborting', () => {
      expect(
        normalizeDisabledToolList([
          42,
          'Foo',
          null,
          'Bar',
          { name: 'Baz' },
          true,
          'Qux',
        ]),
      ).toEqual(['Foo', 'Bar', 'Qux']);
    });
  });

  describe('trim + empty-skip', () => {
    it('trims surrounding whitespace', () => {
      expect(normalizeDisabledToolList(['  Foo  ', '\tBar\n'])).toEqual([
        'Foo',
        'Bar',
      ]);
    });
    it('drops empty-after-trim entries', () => {
      expect(normalizeDisabledToolList(['', '  ', '\t', '\n', 'Foo'])).toEqual([
        'Foo',
      ]);
    });
    it('returns [] when every entry is whitespace-only', () => {
      expect(normalizeDisabledToolList(['', '  ', '\t', '\n'])).toEqual([]);
    });
  });

  describe('dedupe', () => {
    it('removes exact duplicates, preserving first-occurrence order', () => {
      expect(normalizeDisabledToolList(['Foo', 'Bar', 'Foo', 'Baz'])).toEqual([
        'Foo',
        'Bar',
        'Baz',
      ]);
    });
    it('dedupes after trim — whitespace variants collapse', () => {
      expect(normalizeDisabledToolList(['Foo', '  Foo', 'Foo  '])).toEqual([
        'Foo',
      ]);
    });
    it('does NOT case-fold — `Foo` and `foo` stay distinct', () => {
      expect(normalizeDisabledToolList(['Foo', 'foo', 'FOO'])).toEqual([
        'Foo',
        'foo',
        'FOO',
      ]);
    });
  });

  describe('boot/restart parity scenarios (BkwQW class — wenshao #4329)', () => {
    it("['Foo', '  Foo  ', '']  → ['Foo'] (the bug that the helper was extracted to prevent)", () => {
      // Pre-extraction, this scenario was handled at boot (config.ts) but
      // the MCP restart path (acpAgent.ts) had only typeof-string filter.
      // After fold-in, both call sites share this helper so a hand-edited
      // `tools.disabled: ['  Foo  ']` produces Set(['Foo']) at boot AND
      // after every subsequent MCP restart.
      expect(normalizeDisabledToolList(['Foo', '  Foo  ', ''])).toEqual([
        'Foo',
      ]);
    });

    it('mixed real-world settings — typo + extra whitespace + dup', () => {
      expect(
        normalizeDisabledToolList([
          'ShellTool',
          'WebFetch',
          '  ShellTool', // typo: extra space
          '', // operator pressed Enter
          'WebFetch  ', // trailing whitespace
        ]),
      ).toEqual(['ShellTool', 'WebFetch']);
    });
  });

  describe('order preservation', () => {
    it('first-occurrence order survives dedupe + trim', () => {
      expect(
        normalizeDisabledToolList(['Zebra', 'Apple', '  Zebra', 'Banana']),
      ).toEqual(['Zebra', 'Apple', 'Banana']);
    });
  });
});
