/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { removeScratchDir } from './scratch-dir.js';

describe('removeScratchDir', () => {
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), 'qwen-scratch-dir-test-'));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(tmpRoot, { recursive: true, force: true });
  });

  it('warns and resolves when the dir cannot be removed', async () => {
    // A cleanup that cannot finish must not turn an all-green run red
    // (#10325). ENOTDIR is outside rm's retryable codes, so the rejection
    // reaches the catch deterministically instead of racing a retry window.
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
    const file = join(tmpRoot, 'not-a-dir');
    await writeFile(file, 'x');
    const stuck = join(file, 'child');

    await expect(removeScratchDir(stuck)).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledWith(
      `Warning: could not remove ${stuck}:`,
      expect.anything(),
    );
  });

  it('removes a dir a straggler writer keeps refilling', async () => {
    // rm(recursive) only retries on EBUSY/EMFILE/ENFILE/ENOTEMPTY, so the
    // retry budget is exactly what absorbs a CLI child still writing under its
    // scratch dir. This refill writer outlives a single removal attempt but
    // stops well inside the shipped 5x200ms budget, which makes that budget
    // load-bearing: drop maxRetries to 0 and the first ENOTEMPTY reaches the
    // catch, the tree survives, and this case goes red. The ENOTDIR case above
    // cannot do this -- it is outside the retryable set, so it is equally red
    // or green whatever the budget is. The prefix is deliberately not
    // qwen-e2e-home-*, so globalSetup's sweeper cannot race this tree.
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
    const root = join(tmpRoot, 'straggler-root');
    const target = join(root, 'artifacts');
    await mkdir(target, { recursive: true });

    // ENOTEMPTY only lands when a file appears between readdir and rmdir, so
    // seed enough entries that the removal walk spans several refill ticks.
    const seedFiles = 1500;
    await Promise.all(
      Array.from({ length: seedFiles }, (_, i) =>
        writeFile(join(target, `seed-${i}.txt`), 'x'),
      ),
    );

    // Both caps are real: the file ceiling normally fires first (~450ms), the
    // wall-clock cutoff backstops it. Either way the writer is quiet long
    // before the shipped budget runs out, so no straggler can outlive the case
    // or outrun the retries.
    const REFILL_TICK_MS = 5;
    const REFILL_CEILING = 90;
    const REFILL_BUDGET_MS = 600;
    let written = 0;
    let stopRefill = () => {};
    const refillStopped = new Promise<void>((resolve) => {
      const timer = setInterval(() => {
        written += 1;
        if (written > REFILL_CEILING) {
          stopRefill();
          return;
        }
        // Once the tree is gone these reject with ENOENT; a successful removal
        // must not be turned into an unhandled rejection.
        writeFile(join(target, `refill-${written}.txt`), 'x').catch(() => {});
      }, REFILL_TICK_MS);
      const cutoff = setTimeout(() => stopRefill(), REFILL_BUDGET_MS);
      // The executor is synchronous, so both timers exist before either
      // callback can fire and stopRefill is the real stop by then.
      stopRefill = () => {
        clearInterval(timer);
        clearTimeout(cutoff);
        resolve();
      };
    });

    try {
      await removeScratchDir(root);
      await refillStopped;
      // The load-bearing assertion: removeScratchDir swallows every rejection,
      // so a resolved promise alone is equally green at maxRetries: 0.
      expect(existsSync(root)).toBe(false);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      stopRefill();
      await rm(root, { recursive: true, force: true });
    }
  });
});
