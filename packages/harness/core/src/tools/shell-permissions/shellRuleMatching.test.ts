/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  permissionRuleExtractPrefix,
  hasWildcards,
  parsePermissionRule,
  matchWildcardPattern,
  suggestionForExactCommand,
  suggestionForPrefix,
} from './shellRuleMatching.js';

describe('shellRuleMatching', () => {
  // ========================================================================
  // permissionRuleExtractPrefix
  // ========================================================================

  describe('permissionRuleExtractPrefix', () => {
    it('should extract prefix from legacy :* syntax', () => {
      expect(permissionRuleExtractPrefix('npm:*')).toBe('npm');
    });

    it('should extract multi-word prefix', () => {
      expect(permissionRuleExtractPrefix('npm run:*')).toBe('npm run');
    });

    it('should return null for exact commands', () => {
      expect(permissionRuleExtractPrefix('npm install')).toBeNull();
    });

    it('should return null for wildcard patterns', () => {
      expect(permissionRuleExtractPrefix('npm * --save')).toBeNull();
    });

    it('should return null for empty string', () => {
      expect(permissionRuleExtractPrefix('')).toBeNull();
    });
  });

  // ========================================================================
  // hasWildcards
  // ========================================================================

  describe('hasWildcards', () => {
    it('should return true for patterns with unescaped *', () => {
      expect(hasWildcards('npm * --save')).toBe(true);
    });

    it('should return true for patterns with * at start', () => {
      expect(hasWildcards('* run test')).toBe(true);
    });

    it('should return false for legacy :* syntax', () => {
      expect(hasWildcards('npm:*')).toBe(false);
    });

    it('should return false for escaped \\*', () => {
      expect(hasWildcards('npm \\* --save')).toBe(false);
    });

    it('should return true for \\\\* (escaped backslash before unescaped *)', () => {
      expect(hasWildcards('npm \\\\* --save')).toBe(true);
    });

    it('should return false for plain commands', () => {
      expect(hasWildcards('npm install')).toBe(false);
    });

    it('should return false for empty string', () => {
      expect(hasWildcards('')).toBe(false);
    });
  });

  // ========================================================================
  // parsePermissionRule
  // ========================================================================

  describe('parsePermissionRule', () => {
    it('should parse exact match rule', () => {
      const result = parsePermissionRule('npm install');
      expect(result).toEqual({ type: 'exact', command: 'npm install' });
    });

    it('should parse prefix rule (legacy :* syntax)', () => {
      const result = parsePermissionRule('git:*');
      expect(result).toEqual({ type: 'prefix', prefix: 'git' });
    });

    it('should parse wildcard rule', () => {
      const result = parsePermissionRule('npm * --save');
      expect(result).toEqual({ type: 'wildcard', pattern: 'npm * --save' });
    });

    it('should prioritize prefix over wildcard for :* at end', () => {
      const result = parsePermissionRule('npm:*');
      expect(result.type).toBe('prefix');
    });

    it('should handle escaped stars as exact match', () => {
      const result = parsePermissionRule('echo \\*');
      expect(result.type).toBe('exact');
    });
  });

  // ========================================================================
  // matchWildcardPattern
  // ========================================================================

  describe('matchWildcardPattern', () => {
    it('should match simple wildcard', () => {
      expect(matchWildcardPattern('npm *', 'npm install')).toBe(true);
    });

    it('should match wildcard in middle', () => {
      expect(matchWildcardPattern('git * --force', 'git push --force')).toBe(
        true,
      );
    });

    it('should match multiple wildcards', () => {
      expect(matchWildcardPattern('* run *', 'npm run test')).toBe(true);
    });

    it('should not match when pattern does not match', () => {
      expect(matchWildcardPattern('npm *', 'yarn install')).toBe(false);
    });

    it('should handle escaped star as literal', () => {
      expect(matchWildcardPattern('echo \\*', 'echo *')).toBe(true);
      expect(matchWildcardPattern('echo \\*', 'echo hello')).toBe(false);
    });

    it('should handle escaped backslash', () => {
      expect(matchWildcardPattern('echo \\\\', 'echo \\')).toBe(true);
    });

    it('should match bare command with trailing wildcard', () => {
      // 'git *' should match bare 'git' (optional trailing args)
      expect(matchWildcardPattern('git *', 'git')).toBe(true);
    });

    it('should not make trailing wildcard optional for multi-wildcard patterns', () => {
      // '* run *' should NOT match 'npm run' (no trailing arg)
      expect(matchWildcardPattern('* run *', 'npm run')).toBe(false);
    });

    it('should be case-sensitive by default', () => {
      expect(matchWildcardPattern('npm *', 'NPM install')).toBe(false);
    });

    it('should support case-insensitive matching', () => {
      expect(matchWildcardPattern('npm *', 'NPM install', true)).toBe(true);
    });

    it('should escape regex special characters in pattern', () => {
      expect(matchWildcardPattern('echo "hello"', 'echo "hello"')).toBe(true);
    });

    it('should match wildcard across multiple words', () => {
      expect(
        matchWildcardPattern('docker *', 'docker run -it ubuntu bash'),
      ).toBe(true);
    });

    it('should trim pattern whitespace', () => {
      expect(matchWildcardPattern('  npm *  ', 'npm install')).toBe(true);
    });
  });

  // ========================================================================
  // Suggestion Generators
  // ========================================================================

  describe('suggestionForExactCommand', () => {
    it('should generate correct permission update', () => {
      const result = suggestionForExactCommand('Bash', 'npm install');
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        type: 'addRules',
        rules: [
          {
            toolName: 'Bash',
            ruleContent: 'npm install',
          },
        ],
        behavior: 'allow',
        destination: 'localSettings',
      });
    });
  });

  describe('suggestionForPrefix', () => {
    it('should generate correct permission update with :* suffix', () => {
      const result = suggestionForPrefix('Bash', 'git');
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        type: 'addRules',
        rules: [
          {
            toolName: 'Bash',
            ruleContent: 'git:*',
          },
        ],
        behavior: 'allow',
        destination: 'localSettings',
      });
    });
  });
});
