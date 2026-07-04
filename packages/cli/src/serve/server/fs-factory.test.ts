/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { promises as fsp, realpathSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveBoundWorkspacesFromIdeEnv } from './fs-factory.js';

const scratches: string[] = [];

async function mkScratch(): Promise<string> {
  const scratch = await fsp.mkdtemp(path.join(os.tmpdir(), 'qwen-fs-factory-'));
  scratches.push(scratch);
  return scratch;
}

async function mkdirs<const Names extends readonly string[]>(
  scratch: string,
  ...names: Names
): Promise<Record<Names[number], string>> {
  const out = {} as Record<Names[number], string>;
  for (const name of names) {
    const dir = path.join(scratch, name);
    await fsp.mkdir(dir, { recursive: true });
    out[name as Names[number]] = dir;
  }
  return out;
}

afterEach(async () => {
  await Promise.all(
    scratches
      .splice(0)
      .map((scratch) => fsp.rm(scratch, { recursive: true, force: true })),
  );
});

describe('resolveBoundWorkspacesFromIdeEnv', () => {
  it('keeps the selected workspace first for legacy and JSON encoded roots', async () => {
    const scratch = await mkScratch();
    const dirs = await mkdirs(scratch, 'first', 'second');
    const withDelimiter = path.join(scratch, `tool${path.delimiter}chain`);
    await fsp.mkdir(withDelimiter);

    expect(
      resolveBoundWorkspacesFromIdeEnv(
        dirs.second,
        [dirs.first, dirs.second].join(path.delimiter),
      ),
    ).toEqual([
      realpathSync.native(dirs.second),
      realpathSync.native(dirs.first),
    ]);

    expect(
      resolveBoundWorkspacesFromIdeEnv(
        dirs.second,
        JSON.stringify([dirs.second, withDelimiter]),
      ),
    ).toEqual([
      realpathSync.native(dirs.second),
      realpathSync.native(withDelimiter),
    ]);
  });

  it('falls back to the primary workspace for stale or malformed IDE env', async () => {
    const scratch = await mkScratch();
    const dirs = await mkdirs(scratch, 'primary', 'stale');
    const primary = realpathSync.native(dirs.primary);

    expect(resolveBoundWorkspacesFromIdeEnv(dirs.primary, dirs.stale)).toEqual([
      primary,
    ]);
    expect(resolveBoundWorkspacesFromIdeEnv(dirs.primary, '[not json')).toEqual(
      [primary],
    );
    expect(
      resolveBoundWorkspacesFromIdeEnv(dirs.primary, JSON.stringify([1, 2, 3])),
    ).toEqual([primary]);
    expect(
      resolveBoundWorkspacesFromIdeEnv(
        dirs.primary,
        JSON.stringify(['relative']),
      ),
    ).toEqual([primary]);
  });

  it('drops env parents without losing sibling roots', async () => {
    const scratch = await mkScratch();
    const parent = path.join(scratch, 'parent');
    const primary = path.join(parent, 'primary');
    const sibling = path.join(parent, 'sibling');
    await fsp.mkdir(primary, { recursive: true });
    await fsp.mkdir(sibling);

    expect(
      resolveBoundWorkspacesFromIdeEnv(
        primary,
        [parent, sibling].join(path.delimiter),
      ),
    ).toEqual([realpathSync.native(primary), realpathSync.native(sibling)]);
  });
});
