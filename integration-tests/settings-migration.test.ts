/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TestRig } from './test-helper.js';
import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

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
   * Sample V1 settings (flat structure, no $version field)
   * This represents settings from early versions of the CLI
   */
  const createV1Settings = () => ({
    theme: 'dark',
    model: 'gemini',
    autoAccept: true,
    hideTips: false,
    vimMode: true,
    checkpointing: true,
    disableAutoUpdate: true,
    disableLoadingPhrases: true,
    mcpServers: {
      fetch: {
        command: 'node',
        args: ['fetch-server.js'],
      },
    },
    customUserSetting: 'preserved-value',
  });

  /**
   * Sample V2 settings (nested structure with $version: 2, disable* booleans)
   */
  const createV2Settings = () => ({
    $version: 2,
    ui: {
      theme: 'light',
      accessibility: {
        disableLoadingPhrases: false,
      },
    },
    general: {
      disableAutoUpdate: false,
      disableUpdateNag: false,
      checkpointing: false,
    },
    model: {
      name: 'claude',
    },
    context: {
      fileFiltering: {
        disableFuzzySearch: true,
      },
    },
    mcpServers: {},
  });

  /**
   * Sample V3 settings (current format, should not be modified)
   */
  const createV3Settings = () => ({
    $version: 3,
    ui: {
      theme: 'system',
      accessibility: {
        enableLoadingPhrases: true,
      },
    },
    general: {
      enableAutoUpdate: true,
    },
    model: {
      name: 'gemini-2.0',
    },
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
      overwriteSettingsFile(rig, createV1Settings());

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

    it('should handle V1 settings with partial V2 structure', async () => {
      rig.setup('v1-partial-migration');

      // V1 settings that might have been partially migrated
      const partialV1Settings = {
        theme: 'dark',
        model: 'gemini',
        // Some V2-like nested structure but no $version
        ui: {
          hideWindowTitle: true,
        },
      };

      overwriteSettingsFile(rig, partialV1Settings);

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
    });
  });

  describe('V2 settings migration', () => {
    it('should migrate V2 settings to V3 on CLI startup', async () => {
      rig.setup('v2-to-v3-migration');

      // Write V2 settings directly (overwrites the one created by setup)
      overwriteSettingsFile(rig, createV2Settings());

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

      const cleanV2Settings = {
        $version: 2,
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
  });

  describe('V3 settings handling', () => {
    it('should not modify existing V3 settings', async () => {
      rig.setup('v3-no-migration');

      const v3Settings = createV3Settings();
      overwriteSettingsFile(rig, v3Settings);

      // Run CLI with --help to trigger migration without API calls
      try {
        await rig.runCommand(['--help']);
      } catch {
        // Expected to potentially fail
      }

      // Read settings
      const finalSettings = readSettingsFile(rig);

      // Should remain V3 and unchanged
      expect(finalSettings['$version']).toBe(3);
      expect(finalSettings).toEqual(v3Settings);
    });
  });

  describe('Migration idempotency', () => {
    it('should produce consistent results when run multiple times on V1 settings', async () => {
      rig.setup('v1-idempotency');

      overwriteSettingsFile(rig, createV1Settings());

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

    it('should produce consistent results when run multiple times on V2 settings', async () => {
      rig.setup('v2-idempotency');

      overwriteSettingsFile(rig, createV2Settings());

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

      // Both runs should produce identical results
      expect(secondRunSettings).toEqual(firstRunSettings);
    });
  });

  describe('Complex migration scenarios', () => {
    it('should handle V2 settings with multiple disable* keys affecting the same enable* key', async () => {
      rig.setup('v2-consolidated-booleans');

      const v2SettingsWithMultipleDisables = {
        $version: 2,
        general: {
          // Both disableAutoUpdate and disableUpdateNag should consolidate to enableAutoUpdate
          disableAutoUpdate: true, // This should make enableAutoUpdate = false
          disableUpdateNag: false,
          checkpointing: true,
        },
      };

      overwriteSettingsFile(rig, v2SettingsWithMultipleDisables);

      // Run CLI with --help to trigger migration without API calls
      try {
        await rig.runCommand(['--help']);
      } catch {
        // Expected to potentially fail
      }

      // Read migrated settings
      const migratedSettings = readSettingsFile(rig);

      // enableAutoUpdate should be false because disableAutoUpdate was true
      expect(
        (migratedSettings['general'] as Record<string, unknown>)?.[
          'enableAutoUpdate'
        ],
      ).toBe(false);
      // Old keys should be removed
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

    it('should preserve custom user settings during full migration chain', async () => {
      rig.setup('preserve-custom-settings');

      const v1SettingsWithCustomKeys = {
        theme: 'dark',
        model: 'gemini',
        myCustomKey: 'customValue',
        anotherCustomSetting: { nested: true },
      };

      overwriteSettingsFile(rig, v1SettingsWithCustomKeys);

      // Run CLI with --help to trigger migration without API calls
      try {
        await rig.runCommand(['--help']);
      } catch {
        // Expected to potentially fail
      }

      // Read migrated settings
      const migratedSettings = readSettingsFile(rig);

      // Custom keys should be preserved
      expect(migratedSettings['myCustomKey']).toBe('customValue');
      expect(migratedSettings['anotherCustomSetting']).toEqual({
        nested: true,
      });
    });

    it('should handle model.generationConfig.disableCacheControl migration', async () => {
      rig.setup('v2-cache-control-migration');

      const v2SettingsWithCacheControl = {
        $version: 2,
        model: {
          name: 'gemini',
          generationConfig: {
            disableCacheControl: true,
          },
        },
      };

      overwriteSettingsFile(rig, v2SettingsWithCacheControl);

      // Run CLI with --help to trigger migration without API calls
      try {
        await rig.runCommand(['--help']);
      } catch {
        // Expected to potentially fail
      }

      // Read migrated settings
      const migratedSettings = readSettingsFile(rig);

      // disableCacheControl should be migrated to enableCacheControl with inverted value
      expect(
        (
          (migratedSettings['model'] as Record<string, unknown>)?.[
            'generationConfig'
          ] as Record<string, unknown>
        )?.['enableCacheControl'],
      ).toBe(false);
      expect(
        (
          (migratedSettings['model'] as Record<string, unknown>)?.[
            'generationConfig'
          ] as Record<string, unknown>
        )?.['disableCacheControl'],
      ).toBeUndefined();
    });
  });
});
