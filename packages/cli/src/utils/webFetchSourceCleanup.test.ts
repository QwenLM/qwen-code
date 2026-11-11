/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { cleanupWebFetchSources } from './sessionCleanup.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, unlink: vi.fn(actual.unlink) };
});

const DAY = 86400000;
describe('WebFetch source cleanup', () => {
  let root: string;
  const now = Math.floor(Date.now() / 1000) * 1000;
  beforeEach(async () => {
    vi.mocked(fs.unlink).mockImplementation(
      (await vi.importActual<typeof fs>('node:fs/promises')).unlink,
    );
    root = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), 'webfetch-cleanup-')),
    );
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(root, { recursive: true, force: true });
  });
  async function source(
    project = 'project',
    age = 8 * DAY,
    name = `webfetch-${randomUUID()}.md`,
  ) {
    const file = path.join(
      root,
      'tmp',
      project,
      'tool-outputs',
      'session-source',
      name,
    );
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, 'body');
    await fs.utimes(file, new Date(now - age), new Date(now - age));
    return file;
  }

  it('cleans only expired page files across projects, regardless of legacy live owners', async () => {
    const old = await source();
    const other = await source('other');
    const boundary = await source('project', 7 * DAY);
    const recent = await source('project', 6 * DAY);
    const unrelated = await source('project', 8 * DAY, 'shell-output.txt');
    const owner = path.join(
      root,
      '.webfetch-source-maintenance',
      'sessions',
      'source',
    );
    await fs.mkdir(owner, { recursive: true });
    await fs.writeFile(path.join(owner, `${process.pid}-legacy`), '');
    expect(await cleanupWebFetchSources(root, now)).toMatchObject({
      deleted: 2,
      failed: 0,
    });
    for (const file of [old, other])
      await expect(fs.stat(file)).rejects.toMatchObject({ code: 'ENOENT' });
    for (const file of [boundary, recent, unrelated, path.dirname(old)])
      await expect(fs.stat(file)).resolves.toBeDefined();
  });

  it('tolerates an absent temp directory and creates no maintenance metadata', async () => {
    expect(await cleanupWebFetchSources(root, now)).toMatchObject({
      deleted: 0,
      failed: 0,
    });
    expect(await fs.readdir(root)).toEqual([]);
  });

  it('continues after deletion failure and reports failure for startup retry', async () => {
    const failed = await source();
    await source('other');
    const { unlink } = await vi.importActual<typeof fs>('node:fs/promises');
    vi.mocked(fs.unlink).mockImplementation(async (file) => {
      if (file === failed)
        throw Object.assign(new Error('denied'), { code: 'EACCES' });
      await unlink(file);
    });
    expect(await cleanupWebFetchSources(root, now)).toMatchObject({
      deleted: 1,
      failed: 1,
    });
    await expect(fs.stat(failed)).resolves.toBeDefined();
  });

  it.skipIf(process.platform === 'win32')(
    'allows a linked config root but skips child directory and file links',
    async () => {
      const outside = await fs.mkdtemp(
        path.join(os.tmpdir(), 'webfetch-outside-'),
      );
      const alias = `${root}-alias`;
      try {
        const old = await source();
        const external = path.join(outside, `webfetch-${randomUUID()}.md`);
        await fs.writeFile(external, 'external');
        await fs.utimes(
          external,
          new Date(now - 8 * DAY),
          new Date(now - 8 * DAY),
        );
        await fs.symlink(outside, path.join(root, 'tmp', 'linked-project'));
        await fs.symlink(
          outside,
          path.join(root, 'tmp', 'project', 'tool-outputs', 'session-linked'),
        );
        await fs.mkdir(path.join(root, 'tmp', 'linked-outputs'));
        await fs.symlink(
          outside,
          path.join(root, 'tmp', 'linked-outputs', 'tool-outputs'),
        );
        await fs.symlink(
          external,
          path.join(path.dirname(old), `webfetch-${randomUUID()}.md`),
        );
        await fs.symlink(root, alias);
        expect(await cleanupWebFetchSources(alias, now)).toMatchObject({
          deleted: 1,
          failed: 0,
        });
        expect(await fs.readFile(external, 'utf8')).toBe('external');
        // Even the tmp directory itself must not redirect the scan.
        await fs.rename(path.join(root, 'tmp'), path.join(root, 'saved-tmp'));
        await fs.symlink(path.join(root, 'saved-tmp'), path.join(root, 'tmp'));
        expect(await cleanupWebFetchSources(root, now)).toMatchObject({
          deleted: 0,
          failed: 0,
        });
      } finally {
        await fs.unlink(alias).catch(() => {});
        await fs.rm(outside, { recursive: true, force: true });
      }
    },
  );
});
