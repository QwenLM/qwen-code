/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { UrlValidator, createUrlValidator } from './urlValidator.js';

describe('UrlValidator', () => {
  describe('isBlocked', () => {
    it('should ALLOW 127.0.0.1 for local dev hooks', () => {
      const validator = new UrlValidator([]);
      expect(validator.isBlocked('http://127.0.0.1:8080/api')).toBe(false);
      expect(validator.isBlocked('http://127.0.0.1/api')).toBe(false);
      expect(validator.isBlocked('http://127.0.0.1:9876/hook')).toBe(false);
    });

    it('should ALLOW localhost for local dev hooks', () => {
      const validator = new UrlValidator([]);
      expect(validator.isBlocked('http://localhost:8080/api')).toBe(false);
      expect(validator.isBlocked('http://localhost:9876/hook')).toBe(false);
    });

    it('should block private IP 192.168.x.x', () => {
      const validator = new UrlValidator([]);
      expect(validator.isBlocked('http://192.168.1.1/api')).toBe(true);
      expect(validator.isBlocked('http://192.168.0.100:8080/api')).toBe(true);
    });

    it('should block private IP 10.x.x.x', () => {
      const validator = new UrlValidator([]);
      expect(validator.isBlocked('http://10.0.0.1/api')).toBe(true);
      expect(validator.isBlocked('http://10.255.255.255/api')).toBe(true);
    });

    it('should block private IP 172.16.x.x - 172.31.x.x', () => {
      const validator = new UrlValidator([]);
      expect(validator.isBlocked('http://172.16.0.1/api')).toBe(true);
      expect(validator.isBlocked('http://172.31.255.255/api')).toBe(true);
    });

    it('should block cloud metadata endpoints', () => {
      const validator = new UrlValidator([]);
      expect(
        validator.isBlocked('http://169.254.169.254/latest/meta-data'),
      ).toBe(true);
      expect(
        validator.isBlocked('http://metadata.google.internal/computeMetadata'),
      ).toBe(true);
    });

    it('should allow public URLs', () => {
      const validator = new UrlValidator([]);
      expect(validator.isBlocked('https://api.example.com/hook')).toBe(false);
      expect(validator.isBlocked('https://webhook.site/test')).toBe(false);
    });

    it('should block invalid URLs', () => {
      const validator = new UrlValidator([]);
      expect(validator.isBlocked('not-a-url')).toBe(true);
      expect(validator.isBlocked('')).toBe(true);
    });
  });

  describe('isAllowed', () => {
    it('should allow all URLs when no patterns configured', () => {
      const validator = new UrlValidator([]);
      expect(validator.isAllowed('https://any.example.com/api')).toBe(true);
    });

    it('should match exact URL pattern', () => {
      const validator = new UrlValidator(['https://api\\.example\\.com/hook']);
      expect(validator.isAllowed('https://api.example.com/hook')).toBe(true);
      expect(validator.isAllowed('https://api.example.com/other')).toBe(false);
    });

    it('should match wildcard pattern', () => {
      const validator = new UrlValidator(['https://api\\.example\\.com/*']);
      expect(validator.isAllowed('https://api.example.com/hook')).toBe(true);
      expect(validator.isAllowed('https://api.example.com/v1/hook')).toBe(true);
      expect(validator.isAllowed('https://other.example.com/hook')).toBe(false);
    });

    it('should match multiple patterns', () => {
      const validator = new UrlValidator([
        'https://api\\.example\\.com/*',
        'https://webhook\\.site/*',
      ]);
      expect(validator.isAllowed('https://api.example.com/hook')).toBe(true);
      expect(validator.isAllowed('https://webhook.site/test')).toBe(true);
      expect(validator.isAllowed('https://other.com/hook')).toBe(false);
    });

    it('should be case insensitive', () => {
      const validator = new UrlValidator(['https://API\\.Example\\.COM/*']);
      expect(validator.isAllowed('https://api.example.com/hook')).toBe(true);
    });
  });

  describe('validate', () => {
    it('should return allowed for valid public URL matching whitelist', () => {
      const validator = new UrlValidator(['https://api\\.example\\.com/*']);
      const result = validator.validate('https://api.example.com/hook');
      expect(result.allowed).toBe(true);
      expect(result.reason).toBeUndefined();
    });

    it('should return not allowed for blocked URL (private IP)', () => {
      const validator = new UrlValidator(['*']);
      const result = validator.validate('http://192.168.1.1:8080/api');
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('SSRF');
    });

    it('should return allowed for localhost/loopback URLs', () => {
      const validator = new UrlValidator(['*']);
      const result1 = validator.validate('http://localhost:8080/api');
      expect(result1.allowed).toBe(true);
      const result2 = validator.validate('http://127.0.0.1:9876/hook');
      expect(result2.allowed).toBe(true);
    });

    it('should return not allowed for URL not matching whitelist', () => {
      const validator = new UrlValidator(['https://api\\.example\\.com/*']);
      const result = validator.validate('https://other.com/hook');
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('does not match');
    });
  });

  describe('createUrlValidator', () => {
    it('should create validator with allowed URLs', () => {
      const validator = createUrlValidator(['https://api\\.example\\.com/*']);
      expect(validator.isAllowed('https://api.example.com/hook')).toBe(true);
    });

    it('should create validator with empty array', () => {
      const validator = createUrlValidator([]);
      expect(validator.isAllowed('https://any.com/hook')).toBe(true);
    });

    it('should create validator with undefined', () => {
      const validator = createUrlValidator(undefined);
      expect(validator.isAllowed('https://any.com/hook')).toBe(true);
    });
  });
});
