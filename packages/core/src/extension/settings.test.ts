/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { parseEnvFile, generateEnvFile, validateSettings } from './settings.js';
import type { ExtensionSetting } from './extensionSettings.js';

describe('Extension Settings', () => {
  describe('parseEnvFile', () => {
    it('should parse simple KEY=VALUE pairs', () => {
      const content = 'API_KEY=abc123\nSERVER_URL=http://example.com';
      const result = parseEnvFile(content);
      expect(result).toEqual({
        API_KEY: 'abc123',
        SERVER_URL: 'http://example.com',
      });
    });

    it('should skip empty lines and comments', () => {
      const content = `
# This is a comment
API_KEY=secret

# Another comment
DEBUG=true
`;
      const result = parseEnvFile(content);
      expect(result).toEqual({
        API_KEY: 'secret',
        DEBUG: 'true',
      });
    });

    it('should handle quoted values', () => {
      const content = `API_KEY="my secret key"\nPATH='/usr/local/bin'`;
      const result = parseEnvFile(content);
      expect(result).toEqual({
        API_KEY: 'my secret key',
        PATH: '/usr/local/bin',
      });
    });

    it('should ignore invalid lines', () => {
      const content = 'VALID=value\nINVALID LINE\nANOTHER=valid';
      const result = parseEnvFile(content);
      expect(result).toEqual({
        VALID: 'value',
        ANOTHER: 'valid',
      });
    });
  });

  describe('generateEnvFile', () => {
    it('should generate properly formatted .env content', () => {
      const settings = {
        API_KEY: 'secret123',
        DEBUG: 'true',
      };
      const result = generateEnvFile(settings);
      expect(result).toContain('API_KEY=secret123');
      expect(result).toContain('DEBUG=true');
      expect(result).toContain('# Extension Settings');
    });

    it('should quote values with spaces', () => {
      const settings = {
        MESSAGE: 'Hello World',
        PATH: '/usr/local/bin',
      };
      const result = generateEnvFile(settings);
      expect(result).toContain('MESSAGE="Hello World"');
      expect(result).toContain('PATH=/usr/local/bin');
    });
  });

  describe('validateSettings', () => {
    it('should pass validation for valid string settings', () => {
      const settingsConfig: ExtensionSetting[] = [
        {
          name: 'API Key',
          description: 'Your API key for the service',
          envVar: 'API_KEY',
        },
      ];
      const settings = { API_KEY: 'my-key' };
      const errors = validateSettings(settings, settingsConfig);
      expect(errors).toHaveLength(0);
    });

    it('should fail validation for non-string values', () => {
      const settingsConfig: ExtensionSetting[] = [
        {
          name: 'API Key',
          description: 'Your API key for the service',
          envVar: 'API_KEY',
        },
      ];
      // In TypeScript, this would be caught at compile time,
      // but at runtime we check the type
      const settings = { API_KEY: 123 as unknown as string };
      const errors = validateSettings(settings, settingsConfig);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain('API Key');
      expect(errors[0]).toContain('string');
    });

    it('should allow undefined/missing settings (all settings are optional)', () => {
      const settingsConfig: ExtensionSetting[] = [
        {
          name: 'Optional Setting',
          description: 'An optional setting',
          envVar: 'OPTIONAL_VAR',
        },
      ];

      const settings = {};
      const errors = validateSettings(settings, settingsConfig);
      expect(errors).toHaveLength(0);
    });

    it('should validate sensitive settings the same way', () => {
      const settingsConfig: ExtensionSetting[] = [
        {
          name: 'Secret Key',
          description: 'Your secret key',
          envVar: 'SECRET_KEY',
          sensitive: true,
        },
      ];

      const validSettings = { SECRET_KEY: 'super-secret' };
      expect(validateSettings(validSettings, settingsConfig)).toHaveLength(0);
    });
  });
});
