/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  interpolateEnvVars,
  interpolateHeaders,
  interpolateUrl,
  hasEnvVarReferences,
  extractEnvVarNames,
} from './envInterpolator.js';

describe('envInterpolator', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    process.env['MY_TOKEN'] = 'secret-token';
    process.env['API_KEY'] = 'api-key-123';
    process.env['EMPTY_VAR'] = '';
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('interpolateEnvVars', () => {
    it('should replace allowed environment variables with $VAR syntax', () => {
      const result = interpolateEnvVars('Bearer $MY_TOKEN', ['MY_TOKEN']);
      expect(result).toBe('Bearer secret-token');
    });

    it('should replace allowed environment variables with ${VAR} syntax', () => {
      const result = interpolateEnvVars('Bearer ${MY_TOKEN}', ['MY_TOKEN']);
      expect(result).toBe('Bearer secret-token');
    });

    it('should replace variables not in whitelist with empty string', () => {
      const result = interpolateEnvVars('Bearer $OTHER_VAR', ['MY_TOKEN']);
      expect(result).toBe('Bearer ');
    });

    it('should handle multiple variables', () => {
      const result = interpolateEnvVars('$MY_TOKEN:$API_KEY', [
        'MY_TOKEN',
        'API_KEY',
      ]);
      expect(result).toBe('secret-token:api-key-123');
    });

    it('should handle mixed allowed and disallowed variables', () => {
      const result = interpolateEnvVars('$MY_TOKEN:$OTHER_VAR', ['MY_TOKEN']);
      expect(result).toBe('secret-token:');
    });

    it('should handle undefined environment variables', () => {
      const result = interpolateEnvVars('$UNDEFINED_VAR', ['UNDEFINED_VAR']);
      expect(result).toBe('');
    });

    it('should handle empty whitelist', () => {
      const result = interpolateEnvVars('$MY_TOKEN', []);
      expect(result).toBe('');
    });

    it('should not replace text without $ prefix', () => {
      const result = interpolateEnvVars('MY_TOKEN', ['MY_TOKEN']);
      expect(result).toBe('MY_TOKEN');
    });
  });

  describe('interpolateHeaders', () => {
    it('should interpolate all header values', () => {
      const headers = {
        Authorization: 'Bearer $MY_TOKEN',
        'X-API-Key': '$API_KEY',
        'Content-Type': 'application/json',
      };
      const result = interpolateHeaders(headers, ['MY_TOKEN', 'API_KEY']);
      expect(result).toEqual({
        Authorization: 'Bearer secret-token',
        'X-API-Key': 'api-key-123',
        'Content-Type': 'application/json',
      });
    });

    it('should handle empty headers', () => {
      const result = interpolateHeaders({}, ['MY_TOKEN']);
      expect(result).toEqual({});
    });
  });

  describe('interpolateUrl', () => {
    it('should interpolate URL with environment variables', () => {
      process.env['API_HOST'] = 'api.example.com';
      const result = interpolateUrl('https://$API_HOST/v1/hook', ['API_HOST']);
      expect(result).toBe('https://api.example.com/v1/hook');
    });
  });

  describe('hasEnvVarReferences', () => {
    it('should return true for $VAR syntax', () => {
      expect(hasEnvVarReferences('$MY_TOKEN')).toBe(true);
    });

    it('should return true for ${VAR} syntax', () => {
      expect(hasEnvVarReferences('${MY_TOKEN}')).toBe(true);
    });

    it('should return false for plain text', () => {
      expect(hasEnvVarReferences('plain text')).toBe(false);
    });

    it('should return false for empty string', () => {
      expect(hasEnvVarReferences('')).toBe(false);
    });
  });

  describe('extractEnvVarNames', () => {
    it('should extract single variable name', () => {
      expect(extractEnvVarNames('$MY_TOKEN')).toEqual(['MY_TOKEN']);
    });

    it('should extract multiple variable names', () => {
      expect(extractEnvVarNames('$MY_TOKEN:$API_KEY')).toEqual([
        'MY_TOKEN',
        'API_KEY',
      ]);
    });

    it('should extract from ${VAR} syntax', () => {
      expect(extractEnvVarNames('${MY_TOKEN}')).toEqual(['MY_TOKEN']);
    });

    it('should not duplicate variable names', () => {
      expect(extractEnvVarNames('$MY_TOKEN:$MY_TOKEN')).toEqual(['MY_TOKEN']);
    });

    it('should return empty array for no variables', () => {
      expect(extractEnvVarNames('plain text')).toEqual([]);
    });
  });
});
