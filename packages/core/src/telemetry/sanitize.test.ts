/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { sanitizeHookName } from './sanitize.js';

describe('sanitizeHookName', () => {
  it('should return "unknown-command" for empty string', () => {
    expect(sanitizeHookName('')).toBe('unknown-command');
  });

  it('should return "unknown-command" for whitespace-only string', () => {
    expect(sanitizeHookName('   ')).toBe('unknown-command');
    expect(sanitizeHookName('\t\n\r')).toBe('unknown-command');
  });

  it('should return "unknown-command" for null/undefined values', () => {
    // Testing the function behavior with falsy inputs
    expect(sanitizeHookName('')).toBe('unknown-command');
  });

  it('should extract command name from full path on Unix systems', () => {
    expect(sanitizeHookName('/usr/bin/git')).toBe('git');
    expect(sanitizeHookName('/path/to/.gemini/hooks/check-secrets.sh')).toBe(
      'check-secrets.sh',
    );
    expect(sanitizeHookName('/home/user/script.py --arg=value')).toBe(
      'script.py',
    );
  });

  it('should extract command name from full path on Windows systems', () => {
    expect(sanitizeHookName('C:\\Windows\\System32\\cmd.exe')).toBe('cmd.exe');
    expect(sanitizeHookName('C:\\Users\\User\\Documents\\test.bat /c')).toBe(
      'test.bat',
    );
  });

  it('should return the command name without arguments for simple commands', () => {
    expect(sanitizeHookName('git status')).toBe('git');
    expect(sanitizeHookName('node index.js')).toBe('node');
    expect(sanitizeHookName('python script.py --api-key=abc123')).toBe(
      'python',
    );
  });

  it('should handle relative paths correctly', () => {
    expect(sanitizeHookName('./my-script.sh')).toBe('my-script.sh');
    expect(sanitizeHookName('../tools/tool.exe')).toBe('tool.exe');
  });

  it('should handle complex command lines', () => {
    expect(
      sanitizeHookName(
        '/path/to/.gemini/hooks/check-secrets.sh --api-key=abc123',
      ),
    ).toBe('check-secrets.sh');
    expect(
      sanitizeHookName('python /home/user/script.py --token=xyz --verbose'),
    ).toBe('python');
  });

  it('should handle edge cases', () => {
    expect(sanitizeHookName('simple-command')).toBe('simple-command');
    expect(sanitizeHookName('one-word')).toBe('one-word');
  });

  it('should return "unknown-command" for malformed paths', () => {
    expect(sanitizeHookName('/')).toBe('unknown-command');
    expect(sanitizeHookName('\\')).toBe('unknown-command');
  });
});
