/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  PERMISSION_MODE_VALUES,
  COLOR_VALUES,
  claudePermissionModeToApprovalMode,
  parseStringOrArray,
  parseBackground,
  parseMaxTurns,
  isPermissionMode,
  isColor,
} from './agent-frontmatter-schema.js';

describe('agent-frontmatter-schema', () => {
  describe('enum constants — Claude Code 2.1.168 parity', () => {
    it('PERMISSION_MODE_VALUES matches DL7 $E / kc constant exactly', () => {
      expect([...PERMISSION_MODE_VALUES]).toEqual([
        'acceptEdits',
        'auto',
        'bypassPermissions',
        'default',
        'dontAsk',
        'plan',
      ]);
    });

    it('COLOR_VALUES matches CC _Y allowlist exactly', () => {
      expect([...COLOR_VALUES]).toEqual([
        'red',
        'blue',
        'green',
        'yellow',
        'purple',
        'orange',
        'pink',
        'cyan',
      ]);
    });
  });

  describe('claudePermissionModeToApprovalMode bridge', () => {
    it('maps all 6 CC permissionMode values', () => {
      expect(claudePermissionModeToApprovalMode('default')).toBe('default');
      expect(claudePermissionModeToApprovalMode('plan')).toBe('plan');
      expect(claudePermissionModeToApprovalMode('acceptEdits')).toBe(
        'auto-edit',
      );
      expect(claudePermissionModeToApprovalMode('auto')).toBe('auto-edit');
      expect(claudePermissionModeToApprovalMode('bypassPermissions')).toBe(
        'yolo',
      );
      expect(claudePermissionModeToApprovalMode('dontAsk')).toBe('default');
    });

    it('returns undefined for unknown permissionMode', () => {
      expect(claudePermissionModeToApprovalMode('not-a-mode')).toBeUndefined();
      expect(claudePermissionModeToApprovalMode('')).toBeUndefined();
      expect(claudePermissionModeToApprovalMode(undefined)).toBeUndefined();
    });

    it('preserves restrictive intent of dontAsk by mapping to default', () => {
      // dontAsk in CC denies any tool call that would prompt the user.
      // We map to `default` (which also requires approval) rather than
      // `auto-edit` (which auto-approves). This preserves the restrictive
      // intent.
      expect(claudePermissionModeToApprovalMode('dontAsk')).toBe('default');
    });
  });

  describe('parseStringOrArray — DL7 lenient parsing', () => {
    it('returns undefined for undefined / null', () => {
      expect(parseStringOrArray(undefined)).toBeUndefined();
      expect(parseStringOrArray(null)).toBeUndefined();
    });

    it('parses comma-separated string', () => {
      expect(parseStringOrArray('Read, Edit, Glob')).toEqual([
        'Read',
        'Edit',
        'Glob',
      ]);
    });

    it('accepts YAML array as-is', () => {
      expect(parseStringOrArray(['Read', 'Edit'])).toEqual(['Read', 'Edit']);
    });

    it('filters empty entries from comma-separated string', () => {
      expect(parseStringOrArray('Read,,Edit, ')).toEqual(['Read', 'Edit']);
    });

    it('returns undefined for non-string non-array values', () => {
      expect(parseStringOrArray(42)).toBeUndefined();
      expect(parseStringOrArray({})).toBeUndefined();
      expect(parseStringOrArray(true)).toBeUndefined();
    });

    it('stringifies array elements', () => {
      // CC accepts mixed array — coerces to strings
      expect(parseStringOrArray([1, 'Read', true])).toEqual([
        '1',
        'Read',
        'true',
      ]);
    });
  });

  describe('parseBackground — DL7 boolean-or-string lenience', () => {
    it('accepts boolean true', () => {
      expect(parseBackground(true)).toBe(true);
    });

    it('accepts string "true"', () => {
      expect(parseBackground('true')).toBe(true);
    });

    it('returns undefined for boolean false (matches DL7 — only truthy normalises)', () => {
      expect(parseBackground(false)).toBeUndefined();
    });

    it('returns undefined for string "false"', () => {
      expect(parseBackground('false')).toBeUndefined();
    });

    it('returns undefined for undefined / null / other', () => {
      expect(parseBackground(undefined)).toBeUndefined();
      expect(parseBackground(null)).toBeUndefined();
      expect(parseBackground(42)).toBeUndefined();
      expect(parseBackground('yes')).toBeUndefined();
    });
  });

  describe('parseMaxTurns — DL7 number-or-numeric-string lenience', () => {
    it('accepts positive integer number', () => {
      expect(parseMaxTurns(50)).toBe(50);
    });

    it('accepts positive integer string', () => {
      expect(parseMaxTurns('50')).toBe(50);
    });

    it('returns undefined for zero or negative numbers', () => {
      expect(parseMaxTurns(0)).toBeUndefined();
      expect(parseMaxTurns(-1)).toBeUndefined();
    });

    it('returns undefined for non-integer numbers', () => {
      expect(parseMaxTurns(5.5)).toBeUndefined();
    });

    it('returns undefined for non-numeric strings', () => {
      expect(parseMaxTurns('many')).toBeUndefined();
      expect(parseMaxTurns('')).toBeUndefined();
    });

    it('returns undefined for null / undefined / non-numeric types', () => {
      expect(parseMaxTurns(undefined)).toBeUndefined();
      expect(parseMaxTurns(null)).toBeUndefined();
      expect(parseMaxTurns(true)).toBeUndefined();
      expect(parseMaxTurns({})).toBeUndefined();
    });
  });

  describe('type guards', () => {
    it('isPermissionMode — accepts every PERMISSION_MODE_VALUES, rejects others', () => {
      for (const v of PERMISSION_MODE_VALUES) {
        expect(isPermissionMode(v)).toBe(true);
      }
      expect(isPermissionMode('not-a-mode')).toBe(false);
      expect(isPermissionMode('')).toBe(false);
      expect(isPermissionMode(undefined)).toBe(false);
    });

    it('isColor — accepts every COLOR_VALUES, rejects others (CC silently drops)', () => {
      for (const v of COLOR_VALUES) {
        expect(isColor(v)).toBe(true);
      }
      expect(isColor('magenta')).toBe(false);
      expect(isColor('white')).toBe(false);
      expect(isColor(undefined)).toBe(false);
    });
  });
});
