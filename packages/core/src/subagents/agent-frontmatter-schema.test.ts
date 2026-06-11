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
  parseAgentHooks,
  parseAgentMcpServers,
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

    it('does not walk the prototype chain for `__proto__` / `constructor`', () => {
      // Implemented with `Map.get`, not a plain object lookup, so prototype
      // keys cannot return Object.prototype / Function constructor.
      expect(claudePermissionModeToApprovalMode('__proto__')).toBeUndefined();
      expect(claudePermissionModeToApprovalMode('constructor')).toBeUndefined();
      expect(
        claudePermissionModeToApprovalMode('hasOwnProperty'),
      ).toBeUndefined();
      expect(claudePermissionModeToApprovalMode('toString')).toBeUndefined();
    });

    it('preserves restrictive intent of dontAsk by mapping to default', () => {
      // dontAsk in CC denies any tool call that would prompt the user.
      // We map to `default` (which also requires approval) rather than
      // `auto-edit` (which auto-approves). This preserves the restrictive
      // intent.
      expect(claudePermissionModeToApprovalMode('dontAsk')).toBe('default');
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

  describe('parseAgentMcpServers — CC gS8 shallow validation', () => {
    it('keeps a record-of-records as-is', () => {
      const input = {
        filesystem: { type: 'stdio', command: 'node' },
        github: { type: 'http', url: 'https://example.com' },
      };
      expect(parseAgentMcpServers(input)).toEqual(input);
    });

    it('drops scalar / array entries inside the record', () => {
      const input = {
        good: { type: 'stdio', command: 'node' },
        scalarBad: 'a-string',
        arrayBad: [1, 2, 3],
        nullBad: null,
      };
      expect(parseAgentMcpServers(input)).toEqual({
        good: { type: 'stdio', command: 'node' },
      });
    });

    it('returns undefined for non-object top-level', () => {
      expect(parseAgentMcpServers(undefined)).toBeUndefined();
      expect(parseAgentMcpServers(null)).toBeUndefined();
      expect(parseAgentMcpServers('a-string')).toBeUndefined();
      expect(parseAgentMcpServers(['arr'])).toBeUndefined();
      expect(parseAgentMcpServers(42)).toBeUndefined();
    });

    it('returns undefined when no entries survive shape filtering', () => {
      const input = { onlyBad: 'string', alsoBad: [1] };
      expect(parseAgentMcpServers(input)).toBeUndefined();
    });
  });

  describe('parseAgentHooks — CC TKO shallow validation', () => {
    it('keeps a record-of-arrays as-is', () => {
      const input = {
        PreToolUse: [
          { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo' }] },
        ],
        PostToolUse: [{ matcher: '*', hooks: [] }],
      };
      expect(parseAgentHooks(input)).toEqual(input);
    });

    it('drops non-array values per event', () => {
      const input = {
        PreToolUse: [{ matcher: 'Bash', hooks: [] }],
        BogusEvent: 'not-an-array',
        AlsoBad: { not: 'an array' },
      };
      expect(parseAgentHooks(input)).toEqual({
        PreToolUse: [{ matcher: 'Bash', hooks: [] }],
      });
    });

    it('returns undefined for non-object top-level', () => {
      expect(parseAgentHooks(undefined)).toBeUndefined();
      expect(parseAgentHooks(null)).toBeUndefined();
      expect(parseAgentHooks('PreToolUse')).toBeUndefined();
      expect(parseAgentHooks(['x'])).toBeUndefined();
    });

    it('returns undefined when no events survive shape filtering', () => {
      const input = { PreToolUse: 'wrong shape' };
      expect(parseAgentHooks(input)).toBeUndefined();
    });
  });
});
