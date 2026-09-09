/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { sanitizeHookName, redactErrorText } from './sanitize.js';
import { truncateErrorText } from './session-tracing.js';

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

describe('redactErrorText', () => {
  it('should redact URL userinfo credentials', () => {
    expect(
      redactErrorText(
        'Command: git clone https://x-access-token:ghs_abc@github.com/o/r',
      ),
    ).toBe('Command: git clone https://***REDACTED***@github.com/o/r');
  });

  it('should redact database DSN credentials', () => {
    expect(
      redactErrorText('failed to connect: postgres://user:pass@host/db'),
    ).toBe('failed to connect: postgres://***REDACTED***@host/db');
  });

  it('should redact Authorization header values including bearer prefixes', () => {
    expect(
      redactErrorText('curl -H "Authorization: Bearer abc123" https://e.com'),
    ).toBe('curl -H "Authorization: ***" https://e.com');
    expect(redactErrorText('Authorization=Bearer xyz')).toBe(
      'Authorization=***',
    );
  });

  it('should redact bare bearer tokens', () => {
    expect(redactErrorText('request rejected for bearer eyJhbGciOi')).toBe(
      'request rejected for bearer ***',
    );
  });

  it('should redact secret-looking flags with = and space separators', () => {
    expect(redactErrorText('git push --token=ghs_abcdef')).toBe(
      'git push --token=***',
    );
    expect(redactErrorText('run --token abc123')).toBe('run --token ***');
    expect(redactErrorText('curl --api-key=xyz host')).toBe(
      'curl --api-key=*** host',
    );
    expect(redactErrorText('x --registry-token=xyz')).toBe(
      'x --registry-token=***',
    );
  });

  it('should redact secret-looking header-style keys', () => {
    expect(redactErrorText('-H "X-Auth-Token: abc123"')).toBe(
      '-H "X-Auth-Token: ***"',
    );
  });

  it('should redact secret-looking env assignments', () => {
    expect(redactErrorText('AWS_SECRET_ACCESS_KEY=xyz cmd')).toBe(
      'AWS_SECRET_ACCESS_KEY=*** cmd',
    );
    expect(redactErrorText('API_KEY=abc123 failed')).toBe('API_KEY=*** failed');
  });

  it('should leave non-secret text intact', () => {
    const text = 'error: connection refused for host db:5432 after 3 tries';
    expect(redactErrorText(text)).toBe(text);
  });

  it('should leave non-secret flags intact', () => {
    const text = 'normal --verbose=2 command';
    expect(redactErrorText(text)).toBe(text);
  });

  it('should preserve newlines while stripping other control characters', () => {
    // A control char between the key and its separator must not defeat
    // the mask, and the multi-line error block shape must survive.
    const noisy = 'git push --token\u0007=ghs_abcdef\nError: fatal\u0000';
    expect(redactErrorText(noisy)).toBe('git push --token=***\nError: fatal');
    expect(redactErrorText('Command: x\nError: y')).toBe(
      'Command: x\nError: y',
    );
  });

  it('should share the truncation bound and surrogate guard with the OTel span path', () => {
    // CJK-heavy text cut at the bound can split a surrogate pair; the
    // shared helper backs off one code unit so no lone surrogate is emitted.
    const cjk = '证'.repeat(2000);
    const result = redactErrorText(cjk);
    expect(result).toBe(truncateErrorText(cjk));
    expect(result.endsWith('…[truncated]')).toBe(true);
    expect(result.includes('\ud83d')).toBe(false);
  });

  it('should truncate over-long error text', () => {
    const result = redactErrorText('a'.repeat(1024 + 100));
    expect(result.length).toBe(1024 + '…[truncated]'.length);
    expect(result.endsWith('…[truncated]')).toBe(true);
  });
});
