/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { V4ToV5Migration } from './v4-to-v5.js';

describe('V4ToV5Migration', () => {
  const migration = new V4ToV5Migration();

  describe('shouldMigrate', () => {
    it('returns true for V4 settings with array modelProviders', () => {
      expect(
        migration.shouldMigrate({
          $version: 4,
          modelProviders: {
            openai: [{ id: 'gpt-4o' }],
          },
        }),
      ).toBe(true);
    });

    it('returns false for V5 settings', () => {
      expect(
        migration.shouldMigrate({
          $version: 5,
          modelProviders: {
            openai: { protocol: 'openai', models: [{ id: 'gpt-4o' }] },
          },
        }),
      ).toBe(false);
    });

    it('returns true for V4 settings without modelProviders', () => {
      expect(migration.shouldMigrate({ $version: 4 })).toBe(true);
    });

    it('returns true for V4 settings with already-object modelProviders', () => {
      expect(
        migration.shouldMigrate({
          $version: 4,
          modelProviders: {
            openai: { protocol: 'openai', models: [{ id: 'gpt-4o' }] },
          },
        }),
      ).toBe(true);
    });

    it('returns false for non-object input', () => {
      expect(migration.shouldMigrate(null)).toBe(false);
      expect(migration.shouldMigrate('x')).toBe(false);
      expect(migration.shouldMigrate(42)).toBe(false);
    });

    it('returns true for versionless settings with array modelProviders', () => {
      expect(
        migration.shouldMigrate({
          modelProviders: {
            openai: [{ id: 'gpt-4o' }],
          },
        }),
      ).toBe(true);
    });

    it('returns false for versionless settings without modelProviders', () => {
      expect(migration.shouldMigrate({})).toBe(false);
    });
  });

  describe('migrate', () => {
    it('wraps openai array with correct protocol', () => {
      const input = {
        $version: 4,
        modelProviders: {
          openai: [{ id: 'gpt-4o', name: 'GPT-4o' }],
        },
      };
      const { settings, warnings } = migration.migrate(input, 'user') as {
        settings: Record<string, unknown>;
        warnings: string[];
      };

      expect(settings['modelProviders']).toEqual({
        openai: {
          protocol: 'openai',
          models: [{ id: 'gpt-4o', name: 'GPT-4o' }],
        },
      });
      expect(settings['$version']).toBe(5);
      expect(warnings).toEqual([]);
    });

    it('bumps V4 settings without modelProviders to V5', () => {
      const { settings, warnings } = migration.migrate(
        { $version: 4, custom: true },
        'user',
      ) as {
        settings: Record<string, unknown>;
        warnings: string[];
      };

      expect(settings).toEqual({ $version: 5, custom: true });
      expect(warnings).toEqual([]);
    });

    it.each([
      ['openai', 'openai'],
      ['qwen-oauth', 'qwen-oauth'],
      ['gemini', 'gemini'],
      ['vertex-ai', 'gemini'],
      ['anthropic', 'anthropic'],
    ])('maps key %s to protocol %s', (key, expectedProtocol) => {
      const input = {
        $version: 4,
        modelProviders: {
          [key]: [{ id: 'test-model' }],
        },
      };
      const { settings } = migration.migrate(input, 'user') as {
        settings: Record<string, unknown>;
      };
      const providers = settings['modelProviders'] as Record<string, unknown>;
      expect(providers[key]).toEqual({
        protocol: expectedProtocol,
        models: [{ id: 'test-model' }],
      });
    });

    it('skips already-object entries (non-array)', () => {
      const input = {
        $version: 4,
        modelProviders: {
          openai: { protocol: 'openai', models: [{ id: 'gpt-4o' }] },
          gemini: [{ id: 'gemini-pro' }],
        },
      };
      const { settings, warnings } = migration.migrate(input, 'user') as {
        settings: Record<string, unknown>;
        warnings: string[];
      };

      const providers = settings['modelProviders'] as Record<string, unknown>;
      expect(providers['openai']).toEqual({
        protocol: 'openai',
        models: [{ id: 'gpt-4o' }],
      });
      expect(providers['gemini']).toEqual({
        protocol: 'gemini',
        models: [{ id: 'gemini-pro' }],
      });
      expect(warnings).toEqual([]);
    });

    it('preserves non-modelProviders fields', () => {
      const input = {
        $version: 4,
        model: { name: 'gpt-4o' },
        security: { auth: { selectedType: 'openai' } },
        env: { OPENAI_API_KEY: 'sk-test' },
        modelProviders: {
          openai: [{ id: 'gpt-4o' }],
        },
      };
      const { settings } = migration.migrate(input, 'user') as {
        settings: Record<string, unknown>;
      };

      expect(settings['model']).toEqual({ name: 'gpt-4o' });
      expect(settings['security']).toEqual({
        auth: { selectedType: 'openai' },
      });
      expect(settings['env']).toEqual({ OPENAI_API_KEY: 'sk-test' });
    });

    it('does not mutate the input settings object', () => {
      const input = {
        $version: 4,
        modelProviders: {
          openai: [{ id: 'gpt-4o' }],
        },
      };
      migration.migrate(input, 'user');

      expect(input.modelProviders['openai']).toEqual([{ id: 'gpt-4o' }]);
    });

    it('throws for non-object input', () => {
      expect(() => migration.migrate(null, 'user')).toThrow();
      expect(() => migration.migrate('string', 'user')).toThrow();
    });

    it('handles empty modelProviders object', () => {
      const input = { $version: 4, modelProviders: {} };
      const { settings, warnings } = migration.migrate(input, 'user') as {
        settings: Record<string, unknown>;
        warnings: string[];
      };

      expect(settings['modelProviders']).toEqual({});
      expect(settings['$version']).toBe(5);
      expect(warnings).toEqual([]);
    });

    it('converts multiple providers in one pass', () => {
      const input = {
        $version: 4,
        modelProviders: {
          openai: [{ id: 'gpt-4o' }],
          gemini: [{ id: 'gemini-pro' }],
          anthropic: [{ id: 'claude-3' }],
        },
      };
      const { settings, warnings } = migration.migrate(input, 'user') as {
        settings: Record<string, unknown>;
        warnings: string[];
      };

      const providers = settings['modelProviders'] as Record<
        string,
        { protocol: string; models: unknown[] }
      >;
      expect(Object.keys(providers)).toHaveLength(3);
      expect(providers['openai'].protocol).toBe('openai');
      expect(providers['gemini'].protocol).toBe('gemini');
      expect(providers['anthropic'].protocol).toBe('anthropic');
      expect(warnings).toEqual([]);
    });
  });
});
