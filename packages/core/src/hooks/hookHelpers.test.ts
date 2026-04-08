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
  });

  describe('$ARGUMENTS[N] indexed syntax', () => {
    it('should replace $ARGUMENTS[0] with first extracted field', () => {
      const content = 'Tool: $ARGUMENTS[0]';
      const args = JSON.stringify({ tool_name: 'bash', command: 'ls -la' });
      const result = substituteArguments(content, args);
      expect(result).toBe('Tool: bash');
    });

    it('should replace $ARGUMENTS[1] with second extracted field', () => {
      const content = 'Command: $ARGUMENTS[1]';
      const args = JSON.stringify({ tool_name: 'bash', command: 'ls -la' });
      const result = substituteArguments(content, args);
      expect(result).toBe('Command: ls -la');
    });

    it('should return empty string for out-of-bounds index', () => {
      const content = 'Extra: $ARGUMENTS[99]';
      const args = JSON.stringify({ tool_name: 'bash' });
      const result = substituteArguments(content, args);
      expect(result).toBe('Extra: ');
    });
  });

  describe('$N shorthand syntax', () => {
    it('should replace $0 with first field', () => {
      const content = 'Tool: $0';
      const args = JSON.stringify({ tool_name: 'bash' });
      const result = substituteArguments(content, args);
      expect(result).toBe('Tool: bash');
    });

    it('should replace $1 with second field', () => {
      const content = 'Command: $1';
      const args = JSON.stringify({ tool_name: 'bash', command: 'rm -rf' });
      const result = substituteArguments(content, args);
      expect(result).toBe('Command: rm -rf');
    });

    it('should not match $ARGUMENTS with $N pattern', () => {
      const content = 'Args: $ARGUMENTS';
      const args = 'test';
      const result = substituteArguments(content, args);
      // $ARGUMENTS should be replaced, not treated as $0
      expect(result).toBe('Args: test');
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

  describe('mixed placeholders', () => {
    it('should handle multiple placeholder types in same content', () => {
      const content = 'Tool: $0\nFull: $ARGUMENTS\nCommand: $ARGUMENTS[1]';
      const args = JSON.stringify({
        tool_name: 'bash',
        command: 'ls',
        prompt: 'test',
      });
      const result = substituteArguments(content, args);
      expect(result).toContain('Tool: bash');
      expect(result).toContain('Full:');
      expect(result).toContain('Command: ls');
    });
  });

  describe('shell-like argument parsing', () => {
    it('should parse quoted arguments correctly', () => {
      const content = 'Arg: $0';
      const args = '"hello world" test';
      const result = substituteArguments(content, args);
      expect(result).toBe('Arg: hello world');
    });

    it('should handle single quotes', () => {
      const content = 'Arg: $0';
      const args = "'hello world' test";
      const result = substituteArguments(content, args);
      expect(result).toBe('Arg: hello world');
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
  });

  describe('extra fields', () => {
    it('should warn but accept responses with extra fields', () => {
      const response = { ok: true, extra: 'field', another: 123 };
      // Should not throw, just warn
      const result = validatePromptHookResponse(response);
      expect(result.ok).toBe(true);
    });
  });
});
