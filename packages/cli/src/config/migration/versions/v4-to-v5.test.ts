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
    it('returns true for V4 settings', () => {
      expect(
        migration.shouldMigrate({
          $version: 4,
          model: { name: 'glm-5' },
        }),
      ).toBe(true);
    });

    it('returns true for V4 settings without model', () => {
      expect(migration.shouldMigrate({ $version: 4 })).toBe(true);
    });

    it('returns false for V5 settings', () => {
      expect(
        migration.shouldMigrate({
          $version: 5,
          model: { id: 'glm-5', name: 'GLM-5' },
        }),
      ).toBe(false);
    });

    it('returns false for non-object input', () => {
      expect(migration.shouldMigrate(null)).toBe(false);
      expect(migration.shouldMigrate('x')).toBe(false);
      expect(migration.shouldMigrate(42)).toBe(false);
    });

    it('returns true for versionless settings with model.name but no model.id', () => {
      expect(
        migration.shouldMigrate({
          model: { name: 'glm-5' },
        }),
      ).toBe(true);
    });

    it('returns false for versionless settings without model.name', () => {
      expect(migration.shouldMigrate({ model: {} })).toBe(false);
      expect(migration.shouldMigrate({})).toBe(false);
    });

    it('returns false for versionless settings with both model.name and model.id', () => {
      expect(
        migration.shouldMigrate({
          model: { name: 'GLM-5', id: 'glm-5' },
        }),
      ).toBe(false);
    });
  });

  describe('migrate', () => {
    it('copies model.name to model.id', () => {
      const input = { $version: 4, model: { name: 'glm-5' } };
      const { settings, warnings } = migration.migrate(input, 'user') as {
        settings: Record<string, unknown>;
        warnings: string[];
      };

      const model = settings['model'] as Record<string, unknown>;
      expect(model['id']).toBe('glm-5');
      expect(settings['$version']).toBe(5);
      expect(warnings).toEqual([]);
    });

    it('copies security.auth.baseUrl to model.baseUrl', () => {
      const input = {
        $version: 4,
        model: { name: 'glm-5' },
        security: { auth: { baseUrl: 'https://api.example.com' } },
      };
      const { settings } = migration.migrate(input, 'user') as {
        settings: Record<string, unknown>;
        warnings: string[];
      };

      const model = settings['model'] as Record<string, unknown>;
      expect(model['baseUrl']).toBe('https://api.example.com');
    });

    it('copies security.auth.selectedType to model.provider', () => {
      const input = {
        $version: 4,
        model: { name: 'glm-5' },
        security: { auth: { selectedType: 'openai' } },
      };
      const { settings } = migration.migrate(input, 'user') as {
        settings: Record<string, unknown>;
        warnings: string[];
      };

      const model = settings['model'] as Record<string, unknown>;
      expect(model['provider']).toBe('openai');
    });

    it('copies all fields together', () => {
      const input = {
        $version: 4,
        model: { name: 'glm-5' },
        security: {
          auth: {
            baseUrl: 'https://api.example.com',
            selectedType: 'openai',
          },
        },
      };
      const { settings, warnings } = migration.migrate(input, 'user') as {
        settings: Record<string, unknown>;
        warnings: string[];
      };

      const model = settings['model'] as Record<string, unknown>;
      expect(model['id']).toBe('glm-5');
      expect(model['baseUrl']).toBe('https://api.example.com');
      expect(model['provider']).toBe('openai');
      expect(settings['$version']).toBe(5);
      expect(warnings).toEqual([]);
    });

    it('bumps version when model.name is absent', () => {
      const input = { $version: 4 };
      const { settings, warnings } = migration.migrate(input, 'user') as {
        settings: Record<string, unknown>;
        warnings: string[];
      };

      expect(settings['$version']).toBe(5);
      expect(warnings).toEqual([]);
    });

    it('does not overwrite existing model.id', () => {
      const input = {
        $version: 4,
        model: { name: 'glm-5', id: 'existing-id' },
      };
      const { settings } = migration.migrate(input, 'user') as {
        settings: Record<string, unknown>;
        warnings: string[];
      };

      const model = settings['model'] as Record<string, unknown>;
      expect(model['id']).toBe('glm-5');
    });

    it('does not mutate the input settings object', () => {
      const input = {
        $version: 4,
        model: { name: 'glm-5' },
        security: { auth: { baseUrl: 'https://api.example.com' } },
      };
      migration.migrate(input, 'user');

      expect(input).toEqual({
        $version: 4,
        model: { name: 'glm-5' },
        security: { auth: { baseUrl: 'https://api.example.com' } },
      });
    });

    it('throws for non-object input', () => {
      expect(() => migration.migrate(null, 'user')).toThrow();
      expect(() => migration.migrate('string', 'user')).toThrow();
    });
  });
});
