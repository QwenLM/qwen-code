/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { V3ToV4Migration, TEST_ONLY } from './v3-to-v4.js';

const {
  canonicalBaseUrl,
  toV4Model,
  detectCodingPlanRegion,
  migrateModelProviders,
  CP_CHINA_PROVIDER_ID,
} = TEST_ONLY;

describe('V3ToV4Migration', () => {
  const migration = new V3ToV4Migration();

  describe('shouldMigrate', () => {
    it('returns true for $version === 3', () => {
      expect(migration.shouldMigrate({ $version: 3 })).toBe(true);
    });

    it('returns false for $version === 2', () => {
      expect(migration.shouldMigrate({ $version: 2 })).toBe(false);
    });

    it('returns false for $version === 4', () => {
      expect(migration.shouldMigrate({ $version: 4 })).toBe(false);
    });

    it('returns false for null/non-object', () => {
      expect(migration.shouldMigrate(null)).toBe(false);
      expect(migration.shouldMigrate('string')).toBe(false);
      expect(migration.shouldMigrate(42)).toBe(false);
    });
  });

  describe('canonicalBaseUrl', () => {
    it('trims and removes trailing slashes', () => {
      expect(canonicalBaseUrl('  https://api.example.com/v1/  ')).toBe(
        'https://api.example.com/v1',
      );
    });

    it('returns empty string for undefined', () => {
      expect(canonicalBaseUrl(undefined)).toBe('');
    });
  });

  describe('toV4Model', () => {
    it('extracts only model-level fields', () => {
      const legacy = {
        id: 'model-1',
        name: 'Model One',
        description: 'A model',
        envKey: 'SHOULD_NOT_APPEAR',
        baseUrl: 'SHOULD_NOT_APPEAR',
        generationConfig: { timeout: 5000 },
      };
      const v4 = toV4Model(legacy);
      expect(v4).toEqual({
        id: 'model-1',
        name: 'Model One',
        description: 'A model',
        generationConfig: { timeout: 5000 },
      });
      expect(v4).not.toHaveProperty('envKey');
      expect(v4).not.toHaveProperty('baseUrl');
    });

    it('omits undefined optional fields', () => {
      const v4 = toV4Model({ id: 'bare-model' });
      expect(v4).toEqual({ id: 'bare-model' });
    });
  });

  describe('detectCodingPlanRegion', () => {
    it('detects China region', () => {
      expect(
        detectCodingPlanRegion(
          'https://coding.dashscope.aliyuncs.com/v1',
          'BAILIAN_CODING_PLAN_API_KEY',
        ),
      ).toBe('china');
    });

    it('detects Global region', () => {
      expect(
        detectCodingPlanRegion(
          'https://coding-intl.dashscope.aliyuncs.com/v1',
          'BAILIAN_CODING_PLAN_API_KEY',
        ),
      ).toBe('global');
    });

    it('returns false for non-Coding Plan config', () => {
      expect(
        detectCodingPlanRegion('https://api.openai.com/v1', 'OPENAI_API_KEY'),
      ).toBe(false);
    });

    it('returns false when envKey does not match', () => {
      expect(
        detectCodingPlanRegion(
          'https://coding.dashscope.aliyuncs.com/v1',
          'OTHER_KEY',
        ),
      ).toBe(false);
    });

    it('returns false for missing parameters', () => {
      expect(detectCodingPlanRegion(undefined, undefined)).toBe(false);
    });
  });

  describe('migrateModelProviders', () => {
    it('groups models by (authType, baseUrl, envKey) into V4 providers', () => {
      const warnings: string[] = [];
      const result = migrateModelProviders(
        {
          openai: [
            {
              id: 'gpt-4',
              name: 'GPT-4',
              baseUrl: 'https://api.openai.com/v1',
            },
            {
              id: 'gpt-3.5',
              name: 'GPT-3.5',
              baseUrl: 'https://api.openai.com/v1',
            },
          ],
        },
        warnings,
      );

      expect(Object.keys(result)).toEqual(['openai']);
      expect(result['openai']!.authType).toBe('openai');
      expect(result['openai']!.baseUrl).toBe('https://api.openai.com/v1');
      expect(result['openai']!.models).toHaveLength(2);
      expect(result['openai']!.models[0]!.id).toBe('gpt-4');
      expect(result['openai']!.models[1]!.id).toBe('gpt-3.5');
      expect(warnings).toHaveLength(0);
    });

    it('splits models with different baseUrl into separate providers', () => {
      const warnings: string[] = [];
      const result = migrateModelProviders(
        {
          openai: [
            {
              id: 'gpt-4',
              baseUrl: 'https://api.openai.com/v1',
            },
            {
              id: 'custom-model',
              baseUrl: 'https://my-proxy.com/v1',
              envKey: 'CUSTOM_KEY',
            },
          ],
        },
        warnings,
      );

      const providerIds = Object.keys(result).sort();
      expect(providerIds).toHaveLength(2);
      expect(providerIds).toContain('openai');
      expect(providerIds).toContain('my-proxy');
    });

    it('uses fixed providerIds for Coding Plan models', () => {
      const warnings: string[] = [];
      const result = migrateModelProviders(
        {
          openai: [
            {
              id: 'qwen3-coder-plus',
              baseUrl: 'https://coding.dashscope.aliyuncs.com/v1',
              envKey: 'BAILIAN_CODING_PLAN_API_KEY',
            },
            {
              id: 'gpt-4',
              baseUrl: 'https://api.openai.com/v1',
            },
          ],
        },
        warnings,
      );

      expect(result[CP_CHINA_PROVIDER_ID]).toBeDefined();
      expect(result[CP_CHINA_PROVIDER_ID]!.managed).toBe(true);
      expect(result[CP_CHINA_PROVIDER_ID]!.models[0]!.id).toBe(
        'qwen3-coder-plus',
      );
      expect(result['openai']).toBeDefined();
      expect(result['openai']!.managed).toBeUndefined();
    });

    it('generates deterministic providerIds with collision suffixes', () => {
      const warnings: string[] = [];
      const result = migrateModelProviders(
        {
          openai: [
            { id: 'model-a', baseUrl: 'https://api-1.com/v1' },
            { id: 'model-b', baseUrl: 'https://api-2.com/v1' },
            { id: 'model-c', baseUrl: 'https://api-3.com/v1' },
          ],
        },
        warnings,
      );

      const ids = Object.keys(result).sort();
      expect(ids).toEqual(['api-1', 'api-2', 'api-3']);
    });

    it('produces stable output across repeated runs', () => {
      const input = {
        openai: [
          { id: 'a', baseUrl: 'https://b.com/v1', envKey: 'K1' },
          { id: 'b', baseUrl: 'https://a.com/v1', envKey: 'K2' },
        ],
      };

      const run1 = migrateModelProviders(input, []);
      const run2 = migrateModelProviders(input, []);
      expect(JSON.stringify(run1)).toBe(JSON.stringify(run2));
    });

    it('handles empty modelProviders', () => {
      const warnings: string[] = [];
      const result = migrateModelProviders({}, warnings);
      expect(result).toEqual({});
      expect(warnings).toHaveLength(0);
    });

    it('skips non-array entries and warns', () => {
      const warnings: string[] = [];
      const result = migrateModelProviders(
        { openai: 'invalid' as unknown },
        warnings,
      );
      expect(result).toEqual({});
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('non-array');
    });
  });

  describe('migrate (full)', () => {
    it('bumps version to 4', () => {
      const { settings } = migration.migrate({ $version: 3 }, 'user');
      expect((settings as Record<string, unknown>)['$version']).toBe(4);
    });

    it('does not mutate input', () => {
      const input = {
        $version: 3,
        modelProviders: {
          openai: [{ id: 'gpt-4', baseUrl: 'https://api.openai.com/v1' }],
        },
      };
      const clone = structuredClone(input);
      migration.migrate(input, 'user');
      expect(input).toEqual(clone);
    });

    it('migrates modelProviders to V4 structure', () => {
      const { settings } = migration.migrate(
        {
          $version: 3,
          modelProviders: {
            openai: [
              {
                id: 'gpt-4',
                name: 'GPT-4',
                baseUrl: 'https://api.openai.com/v1',
              },
            ],
          },
        },
        'user',
      ) as { settings: Record<string, unknown> };

      const providers = settings['modelProviders'] as Record<string, unknown>;
      expect(providers['openai']).toBeDefined();
      const provider = providers['openai'] as {
        authType: string;
        models: Array<{ id: string }>;
      };
      expect(provider.authType).toBe('openai');
      expect(provider.models[0]!.id).toBe('gpt-4');
      expect(Array.isArray(providers['openai'])).toBe(false);
    });

    it('backfills model.providerId when model is uniquely locatable', () => {
      const { settings } = migration.migrate(
        {
          $version: 3,
          modelProviders: {
            openai: [
              {
                id: 'gpt-4',
                baseUrl: 'https://api.openai.com/v1',
              },
            ],
          },
          model: { name: 'gpt-4' },
          security: { auth: { selectedType: 'openai' } },
        },
        'user',
      ) as { settings: Record<string, unknown> };

      const model = settings['model'] as Record<string, unknown>;
      expect(model['providerId']).toBe('openai');
      expect(model['name']).toBe('gpt-4');
    });

    it('does not set providerId when model appears in multiple providers', () => {
      const { settings, warnings } = migration.migrate(
        {
          $version: 3,
          modelProviders: {
            openai: [
              {
                id: 'shared-model',
                baseUrl: 'https://api-1.com/v1',
              },
              {
                id: 'shared-model',
                baseUrl: 'https://api-2.com/v1',
              },
            ],
          },
          model: { name: 'shared-model' },
        },
        'user',
      ) as { settings: Record<string, unknown>; warnings: string[] };

      const model = settings['model'] as Record<string, unknown>;
      expect(model['providerId']).toBeUndefined();
      expect(warnings.some((w) => w.includes('multiple providers'))).toBe(true);
    });

    it('narrows providerId by selectedType for ambiguous models', () => {
      const { settings } = migration.migrate(
        {
          $version: 3,
          modelProviders: {
            openai: [
              {
                id: 'model-x',
                baseUrl: 'https://api.openai.com/v1',
              },
            ],
            anthropic: [
              {
                id: 'model-x',
                baseUrl: 'https://api.anthropic.com/v1',
              },
            ],
          },
          model: { name: 'model-x' },
          security: { auth: { selectedType: 'openai' } },
        },
        'user',
      ) as { settings: Record<string, unknown> };

      const model = settings['model'] as Record<string, unknown>;
      expect(model['providerId']).toBe('openai');
    });

    it('preserves settings without modelProviders', () => {
      const { settings } = migration.migrate(
        {
          $version: 3,
          ui: { theme: 'dark' },
        },
        'user',
      ) as { settings: Record<string, unknown> };

      expect(settings['$version']).toBe(4);
      expect((settings['ui'] as Record<string, unknown>)['theme']).toBe('dark');
    });

    it('handles Coding Plan with managed flag and fixed providerId', () => {
      const { settings } = migration.migrate(
        {
          $version: 3,
          modelProviders: {
            openai: [
              {
                id: 'qwen3-coder-plus',
                name: '[Bailian Coding Plan] qwen3-coder-plus',
                baseUrl: 'https://coding.dashscope.aliyuncs.com/v1',
                envKey: 'BAILIAN_CODING_PLAN_API_KEY',
                generationConfig: { contextWindowSize: 1000000 },
              },
            ],
          },
        },
        'user',
      ) as { settings: Record<string, unknown> };

      const providers = settings['modelProviders'] as Record<string, unknown>;
      const cpProvider = providers[CP_CHINA_PROVIDER_ID] as {
        managed: boolean;
        authType: string;
        models: Array<{ id: string }>;
      };
      expect(cpProvider).toBeDefined();
      expect(cpProvider.managed).toBe(true);
      expect(cpProvider.authType).toBe('openai');
      expect(cpProvider.models[0]!.id).toBe('qwen3-coder-plus');
    });
  });
});
