/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runLogger, Storage } from '@qwen-code/core';
import { lockSync } from 'proper-lockfile';
import { PersistentState } from './persistentState.js';

describe('PersistentState cross-process updates', () => {
  let tempDir: string;
  let statePath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-state-test-'));
    statePath = path.join(tempDir, 'state.json');
    vi.spyOn(Storage, 'getGlobalConfigDir').mockReturnValue(tempDir);
    vi.spyOn(runLogger, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('fails closed while another process owns the state lock', () => {
    fs.writeFileSync(statePath, '{}');
    const release = lockSync(statePath, { realpath: false });

    try {
      const reserved = new PersistentState().update(
        'startupWarningCounts',
        () => ({ value: { alpha: 1 }, result: true }),
      );
      expect(reserved).toBeUndefined();
      expect(JSON.parse(fs.readFileSync(statePath, 'utf-8'))).toEqual({});
    } finally {
      release();
    }

    const reserved = new PersistentState().update(
      'startupWarningCounts',
      () => ({ value: { alpha: 1 }, result: true }),
    );
    expect(reserved).toBe(true);
    expect(JSON.parse(fs.readFileSync(statePath, 'utf-8'))).toEqual({
      startupWarningCounts: { alpha: 1 },
    });
  });

  it('uses fresh disk counts when an independent instance has a stale cache', () => {
    fs.writeFileSync(
      statePath,
      JSON.stringify({ startupWarningCounts: { alpha: 9 } }),
    );
    const staleInstance = new PersistentState();
    expect(staleInstance.get('startupWarningCounts')).toEqual({ alpha: 9 });

    const otherInstance = new PersistentState();
    expect(
      otherInstance.update('startupWarningCounts', (counts) => ({
        value: { ...counts, alpha: (counts?.['alpha'] ?? 0) + 1 },
        result: true,
      })),
    ).toBe(true);

    const reserved = staleInstance.update(
      'startupWarningCounts',
      (counts) => {
        if ((counts?.['alpha'] ?? 0) >= 10) return undefined;
        return {
          value: { ...counts, alpha: (counts?.['alpha'] ?? 0) + 1 },
          result: true,
        };
      },
    );
    expect(reserved).toBeUndefined();
    expect(staleInstance.get('startupWarningCounts')).toEqual({ alpha: 10 });
  });
});
