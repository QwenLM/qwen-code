/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { promises as fsp, realpathSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import {
  resolveBoundWorkspacesFromIdeEnv,
  resolveBridgeFsFactory,
} from './fs-factory.js';

const scratches: string[] = [];

async function mkScratch(): Promise<string> {
  const scratch = await fsp.mkdtemp(
    path.join(
      os.tmpdir(),
      `qwen-fs-factory-${randomBytes(4).toString('hex')}-`,
    ),
  );
  scratches.push(scratch);
  return scratch;
}

afterEach(async () => {
  await Promise.all(
    scratches.splice(0).map((scratch) =>
      fsp.rm(scratch, { recursive: true, force: true }),
    ),
  );
});

describe('resolveBoundWorkspacesFromIdeEnv', () => {
  it('keeps the selected workspace first and includes the other IDE roots', async () => {
    const scratch = await mkScratch();
    const first = path.join(scratch, 'first');
    const second = path.join(scratch, 'second');
    await fsp.mkdir(first);
    await fsp.mkdir(second);

    const roots = resolveBoundWorkspacesFromIdeEnv(
      second,
      [first, second].join(path.delimiter),
    );

    expect(roots).toEqual([
      realpathSync.native(second),
      realpathSync.native(first),
    ]);
  });

  it('ignores a stale IDE workspace env that does not contain the primary workspace', async () => {
    const scratch = await mkScratch();
    const primary = path.join(scratch, 'primary');
    const stale = path.join(scratch, 'stale');
    await fsp.mkdir(primary);
    await fsp.mkdir(stale);

    const roots = resolveBoundWorkspacesFromIdeEnv(primary, stale);

    expect(roots).toEqual([realpathSync.native(primary)]);
  });

  it('preserves path characters instead of trimming workspace segments', async () => {
    const scratch = await mkScratch();
    const primary = path.join(scratch, ' leading-space');
    await fsp.mkdir(primary);

    const roots = resolveBoundWorkspacesFromIdeEnv(primary, primary);

    expect(roots).toEqual([realpathSync.native(primary)]);
  });

  it('passes nested IDE roots through so registration rejects them loudly', async () => {
    const scratch = await mkScratch();
    const parent = path.join(scratch, 'parent');
    const child = path.join(parent, 'child');
    await fsp.mkdir(child, { recursive: true });

    const roots = resolveBoundWorkspacesFromIdeEnv(
      parent,
      [parent, child].join(path.delimiter),
    );

    expect(roots).toEqual([
      realpathSync.native(parent),
      realpathSync.native(child),
    ]);
    expect(() =>
      resolveBridgeFsFactory({
        boundWorkspaces: roots,
        trusted: true,
        emit: () => undefined,
      }),
    ).toThrow(/nested/i);
  });
});
