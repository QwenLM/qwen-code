/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import * as tar from 'tar';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ManagedExtensionCache } from './managed-extension-cache.js';

let temporary: string;
beforeEach(async () => {
  temporary = await fs.mkdtemp(
    path.join(os.tmpdir(), 'managed-package-cache-'),
  );
});
afterEach(async () => {
  await fs.rm(temporary, { force: true, recursive: true });
});

async function archive(link = false) {
  const source = path.join(temporary, 'source');
  await fs.mkdir(source);
  await fs.writeFile(
    path.join(source, 'qwen-extension.json'),
    '{"name":"test"}',
  );
  await fs.mkdir(path.join(source, 'skills'));
  await fs.writeFile(path.join(source, 'skills', 'script.sh'), 'echo test');
  if (link) await fs.symlink('/etc/passwd', path.join(source, 'outside'));
  const file = path.join(temporary, 'package.tar.gz');
  await tar.c({ cwd: source, file, gzip: true }, ['.']);
  const bytes = await fs.readFile(file);
  return { bytes, digest: createHash('sha256').update(bytes).digest('hex') };
}

describe('ManagedExtensionCache', () => {
  it('retains full package resources and never replaces another materialization', async () => {
    const { bytes, digest } = await archive();
    const cache = new ManagedExtensionCache(path.join(temporary, 'cache'));
    await cache.upload(digest, Readable.from(bytes));
    const first = await cache.materialize(digest);
    expect(
      await fs.readFile(path.join(first, 'skills/script.sh'), 'utf8'),
    ).toBe('echo test');
    const [concurrentA, concurrentB] = await Promise.all([
      cache.materialize(digest),
      cache.materialize(digest),
    ]);
    expect(concurrentA).not.toBe(concurrentB);
    const second = await cache.materialize(digest);
    expect(second).not.toBe(first);
    expect(
      await fs.readFile(path.join(first, 'skills/script.sh'), 'utf8'),
    ).toBe('echo test');
  });

  it('repairs missing or drifted assets at the identical path only from a verified archive', async () => {
    const { bytes, digest } = await archive();
    const cache = new ManagedExtensionCache(path.join(temporary, 'cache'));
    await cache.upload(digest, Readable.from(bytes));
    const pinned = await cache.materialize(digest);
    await fs.rm(pinned, { recursive: true });
    await cache.restoreMaterialized(digest, pinned);
    await expect(
      cache.verifyMaterialized(digest, pinned),
    ).resolves.toBeUndefined();
    await fs.writeFile(path.join(pinned, 'skills/script.sh'), 'changed');
    await expect(cache.verifyMaterialized(digest, pinned)).rejects.toThrow(
      'drifted',
    );
    await cache.restoreMaterialized(digest, pinned);
    expect(
      await fs.readFile(path.join(pinned, 'skills/script.sh'), 'utf8'),
    ).toBe('echo test');
    const sibling = await cache.materialize(digest);
    await fs.writeFile(path.join(pinned, 'skills/script.sh'), 'changed again');
    await fs.writeFile(
      path.join(cache.directory, `${digest}.tar.gz`),
      'corrupt',
    );
    await expect(cache.restoreMaterialized(digest, pinned)).rejects.toThrow(
      'digest',
    );
    expect(
      await fs.readFile(path.join(pinned, 'skills/script.sh'), 'utf8'),
    ).toBe('changed again');
    await expect(
      cache.verifyMaterialized(digest, sibling),
    ).resolves.toBeUndefined();
    const outside = path.join(temporary, `${digest}-${'a'.repeat(36)}`);
    await fs.mkdir(outside);
    await expect(cache.restoreMaterialized(digest, outside)).rejects.toThrow(
      'scope',
    );
    expect(await fs.stat(outside)).toBeDefined();
  });

  it('rejects corrupt uploads without leaving a cache artifact', async () => {
    const { bytes } = await archive();
    const cachePath = path.join(temporary, 'cache');
    const cache = new ManagedExtensionCache(cachePath);
    await expect(
      cache.upload('0'.repeat(64), Readable.from(bytes)),
    ).rejects.toThrow('digest');
    expect(await fs.readdir(cachePath)).toEqual([]);
  });

  it('rejects links before materializing a directory', async () => {
    const { bytes, digest } = await archive(true);
    const cachePath = path.join(temporary, 'cache');
    const cache = new ManagedExtensionCache(cachePath);
    await expect(cache.upload(digest, Readable.from(bytes))).rejects.toThrow();
    expect(await fs.readdir(cachePath)).toEqual([]);
  });

  it('cleans up an interrupted stream', async () => {
    const cachePath = path.join(temporary, 'cache');
    const cache = new ManagedExtensionCache(cachePath);
    const stream = Readable.from(
      (async function* () {
        yield Buffer.from('partial');
        throw new Error('disconnected');
      })(),
    );
    await expect(cache.upload('0'.repeat(64), stream)).rejects.toThrow(
      'disconnected',
    );
    expect(await fs.readdir(cachePath)).toEqual([]);
  });
});
