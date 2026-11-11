/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  isSharedSettingSource,
  permissionRuleSourceDisplayString,
  getAllowRules,
  getDenyRules,
  getAskRules,
  detectUnreachableRules,
} from './shadowedRuleDetection.js';
import type { PermissionRules } from '../manager/decision/index.js';

/** A rule set with only the buckets a case cares about filled in. */
function makeRules(overrides: Partial<PermissionRules> = {}): PermissionRules {
  return { allow: {}, deny: {}, ask: {}, ...overrides };
}

describe('shadowedRuleDetection', () => {
  // ========================================================================
  // Source Classification
  // ========================================================================

  describe('isSharedSettingSource', () => {
    it('should return true for projectSettings', () => {
      expect(isSharedSettingSource('projectSettings')).toBe(true);
    });

    it('should return true for policySettings', () => {
      expect(isSharedSettingSource('policySettings')).toBe(true);
    });

    it('should return true for command', () => {
      expect(isSharedSettingSource('command')).toBe(true);
    });

    it('should return false for userSettings', () => {
      expect(isSharedSettingSource('userSettings')).toBe(false);
    });

    it('should return false for localSettings', () => {
      expect(isSharedSettingSource('localSettings')).toBe(false);
    });

    it('should return false for session', () => {
      expect(isSharedSettingSource('session')).toBe(false);
    });

    it('should return false for cliArg', () => {
      expect(isSharedSettingSource('cliArg')).toBe(false);
    });
  });

  // ========================================================================
  // Source Display
  // ========================================================================

  describe('permissionRuleSourceDisplayString', () => {
    it('should return readable names', () => {
      expect(permissionRuleSourceDisplayString('userSettings')).toBe(
        'user settings',
      );
      expect(permissionRuleSourceDisplayString('projectSettings')).toBe(
        'project settings',
      );
      expect(permissionRuleSourceDisplayString('localSettings')).toBe(
        'local settings',
      );
      expect(permissionRuleSourceDisplayString('cliArg')).toBe('CLI argument');
      expect(permissionRuleSourceDisplayString('session')).toBe('session');
    });
  });

  // ========================================================================
  // Rule Extraction
  // ========================================================================

  describe('getAllowRules', () => {
    it('should extract allow rules from context', () => {
      const ctx = makeRules({
        allow: {
          localSettings: [
            'Bash(git:*)',
            'Bash(npm install)',
          ],
        },
      });
      const rules = getAllowRules(ctx);
      expect(rules).toHaveLength(2);
      expect(rules[0].source).toBe('localSettings');
      expect(rules[0].ruleBehavior).toBe('allow');
      expect(rules[0].ruleValue.toolName).toBe('Bash');
      expect(rules[0].ruleValue.ruleContent).toBe('git:*');
    });

    it('should return empty array when no allow rules', () => {
      const ctx = makeRules();
      expect(getAllowRules(ctx)).toEqual([]);
    });

    it('should merge rules from multiple sources', () => {
      const ctx = makeRules({
        allow: {
          userSettings: ['Bash(git:*)'],
          localSettings: ['Bash(npm install)'],
        },
      });
      const rules = getAllowRules(ctx);
      expect(rules).toHaveLength(2);
      expect(rules.map((r) => r.source)).toContain('userSettings');
      expect(rules.map((r) => r.source)).toContain('localSettings');
    });
  });

  describe('getDenyRules', () => {
    it('should extract deny rules from context', () => {
      const ctx = makeRules({
        deny: {
          projectSettings: ['Bash'],
        },
      });
      const rules = getDenyRules(ctx);
      expect(rules).toHaveLength(1);
      expect(rules[0].ruleBehavior).toBe('deny');
      expect(rules[0].ruleValue.toolName).toBe('Bash');
    });
  });

  describe('getAskRules', () => {
    it('should extract ask rules from context', () => {
      const ctx = makeRules({
        ask: {
          userSettings: ['Bash'],
        },
      });
      const rules = getAskRules(ctx);
      expect(rules).toHaveLength(1);
      expect(rules[0].ruleBehavior).toBe('ask');
    });
  });

  // ========================================================================
  // detectUnreachableRules
  // ========================================================================

  describe('detectUnreachableRules', () => {

    it('should return empty array when no rules conflict', () => {
      const ctx = makeRules({
        allow: {
          localSettings: ['Bash(git:*)'],
        },
      });
      const result = detectUnreachableRules(ctx);
      expect(result).toEqual([]);
    });

    it('should detect allow rule shadowed by tool-wide deny', () => {
      const ctx = makeRules({
        allow: {
          localSettings: ['Bash(git:*)'],
        },
        deny: {
          projectSettings: ['Bash'],
        },
      });
      const result = detectUnreachableRules(ctx);
      expect(result).toHaveLength(1);
      expect(result[0].shadowType).toBe('deny');
      expect(result[0].rule.ruleValue.ruleContent).toBe('git:*');
      expect(result[0].shadowedBy.source).toBe('projectSettings');
    });

    it('should detect allow rule shadowed by tool-wide ask', () => {
      const ctx = makeRules({
        allow: {
          localSettings: ['Bash(npm install)'],
        },
        ask: {
          projectSettings: ['Bash'],
        },
      });
      const result = detectUnreachableRules(ctx);
      expect(result).toHaveLength(1);
      expect(result[0].shadowType).toBe('ask');
    });

    it('should prefer deny over ask when both shadow', () => {
      const ctx = makeRules({
        allow: {
          localSettings: ['Bash(git:*)'],
        },
        deny: {
          projectSettings: ['Bash'],
        },
        ask: {
          userSettings: ['Bash'],
        },
      });
      const result = detectUnreachableRules(ctx);
      expect(result).toHaveLength(1);
      expect(result[0].shadowType).toBe('deny');
    });

    it('should not flag tool-wide allow rules (no content)', () => {
      const ctx = makeRules({
        allow: {
          localSettings: ['Bash'],
        },
        deny: {
          projectSettings: ['Bash'],
        },
      });
      const result = detectUnreachableRules(ctx);
      expect(result).toHaveLength(0);
    });

    it('should not flag when deny is for different tool', () => {
      const ctx = makeRules({
        allow: {
          localSettings: ['Bash(git:*)'],
        },
        deny: {
          projectSettings: ['Edit'],
        },
      });
      const result = detectUnreachableRules(ctx);
      expect(result).toHaveLength(0);
    });

    it('should flag shell ask rules from personal settings', () => {
      const ctx = makeRules({
        allow: {
          localSettings: ['Bash(git:*)'],
        },
        ask: {
          userSettings: ['Bash'],
        },
      });
      const result = detectUnreachableRules(ctx);
      expect(result).toHaveLength(1);
    });

    it('should flag shell ask rules from shared settings', () => {
      const ctx = makeRules({
        allow: {
          localSettings: ['Bash(git:*)'],
        },
        ask: {
          projectSettings: ['Bash'],
        },
      });
      const result = detectUnreachableRules(ctx);
      expect(result).toHaveLength(1);
      expect(result[0].shadowType).toBe('ask');
    });

    it('should include fix suggestions', () => {
      const ctx = makeRules({
        allow: {
          localSettings: ['Bash(git:*)'],
        },
        deny: {
          projectSettings: ['Bash'],
        },
      });
      const result = detectUnreachableRules(ctx);
      expect(result[0].fix).toContain('deny rule');
      expect(result[0].fix).toContain('project settings');
    });
  });
});
