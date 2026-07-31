/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi } from 'vitest';
import { MigrationScheduler } from './scheduler.js';

import type { SettingsMigration } from './types.js';

describe('MigrationScheduler', () => {
  // Mock migration for testing
  const createMockMigration = (
    fromVersion: number,
    toVersion: number,
    shouldMigrateResult: boolean,
  ): SettingsMigration => ({
    fromVersion,
    toVersion,
    shouldMigrate: vi.fn().mockReturnValue(shouldMigrateResult),
    migrate: vi.fn((settings) => ({
      settings: {
        ...(settings as Record<string, unknown>),
        $version: toVersion,
      },
      warnings: [],
    })),
  });

  it('should execute migrations in order when shouldMigrate returns true', () => {
    const migration1 = createMockMigration(1, 2, true);
    const migration2 = createMockMigration(2, 3, true);

    const scheduler = new MigrationScheduler([migration1, migration2], 'user');
    const result = scheduler.migrate({ $version: 1, someKey: 'value' });

    expect(migration1.shouldMigrate).toHaveBeenCalledTimes(1);
    expect(migration1.migrate).toHaveBeenCalledTimes(1);
    expect(migration2.shouldMigrate).toHaveBeenCalledTimes(1);
    expect(migration2.migrate).toHaveBeenCalledTimes(1);

    expect(result.executedMigrations).toHaveLength(2);
    expect(result.executedMigrations[0]).toEqual({
      fromVersion: 1,
      toVersion: 2,
    });
    expect(result.executedMigrations[1]).toEqual({
      fromVersion: 2,
      toVersion: 3,
    });
    expect(result.finalVersion).toBe(3);
  });

  it('should skip migrations when shouldMigrate returns false', () => {
    const migration1 = createMockMigration(1, 2, false);
    const migration2 = createMockMigration(2, 3, true);

    const scheduler = new MigrationScheduler([migration1, migration2], 'user');
    const result = scheduler.migrate({ $version: 2, someKey: 'value' });

    expect(migration1.shouldMigrate).toHaveBeenCalledTimes(1);
    expect(migration1.migrate).not.toHaveBeenCalled();
    expect(migration2.shouldMigrate).toHaveBeenCalledTimes(1);
    expect(migration2.migrate).toHaveBeenCalledTimes(1);

    expect(result.executedMigrations).toHaveLength(1);
    expect(result.executedMigrations[0]).toEqual({
      fromVersion: 2,
      toVersion: 3,
    });
  });

  it('should be idempotent - running migrations twice produces same result', () => {
    // Create a migration that checks the version to determine if migration is needed
    const migration1: SettingsMigration = {
      fromVersion: 1,
      toVersion: 2,
      shouldMigrate: vi.fn((settings) => {
        const s = settings as Record<string, unknown>;
        return s['$version'] !== 2;
      }),
      migrate: vi.fn((settings) => ({
        settings: {
          ...(settings as Record<string, unknown>),
          $version: 2,
        },
        warnings: [],
      })),
    };

    const scheduler = new MigrationScheduler([migration1], 'user');
    const input = { theme: 'dark' };

    const result1 = scheduler.migrate(input);
    const result2 = scheduler.migrate(result1.settings);

    expect(result1.executedMigrations).toHaveLength(1);
    expect(result2.executedMigrations).toHaveLength(0);
    expect(result1.finalVersion).toBe(result2.finalVersion);
  });

  it('should pass updated settings to each migration', () => {
    const migration1: SettingsMigration = {
      fromVersion: 1,
      toVersion: 2,
      shouldMigrate: vi.fn().mockReturnValue(true),
      migrate: vi.fn(() => ({
        settings: { $version: 2, transformed: true },
        warnings: [],
      })),
    };

    const migration2: SettingsMigration = {
      fromVersion: 2,
      toVersion: 3,
      shouldMigrate: vi.fn().mockReturnValue(true),
      migrate: vi.fn((s) => ({ settings: s, warnings: [] })),
    };

    const scheduler = new MigrationScheduler([migration1, migration2], 'user');
    scheduler.migrate({ $version: 1 });

    expect(migration2.shouldMigrate).toHaveBeenCalledWith(
      expect.objectContaining({ $version: 2, transformed: true }),
    );
  });

  it('should handle empty migrations array', () => {
    const scheduler = new MigrationScheduler([], 'user');
    const result = scheduler.migrate({ $version: 1, key: 'value' });

    expect(result.executedMigrations).toHaveLength(0);
    expect(result.finalVersion).toBe(1);
    expect(result.settings).toEqual({ $version: 1, key: 'value' });
  });

  it('should throw error when migration fails', () => {
    const migration1: SettingsMigration = {
      fromVersion: 1,
      toVersion: 2,
      shouldMigrate: vi.fn().mockReturnValue(true),
      migrate: vi.fn().mockImplementation(() => {
        throw new Error('Migration failed');
      }),
    };

    const scheduler = new MigrationScheduler([migration1], 'user');

    expect(() => scheduler.migrate({ $version: 1 })).toThrow(
      'Migration failed',
    );
  });

  it('should handle settings without version field', () => {
    const migration1 = createMockMigration(1, 2, true);

    const scheduler = new MigrationScheduler([migration1], 'user');
    const result = scheduler.migrate({ theme: 'dark' });

    expect(result.finalVersion).toBe(2);
    expect(result.executedMigrations).toHaveLength(1);
  });
});
