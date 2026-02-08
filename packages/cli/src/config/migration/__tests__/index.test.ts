/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  migrateToLatest,
  needsMigration,
  detectVersion,
  LATEST_VERSION,
} from '../index.js';
import type { SettingsV1, SettingsV2 } from '../types.js';

describe('migrateToLatest', () => {
  it('should migrate V1 to V3 (through V2)', () => {
    const v1: SettingsV1 = {
      theme: 'dark',
      disableAutoUpdate: true,
      model: 'gemini-1.5-pro',
    };

    const result = migrateToLatest(v1);

    expect(result.success).toBe(true);
    expect(result.data.$version).toBe(3);
    expect(result.data.ui?.theme).toBe('dark');
    expect(result.data.general?.enableAutoUpdate).toBe(false);
    expect(result.data.model?.name).toBe('gemini-1.5-pro');
    expect(result.changes.length).toBeGreaterThan(0);
  });

  it('should migrate V2 to V3', () => {
    const v2: SettingsV2 = {
      $version: 2,
      ui: { theme: 'light' },
      general: { disableAutoUpdate: false },
    };

    const result = migrateToLatest(v2);

    expect(result.success).toBe(true);
    expect(result.data.$version).toBe(3);
    expect(result.data.ui?.theme).toBe('light');
    expect(result.data.general?.enableAutoUpdate).toBe(true);
  });

  it('should return V3 unchanged', () => {
    const v3 = {
      $version: 3,
      ui: { theme: 'dark' },
    };

    const result = migrateToLatest(v3);

    expect(result.success).toBe(true);
    expect(result.data).toBe(v3);
    expect(result.changes).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
  });

  it('should handle future versions gracefully', () => {
    const v4 = {
      $version: 4,
      ui: { theme: 'dark' },
    };

    const result = migrateToLatest(v4);

    expect(result.success).toBe(true);
    expect(result.data).toBe(v4);
    expect(result.version).toBe(4);
  });

  it('should handle empty object as V1', () => {
    const result = migrateToLatest({});

    expect(result.success).toBe(true);
    expect(result.data.$version).toBe(3);
  });

  it('should aggregate changes from both migrations', () => {
    const v1: SettingsV1 = {
      theme: 'dark',
      disableAutoUpdate: true,
      disableLoadingPhrases: true,
    };

    const result = migrateToLatest(v1);

    expect(result.success).toBe(true);
    // Should have changes from both V1->V2 and V2->V3
    expect(result.changes.length).toBeGreaterThanOrEqual(3);
  });

  it('should handle real-world V1 settings', () => {
    const v1: SettingsV1 = {
      theme: 'VS Dark',
      model: 'gemini-1.5-pro',
      disableAutoUpdate: false,
      disableLoadingPhrases: true,
      vimMode: true,
      preferredEditor: 'vscode',
      mcpServers: {
        filesystem: {
          command: 'npx',
          args: [
            '-y',
            '@modelcontextprotocol/server-filesystem',
            '/Users/test',
          ],
        },
      },
    };

    const result = migrateToLatest(v1);

    expect(result.success).toBe(true);
    expect(result.data.$version).toBe(3);
    expect(result.data.ui?.theme).toBe('VS Dark');
    expect(result.data.model?.name).toBe('gemini-1.5-pro');
    expect(result.data.general?.enableAutoUpdate).toBe(true);
    expect(result.data.ui?.accessibility?.enableLoadingPhrases).toBe(false);
    expect(result.data.general?.vimMode).toBe(true);
    expect(result.data.general?.preferredEditor).toBe('vscode');
    expect(result.data.mcpServers).toEqual(v1.mcpServers);
  });

  it('should handle real-world V2 settings', () => {
    const v2: SettingsV2 = {
      $version: 2,
      ui: {
        theme: 'Qwen Dark',
        hideTips: false,
      },
      general: {
        preferredEditor: 'cursor',
        disableAutoUpdate: false,
        disableUpdateNag: true,
      },
      model: {
        name: 'gemini-2.0-flash',
        maxSessionTurns: 50,
      },
    };

    const result = migrateToLatest(v2);

    expect(result.success).toBe(true);
    expect(result.data.$version).toBe(3);
    expect(result.data.ui?.theme).toBe('Qwen Dark');
    expect(result.data.general?.preferredEditor).toBe('cursor');
    // disableAutoUpdate=false, disableUpdateNag=true -> enableAutoUpdate=false (any true disables)
    expect(result.data.general?.enableAutoUpdate).toBe(false);
  });
});

describe('needsMigration', () => {
  it('should return true for V1', () => {
    expect(needsMigration({ theme: 'dark' })).toBe(true);
  });

  it('should return true for V2', () => {
    expect(needsMigration({ $version: 2, ui: { theme: 'dark' } })).toBe(true);
  });

  it('should return false for V3', () => {
    expect(needsMigration({ $version: 3 })).toBe(false);
  });

  it('should return false for V4+', () => {
    expect(needsMigration({ $version: 4 })).toBe(false);
    expect(needsMigration({ $version: 5 })).toBe(false);
  });

  it('should return false for null', () => {
    expect(needsMigration(null)).toBe(true);
  });

  it('should return false for undefined', () => {
    expect(needsMigration(undefined)).toBe(true);
  });
});

describe('detectVersion', () => {
  it('should detect V1 from flat structure', () => {
    expect(detectVersion({ theme: 'dark' })).toBe(1);
  });

  it('should detect V2 from general.disableAutoUpdate', () => {
    expect(detectVersion({ general: { disableAutoUpdate: true } })).toBe(2);
  });

  it('should detect V3 from $version field', () => {
    expect(detectVersion({ $version: 3 })).toBe(3);
  });
});

describe('LATEST_VERSION', () => {
  it('should be 3', () => {
    expect(LATEST_VERSION).toBe(3);
  });
});
