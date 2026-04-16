/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  substituteArguments,
  validatePromptHookResponse,
} from './hookHelpers.js';

describe('substituteArguments', () => {
  describe('$ARGUMENTS placeholder', () => {
    it('should replace $ARGUMENTS with full JSON input', () => {
      const content = 'Evaluate this: $ARGUMENTS';
      const args = JSON.stringify({ tool_name: 'bash', command: 'ls' });
      const result = substituteArguments(content, args);
      expect(result).toContain('tool_name');
      expect(result).toContain('bash');
    });

    it('should handle multiple $ARGUMENTS occurrences', () => {
      const content = 'First: $ARGUMENTS\nSecond: $ARGUMENTS';
      const args = 'test-value';
      const result = substituteArguments(content, args);
      expect(result).toBe('First: test-value\nSecond: test-value');
    });

    it('should handle undefined args', () => {
      const content = 'Evaluate this: $ARGUMENTS';
      const result = substituteArguments(content, undefined);
      expect(result).toBe('Evaluate this: ');
    });

    it('should handle empty args', () => {
      const content = 'Evaluate: $ARGUMENTS';
      const result = substituteArguments(content, '');
      expect(result).toBe('Evaluate: ');
    });
  });

  describe('appendIfNoPlaceholder behavior', () => {
    it('should append args when no placeholder found and appendIfNoPlaceholder=true', () => {
      const content = 'Evaluate the following';
      const args = JSON.stringify({ tool_name: 'bash' });
      const result = substituteArguments(content, args, true);
      expect(result).toContain('Arguments:');
      expect(result).toContain('tool_name');
    });

    it('should not append args when appendIfNoPlaceholder=false', () => {
      const content = 'Evaluate the following';
      const args = JSON.stringify({ tool_name: 'bash' });
      const result = substituteArguments(content, args, false);
      expect(result).toBe('Evaluate the following');
    });

    it('should not append when placeholder exists', () => {
      const content = 'Evaluate: $ARGUMENTS';
      const args = JSON.stringify({ tool_name: 'bash' });
      const result = substituteArguments(content, args, true);
      expect(result).not.toContain('Arguments:');
      expect(result).toContain('tool_name');
    });
  });

  describe('edge cases', () => {
    it('should handle empty content', () => {
      const result = substituteArguments('', 'test');
      expect(result).toBe('test');
    });

    it('should handle special characters in JSON', () => {
      const args = JSON.stringify({ command: 'echo "hello\\nworld"' });
      const content = 'Command: $ARGUMENTS';
      const result = substituteArguments(content, args);
      // Check that the JSON is properly included
      expect(result).toContain('"command"');
      expect(result).toContain('hello');
      expect(result).toContain('world');
    });

    it('should handle large JSON', () => {
      const largeObj = { data: 'x'.repeat(10000) };
      const args = JSON.stringify(largeObj);
      const content = '$ARGUMENTS';
      const result = substituteArguments(content, args);
      expect(result.length).toBeGreaterThan(10000);
    });
  });
});

describe('validatePromptHookResponse', () => {
  describe('valid responses', () => {
    it('should accept { ok: true }', () => {
      const response = { ok: true };
      const result = validatePromptHookResponse(response);
      expect(result.ok).toBe(true);
      expect(result.reason).toBeUndefined();
    });

    it('should accept { ok: false, reason: "..." }', () => {
      const response = { ok: false, reason: 'Dangerous command' };
      const result = validatePromptHookResponse(response);
      expect(result.ok).toBe(false);
      expect(result.reason).toBe('Dangerous command');
    });
  });

  describe('invalid responses', () => {
    it('should throw error when ok is not boolean', () => {
      const response = { ok: 'true' };
      expect(() => validatePromptHookResponse(response)).toThrow(
        "'ok' must be a boolean",
      );
    });

    it('should throw error when ok is missing', () => {
      const response = { reason: 'test' };
      expect(() => validatePromptHookResponse(response)).toThrow(
        "'ok' must be a boolean",
      );
    });

    it('should throw error when reason is not string', () => {
      const response = { ok: false, reason: 123 };
      expect(() => validatePromptHookResponse(response)).toThrow(
        "'reason' must be a string",
      );
    });

    it('should throw error when response has extra fields', () => {
      const response = { ok: true, extra: 'field', another: 123 };
      expect(() => validatePromptHookResponse(response)).toThrow(
        'unexpected keys',
      );
    });
  });
});
