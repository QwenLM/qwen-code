/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  detectVersion,
  createPipeline,
  createMigrationStep,
} from '../pipeline.js';
import type { Migration } from '../types.js';

describe('detectVersion', () => {
  it('should detect V3+ by explicit $version', () => {
    expect(detectVersion({ $version: 3 })).toBe(3);
    expect(detectVersion({ $version: 4 })).toBe(4);
    expect(detectVersion({ $version: 5, other: 'data' })).toBe(5);
  });

  it('should detect V2 by general.disableAutoUpdate', () => {
    expect(detectVersion({ general: { disableAutoUpdate: true } })).toBe(2);
    expect(detectVersion({ general: { disableUpdateNag: false } })).toBe(2);
  });

  it('should detect V2 by ui.accessibility.disableLoadingPhrases', () => {
    expect(
      detectVersion({ ui: { accessibility: { disableLoadingPhrases: true } } }),
    ).toBe(2);
  });

  it('should detect V2 by context.fileFiltering.disableFuzzySearch', () => {
    expect(
      detectVersion({
        context: { fileFiltering: { disableFuzzySearch: true } },
      }),
    ).toBe(2);
  });

  it('should detect V2 by model.generationConfig.disableCacheControl', () => {
    expect(
      detectVersion({
        model: { generationConfig: { disableCacheControl: true } },
      }),
    ).toBe(2);
  });

  it('should default to V1 for flat structure', () => {
    expect(detectVersion({ theme: 'dark' })).toBe(1);
    expect(detectVersion({ disableAutoUpdate: true })).toBe(1);
  });

  it('should default to V1 for null/undefined', () => {
    expect(detectVersion(null)).toBe(1);
    expect(detectVersion(undefined)).toBe(1);
  });

  it('should default to V1 for non-object', () => {
    expect(detectVersion('string')).toBe(1);
    expect(detectVersion(123)).toBe(1);
  });

  it('should prefer $version over heuristics', () => {
    // Even with V2-like structure, $version takes precedence
    expect(
      detectVersion({
        $version: 3,
        general: { disableAutoUpdate: true },
      }),
    ).toBe(3);
  });
});

describe('createMigrationStep', () => {
  it('should create successful migration step', () => {
    const migrate = createMigrationStep<number, string>(
      1,
      2,
      (data, addChange) => {
        addChange({
          type: 'transform',
          path: 'test',
          oldValue: data,
          newValue: String(data),
          reason: 'Convert to string',
        });
        return String(data);
      },
    );

    const result = migrate(123);
    expect(result.success).toBe(true);
    expect(result.data).toBe('123');
    expect(result.version).toBe(2);
    expect(result.changes).toHaveLength(1);
    expect(result.warnings).toHaveLength(0);
  });

  it('should handle migration errors', () => {
    const migrate = createMigrationStep<number, number>(1, 2, () => {
      throw new Error('Migration failed');
    });

    const result = migrate(123);
    expect(result.success).toBe(false);
    expect(result.version).toBe(1);
    expect(result.warnings).toContain(
      'Migration from v1 to v2 failed: Migration failed',
    );
  });

  it('should collect warnings', () => {
    const migrate = createMigrationStep<number, number>(
      1,
      2,
      (data, _addChange, addWarning) => {
        addWarning('Warning message');
        return data;
      },
    );

    const result = migrate(123);
    expect(result.success).toBe(true);
    expect(result.warnings).toContain('Warning message');
  });
});

describe('createPipeline', () => {
  it('should return unchanged if already at latest version', () => {
    const pipeline = createPipeline([]);
    const input = { $version: 3 };
    const result = pipeline(input);

    expect(result.success).toBe(true);
    expect(result.data).toBe(input);
    expect(result.version).toBe(3);
    expect(result.changes).toHaveLength(0);
  });

  it('should apply single migration', () => {
    const migrate = createMigrationStep<{ v: number }, { v: number }>(
      1,
      2,
      (data) => ({ v: data.v * 2 }),
    );

    const pipeline = createPipeline([migrate as Migration<unknown, unknown>]);
    const result = pipeline({ v: 5 });

    expect(result.success).toBe(true);
    expect(result.data).toEqual({ v: 10 });
    expect(result.version).toBe(2);
  });

  it('should chain multiple migrations', () => {
    const migrations: Array<Migration<unknown, unknown>> = [
      createMigrationStep<number, string>(1, 2, (n, addChange) => {
        addChange({
          type: 'transform',
          path: 'step1',
          oldValue: n,
          newValue: String(n),
          reason: 'Convert to string',
        });
        return String(n);
      }) as Migration<unknown, unknown>,
      createMigrationStep<string, boolean>(2, 3, (s, addChange) => {
        addChange({
          type: 'transform',
          path: 'step2',
          oldValue: s,
          newValue: s === '123',
          reason: 'Compare to 123',
        });
        return s === '123';
      }) as Migration<unknown, unknown>,
    ];

    const pipeline = createPipeline(migrations);
    const result = pipeline(123);

    expect(result.success).toBe(true);
    expect(result.data).toBe(true);
    expect(result.version).toBe(3);
    expect(result.changes).toHaveLength(2);
  });

  it('should stop on migration failure', () => {
    const migrations: Array<Migration<unknown, unknown>> = [
      createMigrationStep<number, string>(1, 2, (n) => String(n)) as Migration<
        unknown,
        unknown
      >,
      createMigrationStep<string, boolean>(2, 3, () => {
        throw new Error('Step 2 failed');
      }) as Migration<unknown, unknown>,
      // This should not be called
      createMigrationStep<boolean, string>(3, 4, (b) => String(b)) as Migration<
        unknown,
        unknown
      >,
    ];

    const pipeline = createPipeline(migrations);
    const result = pipeline(123);

    expect(result.success).toBe(false);
    expect(result.data).toBe('123'); // Data from successful first step
    expect(result.version).toBe(2);
    expect(result.warnings).toContain(
      'Migration from v2 to v3 failed: Step 2 failed',
    );
  });

  it('should aggregate changes and warnings from all steps', () => {
    const migrations: Array<Migration<unknown, unknown>> = [
      createMigrationStep<number, string>(
        1,
        2,
        (data, addChange, addWarning) => {
          addChange({
            type: 'transform',
            path: 'step1',
            oldValue: data,
            newValue: String(data),
            reason: 'Step 1',
          });
          addWarning('Warning 1');
          return String(data);
        },
      ) as Migration<unknown, unknown>,
      createMigrationStep<string, boolean>(
        2,
        3,
        (data, addChange, addWarning) => {
          addChange({
            type: 'transform',
            path: 'step2',
            oldValue: data,
            newValue: true,
            reason: 'Step 2',
          });
          addWarning('Warning 2');
          return true;
        },
      ) as Migration<unknown, unknown>,
    ];

    const pipeline = createPipeline(migrations);
    const result = pipeline(123);

    expect(result.changes).toHaveLength(2);
    expect(result.warnings).toHaveLength(2);
    expect(result.warnings).toContain('Warning 1');
    expect(result.warnings).toContain('Warning 2');
  });
});
