/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  sanitizeErrorMessage,
  sanitizeToolArgs,
  sanitizeThoughtContent,
} from './agent-sanitization-utils.js';

describe('agent-sanitization-utils', () => {
  describe('sanitizeErrorMessage', () => {
    it('should redact standard inline PEM content', () => {
      const input =
        'Here is my key: -----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA12345\n-----END RSA PRIVATE KEY----- do not share.';
      const expected = 'Here is my key: [REDACTED_PEM] do not share.';
      expect(sanitizeErrorMessage(input)).toBe(expected);
    });

    it('should redact non-standard inline PEM content (with punctuation)', () => {
      const input =
        '-----BEGIN X.509 CERTIFICATE-----\nMIIEowIBAAKCAQEA12345\n-----END X.509 CERTIFICATE-----';
      const expected = '[REDACTED_PEM]';
      expect(sanitizeErrorMessage(input)).toBe(expected);
    });

    it('should not hang on ReDoS attack string for PEM redaction', () => {
      const start = Date.now();
      // A string that starts with -----BEGIN but has no ending, with many spaces
      // In the vulnerable regex, this would cause catastrophic backtracking.
      const maliciousInput = '-----BEGIN ' + ' '.repeat(50000) + 'A';
      const result = sanitizeErrorMessage(maliciousInput);
      const duration = Date.now() - start;

      // Should process very quickly (e.g. < 50ms)
      expect(duration).toBeLessThan(50);

      // Since it doesn't match the full PEM block pattern, it should return the input unaltered
      expect(result).toBe(maliciousInput);
    });

    it('should redact key-value pairs with sensitive keys', () => {
      const input = 'Error: connection failed. --api-key="secret123"';
      const result = sanitizeErrorMessage(input);
      expect(result).toContain('[REDACTED]');
      expect(result).not.toContain('secret123');
    });

    it('should redact space-separated sensitive keywords', () => {
      // The keyword regex requires tokens to be 8+ chars
      const input = 'Using password mySuperSecretPassword123';
      const result = sanitizeErrorMessage(input);
      expect(result).toContain('[REDACTED]');
      expect(result).not.toContain('mySuperSecretPassword123');
    });

    it('should preserve non-sensitive ids while redacting sensitive key values', () => {
      const input =
        'session_id=session-123 client_id=client-456 client_secret=secret-789 session_token=token-12345678';
      const result = sanitizeErrorMessage(input);

      expect(result).toContain('session_id=session-123');
      expect(result).toContain('client_id=client-456');
      expect(result).not.toContain('secret-789');
      expect(result).not.toContain('token-12345678');
      expect(result).toBe(
        'session_id=session-123 client_id=client-456 client_secret=[REDACTED] session_token=[REDACTED]',
      );
    });
  });

  describe('sanitizeToolArgs', () => {
    it('should redact sensitive fields in an object', () => {
      const input = {
        username: 'admin',
        password: 'superSecretPassword',
        nested: {
          api_key: 'abc123xyz',
          normal_field: 'hello',
        },
      };

      const result = sanitizeToolArgs(input);

      expect(result).toEqual({
        username: 'admin',
        password: '[REDACTED]',
        nested: {
          api_key: '[REDACTED]',
          normal_field: 'hello',
        },
      });
    });

    it('should handle arrays and strings correctly', () => {
      const input = ['normal string', '--api-key="secret123"'];
      const result = sanitizeToolArgs(input) as string[];

      expect(result[0]).toBe('normal string');
      expect(result[1]).toContain('[REDACTED]');
      expect(result[1]).not.toContain('secret123');
    });

    it('should preserve non-sensitive ids while redacting sensitive fields', () => {
      const input = {
        session_id: 'session-123',
        client_id: 'client-456',
        session_token: 'token-123',
        client_secret: 'secret-789',
        password: 'password-abc',
        api_key: 'api-key-def',
      };

      const result = sanitizeToolArgs(input);

      expect(result).toEqual({
        session_id: 'session-123',
        client_id: 'client-456',
        session_token: '[REDACTED]',
        client_secret: '[REDACTED]',
        password: '[REDACTED]',
        api_key: '[REDACTED]',
      });
    });
  });

  describe('sanitizeThoughtContent', () => {
    it('should redact sensitive patterns from thought content', () => {
      const input = 'I will now authenticate using token 1234567890abcdef.';
      const result = sanitizeThoughtContent(input);

      expect(result).toContain('[REDACTED]');
      expect(result).not.toContain('1234567890abcdef');
    });
  });
});
