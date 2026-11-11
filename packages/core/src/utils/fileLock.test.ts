/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { acquireFileLock, withFileLock } from './fileLock.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'file-lock-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('withFileLock', () => {
  it('runs overlapping read-modify-writes one after another, so none is lost', async () => {
    const file = join(dir, 'counter.json');
    writeFileSync(file, '0');
    const increment = () =>
      withFileLock(file, async () => {
        const value = Number(readFileSync(file, 'utf-8'));
        await new Promise((resolve) => setTimeout(resolve, 5));
        writeFileSync(file, String(value + 1));
      });

    await Promise.all(Array.from({ length: 8 }, increment));

    expect(readFileSync(file, 'utf-8')).toBe('8');
  });

  it('reports the lock it cannot take instead of updating unlocked', async () => {
    const file = join(dir, 'busy.json');
    const lock = await acquireFileLock(file);
    let ran = false;
    try {
      await expect(
        withFileLock(file, async () => {
          ran = true;
        }, 50),
      ).rejects.toThrow(/another process is writing it/);
    } finally {
      await lock.release();
    }
    expect(ran).toBe(false);
  });
});
