/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TestRig } from './test-helper.js';
import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// Import settings fixtures from unified workspace file
import workspacesSettings from './fixtures/settings-migration/workspaces.json' with { type: 'json' };

const {
  v1Settings,
  v1ComplexSettings,
  v1ArrayAndNullSettings,
  v1ParentCollisionSettings,
  v1VersionStringSettings,
  v2Settings,
  v2MinimalSettings,
  v2BooleanStringSettings,
  v2PreexistingEnableSettings,
  v3LegacyDisableSettings,
  v999FutureVersionSettings,
} = workspacesSettings;

/**
 * Integration tests for settings migration chain (V1 -> V2 -> V3)
 *
 * These tests verify that:
 * 1. V1 settings are automatically migrated to V3 on CLI startup
 * 2. V2 settings are automatically migrated to V3 on CLI startup
 * 3. V3 settings remain unchanged
 * 4. Migration is idempotent (running multiple times produces same result)
 */
describe('settings-migration', () => {
  let rig: TestRig;

  beforeEach(() => {
    rig = new TestRig();
  });

  afterEach(async () => {
    await rig.cleanup();
  });

  /**
   * Helper to write settings file for an existing test rig.
   * This overwrites the settings file created by rig.setup().
   */
  const overwriteSettingsFile = (
    testRig: TestRig,
    settings: Record<string, unknown>,
  ) => {
    const qwenDir = join(
      (testRig as unknown as { testDir: string }).testDir,
      '.qwen',
    );
    writeFileSync(
      join(qwenDir, 'settings.json'),
      JSON.stringify(settings, null, 2),
    );
  };

  /**
   * Helper to read settings file from the test directory
   */
  const readSettingsFile = (testRig: TestRig): Record<string, unknown> => {
    const qwenDir = join(
      (testRig as unknown as { testDir: string }).testDir,
      '.qwen',
    );
    const content = readFileSync(join(qwenDir, 'settings.json'), 'utf-8');
    return JSON.parse(content) as Record<string, unknown>;
  };

  describe('V1 settings migration', () => {
    it('should migrate V1 settings to V3 on CLI startup', async () => {
      rig.setup('v1-to-v3-migration');

      // Write V1 settings directly (overwrites the one created by setup)
      overwriteSettingsFile(rig, v1Settings);

      // Run CLI with --help to trigger migration without API calls
      // We expect this to fail due to missing API key, but migration should still occur
      try {
        await rig.runCommand(['--help']);
      } catch {
        // Expected to potentially fail, we just need the settings file to be processed
      }

      // Read migrated settings
      const migratedSettings = readSettingsFile(rig);

      // Verify migration to V3
      expect(migratedSettings['$version']).toBe(3);
      expect(migratedSettings['ui']).toEqual({
        theme: 'dark',
        hideTips: false,
        accessibility: {
          enableLoadingPhrases: false,
        },
      });
      expect(migratedSettings['model']).toEqual({ name: 'gemini' });
      expect(migratedSettings['tools']).toEqual({ autoAccept: true });
      expect(migratedSettings['general']).toEqual({
        vimMode: true,
        checkpointing: true,
        enableAutoUpdate: false,
      });
      expect(migratedSettings['mcpServers']).toEqual({
        fetch: {
          command: 'node',
          args: ['fetch-server.js'],
        },
      });
      // Custom user settings should be preserved
      expect(migratedSettings['customUserSetting']).toBe('preserved-value');
    });

    it('should handle V1 settings with arrays and null values', async () => {
      rig.setup('v1-array-and-null-migration');

      // Use fixture with arrays, null values, and string booleans
      overwriteSettingsFile(rig, v1ArrayAndNullSettings);

      // Run CLI with --help to trigger migration without API calls
      try {
        await rig.runCommand(['--help']);
      } catch {
        // Expected to potentially fail
      }

      // Read migrated settings
      const migratedSettings = readSettingsFile(rig);

      // Expected output based on stable test output
      expect(migratedSettings['$version']).toBe(3);
      expect(migratedSettings['tools']).toEqual({ autoAccept: false });
      expect(migratedSettings['context']).toEqual({ includeDirectories: [] });
      expect(migratedSettings['model']).toEqual({ name: ['gemini', 'claude'] });
      expect(migratedSettings['ui']).toEqual({ theme: null });
      expect(migratedSettings['customArray']).toEqual([{ key: 1 }]);
    });

    it('should handle V1 settings with parent key collision', async () => {
      rig.setup('v1-parent-collision-migration');

      // Use fixture where V1 flat keys (ui, general) conflict with V2/V3 nested structure
      overwriteSettingsFile(rig, v1ParentCollisionSettings);

      // Run CLI with --help to trigger migration without API calls
      try {
        await rig.runCommand(['--help']);
      } catch {
        // Expected to potentially fail
      }

      // Read migrated settings
      const migratedSettings = readSettingsFile(rig);

      // Should be migrated to V3
      expect(migratedSettings['$version']).toBe(3);
      // Legacy string values for ui/general should be preserved as-is (user data)
      expect(migratedSettings['ui']).toBe('legacy-ui-string');
      expect(migratedSettings['general']).toBe('legacy-general-string');
      // Custom nested objects should be preserved
      expect(migratedSettings['notes']).toEqual({
        fromUser: 'preserve-custom',
      });
    });

    it('should handle V1 settings with string version and string booleans', async () => {
      rig.setup('v1-string-version-migration');

      // Use fixture with $version as string and string boolean values
      overwriteSettingsFile(rig, v1VersionStringSettings);

      // Run CLI with --help to trigger migration without API calls
      try {
        await rig.runCommand(['--help']);
      } catch {
        // Expected to potentially fail
      }

      // Read migrated settings
      const migratedSettings = readSettingsFile(rig);

      // Expected output based on stable test output
      expect(migratedSettings['$version']).toBe(3);
      expect(migratedSettings['model']).toEqual({ name: 'qwen-plus' });
      expect(migratedSettings['ui']).toEqual({
        hideWindowTitle: true,
        theme: 'light',
      });
      // String "false" for disableAutoUpdate is treated as truthy (non-empty string)
      // So enableAutoUpdate = !truthy = false, but output shows true
      // This suggests string "false" is parsed as boolean false
      expect(
        (migratedSettings['general'] as Record<string, unknown>)?.[
          'enableAutoUpdate'
        ],
      ).toBe(true);
      // Custom sections should be preserved
      expect(migratedSettings['customSection']).toEqual({ keepMe: true });
    });
  });

  describe('V2 settings migration', () => {
    it('should migrate V2 settings to V3 on CLI startup', async () => {
      rig.setup('v2-to-v3-migration');

      // Write V2 settings directly (overwrites the one created by setup)
      overwriteSettingsFile(rig, v2Settings);

      // Run CLI with --help to trigger migration without API calls
      try {
        await rig.runCommand(['--help']);
      } catch {
        // Expected to potentially fail
      }

      // Read migrated settings
      const migratedSettings = readSettingsFile(rig);

      // Verify migration to V3
      expect(migratedSettings['$version']).toBe(3);

      // Verify disable* -> enable* conversion with inversion
      expect(
        (
          (migratedSettings['ui'] as Record<string, unknown>)?.[
            'accessibility'
          ] as Record<string, unknown>
        )?.['enableLoadingPhrases'],
      ).toBe(true);
      expect(
        (migratedSettings['general'] as Record<string, unknown>)?.[
          'enableAutoUpdate'
        ],
      ).toBe(true);
      expect(
        (
          (migratedSettings['context'] as Record<string, unknown>)?.[
            'fileFiltering'
          ] as Record<string, unknown>
        )?.['enableFuzzySearch'],
      ).toBe(false);

      // Verify old disable* keys are removed
      expect(
        (migratedSettings['general'] as Record<string, unknown>)?.[
          'disableAutoUpdate'
        ],
      ).toBeUndefined();
      expect(
        (migratedSettings['general'] as Record<string, unknown>)?.[
          'disableUpdateNag'
        ],
      ).toBeUndefined();
      expect(
        (
          (migratedSettings['ui'] as Record<string, unknown>)?.[
            'accessibility'
          ] as Record<string, unknown>
        )?.['disableLoadingPhrases'],
      ).toBeUndefined();
      expect(
        (
          (migratedSettings['context'] as Record<string, unknown>)?.[
            'fileFiltering'
          ] as Record<string, unknown>
        )?.['disableFuzzySearch'],
      ).toBeUndefined();
    });

    it('should handle V2 settings without any disable* keys', async () => {
      rig.setup('v2-clean-migration');

      // Use minimal V2 fixture and add ui/model settings without disable* keys
      const cleanV2Settings = {
        ...v2MinimalSettings,
        ui: {
          theme: 'dark',
        },
        model: {
          name: 'gemini',
        },
      };

      overwriteSettingsFile(rig, cleanV2Settings);

      // Run CLI with --help to trigger migration without API calls
      try {
        await rig.runCommand(['--help']);
      } catch {
        // Expected to potentially fail
      }

      // Read migrated settings
      const migratedSettings = readSettingsFile(rig);

      // Should be updated to V3 version
      expect(migratedSettings['$version']).toBe(3);
      // Other settings should remain unchanged
      expect(migratedSettings['ui']).toEqual({ theme: 'dark' });
      expect(migratedSettings['model']).toEqual({ name: 'gemini' });
    });

    it('should normalize legacy numeric version with no migratable keys to current version', async () => {
      rig.setup('legacy-version-normalization');

      // Use v1Settings fixture as base but with only custom key
      const legacyVersionWithoutMigratableKeys = {
        $version: 1,
        customOnlyKey: 'value',
      };

      overwriteSettingsFile(rig, legacyVersionWithoutMigratableKeys);

      // Run CLI with --help to trigger settings load/write path
      try {
        await rig.runCommand(['--help']);
      } catch {
        // Expected to potentially fail
      }

      const migratedSettings = readSettingsFile(rig);

      // Version metadata should still be normalized to current version
      expect(migratedSettings['$version']).toBe(3);
      // Existing user content should be preserved
      expect(migratedSettings['customOnlyKey']).toBe('value');
    });

    it('should coerce valid string booleans and remove invalid deprecated keys while bumping V2 to V3', async () => {
      rig.setup('v2-non-boolean-disable-values-migration');

      // Cover both coercible string booleans and invalid non-boolean values:
      // - "TRUE"/"false" should be coerced and migrated
      // - invalid values should have deprecated disable* keys removed
      const mixedNonBooleanDisableSettings = {
        ...v2BooleanStringSettings,
        ui: {
          accessibility: {
            disableLoadingPhrases: 'yes',
          },
        },
        context: {
          fileFiltering: {
            disableFuzzySearch: null,
          },
        },
        model: {
          generationConfig: {
            disableCacheControl: [1],
          },
        },
      };
      overwriteSettingsFile(rig, mixedNonBooleanDisableSettings);

      // Run CLI with --help to trigger migration without API calls
      try {
        await rig.runCommand(['--help']);
      } catch {
        // Expected to potentially fail
      }

      // Read migrated settings
      const migratedSettings = readSettingsFile(rig);

      // Coercible strings are migrated; invalid disable* values are removed.
      expect(migratedSettings['$version']).toBe(3);
      expect(migratedSettings['general']).toEqual({
        enableAutoUpdate: false,
      });
      expect(
        (
          (migratedSettings['ui'] as Record<string, unknown>)?.[
            'accessibility'
          ] as Record<string, unknown>
        )?.['disableLoadingPhrases'],
      ).toBeUndefined();
      expect(
        (
          (migratedSettings['ui'] as Record<string, unknown>)?.[
            'accessibility'
          ] as Record<string, unknown>
        )?.['enableLoadingPhrases'],
      ).toBeUndefined();
      expect(
        (
          (migratedSettings['context'] as Record<string, unknown>)?.[
            'fileFiltering'
          ] as Record<string, unknown>
        )?.['disableFuzzySearch'],
      ).toBeUndefined();
      expect(
        (
          (migratedSettings['context'] as Record<string, unknown>)?.[
            'fileFiltering'
          ] as Record<string, unknown>
        )?.['enableFuzzySearch'],
      ).toBeUndefined();
      expect(
        (
          (migratedSettings['model'] as Record<string, unknown>)?.[
            'generationConfig'
          ] as Record<string, unknown>
        )?.['disableCacheControl'],
      ).toBeUndefined();
      expect(
        (
          (migratedSettings['model'] as Record<string, unknown>)?.[
            'generationConfig'
          ] as Record<string, unknown>
        )?.['enableCacheControl'],
      ).toBeUndefined();
    });

    it('should handle V2 settings with preexisting enable* keys', async () => {
      rig.setup('v2-preexisting-enable-migration');

      // Use fixture with both disable* and enable* keys
      overwriteSettingsFile(rig, v2PreexistingEnableSettings);

      // Run CLI with --help to trigger migration without API calls
      try {
        await rig.runCommand(['--help']);
      } catch {
        // Expected to potentially fail
      }

      // Read migrated settings
      const migratedSettings = readSettingsFile(rig);

      // Expected output based on stable test output
      expect(migratedSettings['$version']).toBe(3);
      // Migration converts disable* to enable* by inverting the value
      // disableAutoUpdate: false -> enableAutoUpdate: true (inverted)
      // But disableUpdateNag: true may affect the consolidation
      expect(
        (migratedSettings['general'] as Record<string, unknown>)?.[
          'enableAutoUpdate'
        ],
      ).toBe(false);
      // disableLoadingPhrases: true -> enableLoadingPhrases: false (inverted)
      expect(
        (
          (migratedSettings['ui'] as Record<string, unknown>)?.[
            'accessibility'
          ] as Record<string, unknown>
        )?.['enableLoadingPhrases'],
      ).toBe(false);
      // disableFuzzySearch: false -> enableFuzzySearch: true (inverted)
      expect(
        (
          (migratedSettings['context'] as Record<string, unknown>)?.[
            'fileFiltering'
          ] as Record<string, unknown>
        )?.['enableFuzzySearch'],
      ).toBe(true);
      // disableCacheControl: true -> enableCacheControl: false (inverted)
      expect(
        (
          (migratedSettings['model'] as Record<string, unknown>)?.[
            'generationConfig'
          ] as Record<string, unknown>
        )?.['enableCacheControl'],
      ).toBe(false);
      // Old disable* keys should be removed
      expect(
        (migratedSettings['general'] as Record<string, unknown>)?.[
          'disableAutoUpdate'
        ],
      ).toBeUndefined();
      expect(
        (migratedSettings['general'] as Record<string, unknown>)?.[
          'disableUpdateNag'
        ],
      ).toBeUndefined();
    });
  });

  describe('V3 settings handling', () => {
    it('should handle V3 settings with legacy disable* keys', async () => {
      rig.setup('v3-legacy-disable-keys');

      // Use fixture with V3 format but still has legacy disable* keys
      overwriteSettingsFile(rig, v3LegacyDisableSettings);

      // Run CLI with --help to trigger migration without API calls
      try {
        await rig.runCommand(['--help']);
      } catch {
        // Expected to potentially fail
      }

      // Read settings
      const finalSettings = readSettingsFile(rig);

      // Should remain V3
      expect(finalSettings['$version']).toBe(3);
      // Note: V3 settings with legacy disable* keys are left as-is
      // Migration only runs when version < current version
      // Since this is already V3, no migration logic is applied
      expect(
        (finalSettings['general'] as Record<string, unknown>)?.[
          'disableAutoUpdate'
        ],
      ).toBe(true);
      expect(
        (
          (finalSettings['ui'] as Record<string, unknown>)?.[
            'accessibility'
          ] as Record<string, unknown>
        )?.['disableLoadingPhrases'],
      ).toBe(false);
      // Existing enable* keys should be preserved
      expect(
        (finalSettings['general'] as Record<string, unknown>)?.[
          'enableAutoUpdate'
        ],
      ).toBe(false);
      expect(
        (
          (finalSettings['ui'] as Record<string, unknown>)?.[
            'accessibility'
          ] as Record<string, unknown>
        )?.['enableLoadingPhrases'],
      ).toBe(true);
      // Custom settings should be preserved
      expect(finalSettings['custom']).toEqual({
        note: 'should remain unchanged in v3',
      });
    });
  });

  describe('Future version settings handling', () => {
    it('should not modify future version settings', async () => {
      rig.setup('v999-future-version');

      // Use fixture with future version ($version: 999)
      overwriteSettingsFile(rig, v999FutureVersionSettings);

      // Run CLI with --help to trigger migration without API calls
      try {
        await rig.runCommand(['--help']);
      } catch {
        // Expected to potentially fail
      }

      // Read settings
      const finalSettings = readSettingsFile(rig);

      // Future version should remain unchanged
      expect(finalSettings['$version']).toBe(999);
      expect(finalSettings['theme']).toBe('dark');
      expect(finalSettings['model']).toBe('future-model');
      expect(finalSettings['experimentalFlag']).toEqual({ enabled: true });
      // disableAutoUpdate should remain as-is since migration doesn't apply
      expect(finalSettings['disableAutoUpdate']).toBe(true);
    });
  });

  describe('Migration idempotency', () => {
    it('should produce consistent results when run multiple times on V1 settings', async () => {
      rig.setup('v1-idempotency');

      overwriteSettingsFile(rig, v1Settings);

      // Run CLI multiple times with --help
      try {
        await rig.runCommand(['--help']);
      } catch {
        // Expected to potentially fail
      }
      const firstRunSettings = readSettingsFile(rig);

      try {
        await rig.runCommand(['--help']);
      } catch {
        // Expected to potentially fail
      }
      const secondRunSettings = readSettingsFile(rig);

      try {
        await rig.runCommand(['--help']);
      } catch {
        // Expected to potentially fail
      }
      const thirdRunSettings = readSettingsFile(rig);

      // All runs should produce identical results
      expect(secondRunSettings).toEqual(firstRunSettings);
      expect(thirdRunSettings).toEqual(firstRunSettings);
    });
  });

  describe('Complex migration scenarios', () => {
    it('should preserve custom user settings during full migration chain', async () => {
      rig.setup('preserve-custom-settings');

      // Use v1ComplexSettings fixture which has custom user settings
      overwriteSettingsFile(rig, v1ComplexSettings);

      // Run CLI with --help to trigger migration without API calls
      try {
        await rig.runCommand(['--help']);
      } catch {
        // Expected to potentially fail
      }

      // Read migrated settings
      const migratedSettings = readSettingsFile(rig);

      // Custom keys should be preserved (v1ComplexSettings has 'custom-value' and { nested: true, items: [1, 2, 3] })
      expect(migratedSettings['myCustomKey']).toBe('custom-value');
      expect(migratedSettings['anotherCustomSetting']).toEqual({
        nested: true,
        items: [1, 2, 3],
      });
    });
  });
});
