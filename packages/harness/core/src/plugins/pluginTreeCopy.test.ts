/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';

import { copyPluginTree } from './pluginTreeCopy.js';

const tempDirs: string[] = [];

async function tempDir(label: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `plugin-copy-${label}-`));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) =>
      rm(dir, { recursive: true, force: true }),
    ),
  );
});

describe.skipIf(process.platform === 'win32')('copyPluginTree', () => {
  it('rewrites an internal directory symlink into the destination tree', async () => {
    const root = await tempDir('internal');
    const source = join(root, 'source');
    const destination = join(root, 'destination');
    await mkdir(join(source, 'skills'), { recursive: true });
    await mkdir(join(source, 'shared'), { recursive: true });
    await writeFile(join(source, 'shared', 'SKILL.md'), 'internal');
    await symlink('../shared', join(source, 'skills', 'linked'));

    const result = await copyPluginTree(source, destination);

    expect(result).toEqual({
      rewrittenSymlinks: 1,
      materializedSymlinks: 0,
      skippedSymlinks: 0,
    });
    expect(isAbsolute(await readlink(join(destination, 'skills', 'linked')))).toBe(
      false,
    );
    expect(await realpath(join(destination, 'skills', 'linked'))).toBe(
      await realpath(join(destination, 'shared')),
    );

    await rm(source, { recursive: true, force: true });
    await expect(
      readFile(join(destination, 'skills', 'linked', 'SKILL.md'), 'utf-8'),
    ).resolves.toBe('internal');
  });

  it('materializes a shared target inside the containment root', async () => {
    const root = await tempDir('shared');
    const source = join(root, 'plugins', 'demo');
    const shared = join(root, 'shared', 'skill');
    const destination = join(root, 'cache');
    await mkdir(join(source, 'skills'), { recursive: true });
    await mkdir(shared, { recursive: true });
    await writeFile(join(shared, 'SKILL.md'), 'shared');
    await symlink('../../../shared/skill', join(source, 'skills', 'linked'));

    const result = await copyPluginTree(source, destination, {
      containmentRoot: root,
    });

    expect(result).toEqual({
      rewrittenSymlinks: 0,
      materializedSymlinks: 1,
      skippedSymlinks: 0,
    });
    expect((await lstat(join(destination, 'skills', 'linked'))).isDirectory()).toBe(
      true,
    );

    await rm(join(root, 'plugins'), { recursive: true, force: true });
    await rm(join(root, 'shared'), { recursive: true, force: true });
    await expect(
      readFile(join(destination, 'skills', 'linked', 'SKILL.md'), 'utf-8'),
    ).resolves.toBe('shared');
  });

  it('skips a symlink whose target escapes the containment root', async () => {
    const root = await tempDir('outside');
    const external = await tempDir('external');
    const source = join(root, 'source');
    const destination = join(root, 'destination');
    await mkdir(join(source, 'skills'), { recursive: true });
    await writeFile(join(external, 'SKILL.md'), 'external');
    await symlink(external, join(source, 'skills', 'linked'));

    const result = await copyPluginTree(source, destination);

    expect(result.skippedSymlinks).toBe(1);
    await expect(lstat(join(destination, 'skills', 'linked'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('skips broken and cyclic symlinks', async () => {
    const root = await tempDir('invalid');
    const source = join(root, 'source');
    const destination = join(root, 'destination');
    await mkdir(join(source, 'nested'), { recursive: true });
    await symlink('missing', join(source, 'broken'));
    await symlink('..', join(source, 'nested', 'back'));

    const result = await copyPluginTree(source, destination);

    expect(result.skippedSymlinks).toBe(2);
    await expect(lstat(join(destination, 'broken'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(lstat(join(destination, 'nested', 'back'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('rejects a source root outside its declared containment root', async () => {
    const source = await tempDir('source-outside');
    const containment = await tempDir('containment');
    const destination = join(containment, 'destination');

    await expect(
      copyPluginTree(source, destination, { containmentRoot: containment }),
    ).rejects.toThrow('resolves outside containment root');
  });
});
