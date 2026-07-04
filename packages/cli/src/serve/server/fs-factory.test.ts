/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { promises as fsp, realpathSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
    scratches
      .splice(0)
      .map((scratch) => fsp.rm(scratch, { recursive: true, force: true })),
  );
  vi.restoreAllMocks();
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

  it('accepts JSON encoded IDE roots without splitting path delimiters', async () => {
    const scratch = await mkScratch();
    const primary = path.join(scratch, 'primary');
    const withDelimiter = path.join(scratch, `tool${path.delimiter}chain`);
    await fsp.mkdir(primary);
    await fsp.mkdir(withDelimiter);

    const roots = resolveBoundWorkspacesFromIdeEnv(
      primary,
      JSON.stringify([primary, withDelimiter]),
    );

    expect(roots).toEqual([
      realpathSync.native(primary),
      realpathSync.native(withDelimiter),
    ]);
  });

  it('ignores a stale IDE workspace env that does not contain the primary workspace', async () => {
    const scratch = await mkScratch();
    const primary = path.join(scratch, 'primary');
    const stale = path.join(scratch, 'stale');
    await fsp.mkdir(primary);
    await fsp.mkdir(stale);
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    const roots = resolveBoundWorkspacesFromIdeEnv(primary, stale);

    expect(roots).toEqual([realpathSync.native(primary)]);
    expect(stderr).toHaveBeenCalledWith(
      expect.stringContaining('ignoring stale IDE workspace paths'),
    );
  });

  it('preserves path characters instead of trimming workspace segments', async () => {
    const scratch = await mkScratch();
    const primary = path.join(scratch, ' leading-space');
    await fsp.mkdir(primary);

    const roots = resolveBoundWorkspacesFromIdeEnv(primary, primary);

    expect(roots).toEqual([realpathSync.native(primary)]);
  });

  it('falls back to the primary workspace when IDE env canonicalization fails', async () => {
    const scratch = await mkScratch();
    const primary = path.join(scratch, 'primary');
    await fsp.mkdir(primary);
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    const roots = resolveBoundWorkspacesFromIdeEnv(primary, 'x'.repeat(5000));

    expect(roots).toEqual([realpathSync.native(primary)]);
    expect(stderr).toHaveBeenCalledWith(
      expect.stringContaining('failed to canonicalize IDE workspace paths'),
    );
  });

  it('drops nested IDE roots before factory registration', async () => {
    const scratch = await mkScratch();
    const parent = path.join(scratch, 'parent');
    const child = path.join(parent, 'child');
    await fsp.mkdir(child, { recursive: true });

    const roots = resolveBoundWorkspacesFromIdeEnv(
      parent,
      [parent, child].join(path.delimiter),
    );

    expect(roots).toEqual([realpathSync.native(parent)]);
    expect(() =>
      resolveBridgeFsFactory({
        boundWorkspaces: roots,
        trusted: true,
        emit: () => undefined,
      }),
    ).not.toThrow();
  });

  it('drops env child roots when the primary workspace is the parent', async () => {
    const scratch = await mkScratch();
    const parent = path.join(scratch, 'parent');
    const child = path.join(parent, 'child');
    await fsp.mkdir(child, { recursive: true });

    const roots = resolveBoundWorkspacesFromIdeEnv(parent, child);

    expect(roots).toEqual([realpathSync.native(parent)]);
  });
});
