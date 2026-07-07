/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { promises as fsp, realpathSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { canonicalizeWorkspaces } from './workspacePaths.js';

const scratches: string[] = [];

async function mkScratch(): Promise<string> {
  const scratch = await fsp.mkdtemp(path.join(os.tmpdir(), 'qwen-wp-'));
  scratches.push(scratch);
  return scratch;
}

afterEach(async () => {
  await Promise.all(
    scratches
      .splice(0)
      .map((scratch) => fsp.rm(scratch, { recursive: true, force: true })),
  );
});

describe('canonicalizeWorkspaces', () => {
  it('deduplicates canonical-equivalent inputs and preserves order', async () => {
    const scratch = await mkScratch();
    const first = path.join(scratch, 'first');
    const second = path.join(scratch, 'second');
    await fsp.mkdir(first);
    await fsp.mkdir(second);
    const firstAlias = path.join(scratch, 'first-alias');
    await fsp.symlink(first, firstAlias, 'dir');

    expect(canonicalizeWorkspaces([firstAlias, second, first])).toEqual([
      realpathSync.native(first),
      realpathSync.native(second),
    ]);
  });

  it('returns an empty array for empty input', () => {
    expect(canonicalizeWorkspaces([])).toEqual([]);
  });
});
