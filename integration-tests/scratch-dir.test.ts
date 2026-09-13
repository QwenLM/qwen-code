/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
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
});
