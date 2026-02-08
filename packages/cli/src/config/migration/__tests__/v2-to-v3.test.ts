/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { migrateV2ToV3 } from '../versions/v2-to-v3.js';
import type { SettingsV2 } from '../types.js';

describe('migrateV2ToV3', () => {
  it('should invert disableAutoUpdate to enableAutoUpdate', () => {
    const v2: SettingsV2 = {
      $version: 2,
      general: {
        disableAutoUpdate: true,
      },
    };

    const result = migrateV2ToV3(v2);

    expect(result.success).toBe(true);
    expect(result.data.$version).toBe(3);
    expect(result.data.general?.enableAutoUpdate).toBe(false);
    // Use bracket notation to check deleted fields
    expect(
      (result.data.general as Record<string, unknown>)['disableAutoUpdate'],
    ).toBeUndefined();
  });

  it('should invert disableUpdateNag to enableAutoUpdate', () => {
    const v2: SettingsV2 = {
      $version: 2,
      general: {
        disableUpdateNag: false,
      },
    };

    const result = migrateV2ToV3(v2);

    expect(result.success).toBe(true);
    expect(result.data.general?.enableAutoUpdate).toBe(true);
    expect(
      (result.data.general as Record<string, unknown>)['disableUpdateNag'],
    ).toBeUndefined();
  });

  it('should consolidate both disableAutoUpdate and disableUpdateNag', () => {
    const v2: SettingsV2 = {
      $version: 2,
      general: {
        disableAutoUpdate: false,
        disableUpdateNag: false,
      },
    };

    const result = migrateV2ToV3(v2);

    expect(result.success).toBe(true);
    // If ANY disable is true, enable should be false
    // If both are false, enable should be true
    expect(result.data.general?.enableAutoUpdate).toBe(true);
  });

  it('should consolidate with any disable=true resulting in enable=false', () => {
    const v2: SettingsV2 = {
      $version: 2,
      general: {
        disableAutoUpdate: true,
        disableUpdateNag: false,
      },
    };

    const result = migrateV2ToV3(v2);

    expect(result.success).toBe(true);
    expect(result.data.general?.enableAutoUpdate).toBe(false);
  });

  it('should invert disableLoadingPhrases to enableLoadingPhrases', () => {
    const v2: SettingsV2 = {
      $version: 2,
      ui: {
        accessibility: {
          disableLoadingPhrases: true,
        },
      },
    };

    const result = migrateV2ToV3(v2);

    expect(result.success).toBe(true);
    expect(result.data.ui?.accessibility?.enableLoadingPhrases).toBe(false);
    expect(
      (result.data.ui?.accessibility as Record<string, unknown>)[
        'disableLoadingPhrases'
      ],
    ).toBeUndefined();
  });

  it('should invert disableFuzzySearch to enableFuzzySearch', () => {
    const v2: SettingsV2 = {
      $version: 2,
      context: {
        fileFiltering: {
          disableFuzzySearch: true,
        },
      },
    };

    const result = migrateV2ToV3(v2);

    expect(result.success).toBe(true);
    expect(result.data.context?.fileFiltering?.enableFuzzySearch).toBe(false);
    expect(
      (result.data.context?.fileFiltering as Record<string, unknown>)[
        'disableFuzzySearch'
      ],
    ).toBeUndefined();
  });

  it('should invert disableCacheControl to enableCacheControl', () => {
    const v2: SettingsV2 = {
      $version: 2,
      model: {
        generationConfig: {
          disableCacheControl: true,
        },
      },
    };

    const result = migrateV2ToV3(v2);

    expect(result.success).toBe(true);
    expect(result.data.model?.generationConfig?.enableCacheControl).toBe(false);
    expect(
      (result.data.model?.generationConfig as Record<string, unknown>)[
        'disableCacheControl'
      ],
    ).toBeUndefined();
  });

  it('should preserve non-boolean fields', () => {
    const v2: SettingsV2 = {
      $version: 2,
      ui: {
        theme: 'dark',
      },
      general: {
        preferredEditor: 'vscode',
      },
      model: {
        name: 'gemini-1.5-pro',
      },
    };

    const result = migrateV2ToV3(v2);

    expect(result.success).toBe(true);
    expect(result.data.ui?.theme).toBe('dark');
    expect(result.data.general?.preferredEditor).toBe('vscode');
    expect(result.data.model?.name).toBe('gemini-1.5-pro');
  });

  it('should preserve mcpServers', () => {
    const v2: SettingsV2 = {
      $version: 2,
      mcpServers: { server1: { command: 'cmd' } },
    };

    const result = migrateV2ToV3(v2);

    expect(result.success).toBe(true);
    expect(result.data.mcpServers).toEqual({ server1: { command: 'cmd' } });
  });

  it('should handle empty V2 object', () => {
    const v2: SettingsV2 = {
      $version: 2,
    };

    const result = migrateV2ToV3(v2);

    expect(result.success).toBe(true);
    expect(result.data.$version).toBe(3);
  });

  it('should record changes for inverted fields', () => {
    const v2: SettingsV2 = {
      $version: 2,
      general: {
        disableAutoUpdate: true,
      },
    };

    const result = migrateV2ToV3(v2);

    expect(result.success).toBe(true);
    expect(result.changes).toContainEqual(
      expect.objectContaining({
        type: 'transform',
        path: 'general.enableAutoUpdate',
        oldValue: expect.arrayContaining([
          expect.objectContaining({
            path: 'general.disableAutoUpdate',
            value: true,
          }),
        ]),
        newValue: false,
      }),
    );
  });

  it('should handle complex V2 structure with multiple inversions', () => {
    const v2: SettingsV2 = {
      $version: 2,
      ui: {
        theme: 'dark',
        accessibility: {
          disableLoadingPhrases: false,
          screenReader: true,
        },
      },
      general: {
        disableAutoUpdate: false,
        disableUpdateNag: false,
        vimMode: true,
      },
      context: {
        fileFiltering: {
          disableFuzzySearch: false,
          respectGitIgnore: true,
        },
      },
    };

    const result = migrateV2ToV3(v2);

    expect(result.success).toBe(true);
    expect(result.data.$version).toBe(3);
    expect(result.data.ui?.theme).toBe('dark');
    expect(result.data.ui?.accessibility?.enableLoadingPhrases).toBe(true);
    expect(result.data.ui?.accessibility?.screenReader).toBe(true);
    expect(result.data.general?.enableAutoUpdate).toBe(true);
    expect(result.data.general?.vimMode).toBe(true);
    expect(result.data.context?.fileFiltering?.enableFuzzySearch).toBe(true);
    expect(result.data.context?.fileFiltering?.respectGitIgnore).toBe(true);
  });

  it('should not mutate original input', () => {
    const v2: SettingsV2 = {
      $version: 2,
      general: {
        disableAutoUpdate: true,
      },
    };
    const original = JSON.stringify(v2);

    migrateV2ToV3(v2);

    expect(JSON.stringify(v2)).toBe(original);
  });
});
