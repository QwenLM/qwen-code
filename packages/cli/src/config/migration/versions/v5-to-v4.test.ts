/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { V5ToV4Migration } from './v5-to-v4.js';

describe('V5ToV4Migration', () => {
  const migration = new V5ToV4Migration();

  it('declares a v5 -> v4 transition', () => {
    expect(migration.fromVersion).toBe(5);
    expect(migration.toVersion).toBe(4);
  });

  describe('shouldMigrate', () => {
    it('returns true for V5 settings with object modelProviders', () => {
      expect(
        migration.shouldMigrate({
          $version: 5,
          modelProviders: {
            openai: { protocol: 'openai', models: [{ id: 'gpt-4o' }] },
          },
        }),
      ).toBe(true);
    });

    it('returns true for V5 settings without modelProviders', () => {
      expect(migration.shouldMigrate({ $version: 5 })).toBe(true);
    });

    it('returns false for V4 settings', () => {
      expect(
        migration.shouldMigrate({
          $version: 4,
          modelProviders: { openai: [{ id: 'gpt-4o' }] },
        }),
      ).toBe(false);
    });

    it('returns false for an unknown newer version', () => {
      expect(migration.shouldMigrate({ $version: 6 })).toBe(false);
    });

    it('returns false for non-object input', () => {
      expect(migration.shouldMigrate(null)).toBe(false);
      expect(migration.shouldMigrate('x')).toBe(false);
      expect(migration.shouldMigrate(42)).toBe(false);
    });

    it('returns true for versionless settings with object modelProviders', () => {
      expect(
        migration.shouldMigrate({
          modelProviders: {
            openai: { protocol: 'openai', models: [{ id: 'gpt-4o' }] },
          },
        }),
      ).toBe(true);
    });

    it('returns false for versionless settings with array modelProviders', () => {
      expect(
        migration.shouldMigrate({
          modelProviders: { openai: [{ id: 'gpt-4o' }] },
        }),
      ).toBe(false);
    });

    it('returns false for versionless settings without modelProviders', () => {
      expect(migration.shouldMigrate({})).toBe(false);
    });
  });

  describe('migrate', () => {
    it('unwraps the ProviderConfig object back to a models array', () => {
      const input = {
        $version: 5,
        modelProviders: {
          openai: {
            protocol: 'openai',
            models: [{ id: 'gpt-4o', name: 'GPT-4o' }],
          },
        },
      };
      const { settings, warnings } = migration.migrate(input, 'user') as {
        settings: Record<string, unknown>;
        warnings: string[];
      };

      expect(settings['$version']).toBe(4);
      expect(settings['modelProviders']).toEqual({
        openai: [{ id: 'gpt-4o', name: 'GPT-4o' }],
      });
      expect(warnings).toEqual([]);
    });

    it('unwraps multiple providers and drops the protocol field', () => {
      const input = {
        $version: 5,
        modelProviders: {
          openai: { protocol: 'openai', models: [{ id: 'gpt-4o' }] },
          'vertex-ai': { protocol: 'gemini', models: [{ id: 'gemini-pro' }] },
          anthropic: { protocol: 'anthropic', models: [{ id: 'claude-3' }] },
        },
      };
      const { settings, warnings } = migration.migrate(input, 'user') as {
        settings: Record<string, unknown>;
        warnings: string[];
      };

      expect(settings['modelProviders']).toEqual({
        openai: [{ id: 'gpt-4o' }],
        'vertex-ai': [{ id: 'gemini-pro' }],
        anthropic: [{ id: 'claude-3' }],
      });
      // vertex-ai -> gemini is the key-derived protocol, so no warning.
      expect(warnings).toEqual([]);
    });

    it('warns when an explicit protocol differs from the key-derived one', () => {
      const input = {
        $version: 5,
        modelProviders: {
          openai: { protocol: 'anthropic', models: [{ id: 'weird' }] },
        },
      };
      const { settings, warnings } = migration.migrate(input, 'user') as {
        settings: Record<string, unknown>;
        warnings: string[];
      };

      expect(settings['modelProviders']).toEqual({ openai: [{ id: 'weird' }] });
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('openai');
      expect(warnings[0]).toContain('anthropic');
    });

    it('treats a wrapped config with missing models as an empty array', () => {
      const input = {
        $version: 5,
        modelProviders: {
          openai: { protocol: 'openai' },
        },
      };
      const { settings } = migration.migrate(input, 'user') as {
        settings: Record<string, unknown>;
      };
      expect(settings['modelProviders']).toEqual({ openai: [] });
    });

    it('leaves already-array values untouched', () => {
      const input = {
        $version: 5,
        modelProviders: {
          openai: [{ id: 'gpt-4o' }],
        },
      };
      const { settings } = migration.migrate(input, 'user') as {
        settings: Record<string, unknown>;
      };
      expect(settings['modelProviders']).toEqual({
        openai: [{ id: 'gpt-4o' }],
      });
    });

    it('sets $version to 4 even without modelProviders', () => {
      const input = { $version: 5, ui: { theme: 'dark' } };
      const { settings } = migration.migrate(input, 'user') as {
        settings: Record<string, unknown>;
      };
      expect(settings['$version']).toBe(4);
      expect(settings['ui']).toEqual({ theme: 'dark' });
    });

    it('does not mutate the input object', () => {
      const input = {
        $version: 5,
        modelProviders: {
          openai: { protocol: 'openai', models: [{ id: 'gpt-4o' }] },
        },
      };
      const snapshot = structuredClone(input);
      migration.migrate(input, 'user');
      expect(input).toEqual(snapshot);
    });

    it('throws for non-object input', () => {
      expect(() => migration.migrate(null, 'user')).toThrow();
    });
  });
});
