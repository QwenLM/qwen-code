/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import {
  WorkspaceRegistrationStore,
  WorkspaceRegistrationStoreError,
  getWorkspaceRegistrationStorePath,
  workspaceRegistrationScopeHash,
} from './workspace-registration-store.js';

const cleanup: string[] = [];

async function tempHome(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(tmpdir(), 'qwen-workspace-store-'));
  cleanup.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(
    cleanup
      .splice(0)
      .map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

describe('WorkspaceRegistrationStore', () => {
  it('uses a full stable scope hash and returns an empty missing store', async () => {
    const home = await tempHome();
    const hash = workspaceRegistrationScopeHash('/work/primary');
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    expect(getWorkspaceRegistrationStorePath('/work/primary', home)).toBe(
      path.join(home, 'daemon', 'workspaces', `${hash}.json`),
    );
    await expect(
      new WorkspaceRegistrationStore('/work/primary', home).read(),
    ).resolves.toEqual({
      schemaVersion: 1,
      primaryWorkspace: '/work/primary',
      workspaces: [],
    });
  });

  it('persists, deduplicates, and removes workspace paths', async () => {
    const home = await tempHome();
    const store = new WorkspaceRegistrationStore('/work/primary', home);
    await expect(store.add('/work/secondary')).resolves.toBe(true);
    await expect(store.add('/work/secondary')).resolves.toBe(false);
    await expect(store.read()).resolves.toMatchObject({
      workspaces: ['/work/secondary'],
    });
    if (process.platform !== 'win32') {
      expect((await fs.stat(store.filePath)).mode & 0o777).toBe(0o600);
    }
    const id = createHashForTest('/work/secondary');
    await expect(store.removeById(id)).resolves.toBe(true);
    await expect(store.read()).resolves.toMatchObject({ workspaces: [] });
  });

  it('rejects invalid primary and primary-as-secondary inputs', async () => {
    const home = await tempHome();
    expect(() => new WorkspaceRegistrationStore('relative', home)).toThrow(
      /primaryWorkspace must be an absolute path/,
    );
    const store = new WorkspaceRegistrationStore('/work/primary', home);
    await expect(store.add('/work/primary')).rejects.toThrow(
      /Primary workspace cannot be stored/,
    );
    await expect(fs.stat(store.filePath)).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('serializes concurrent updates without losing either workspace', async () => {
    const home = await tempHome();
    const first = new WorkspaceRegistrationStore('/work/primary', home);
    const second = new WorkspaceRegistrationStore('/work/primary', home);
    await Promise.all([
      first.add('/work/secondary-a'),
      second.add('/work/secondary-b'),
    ]);
    expect((await first.read()).workspaces.sort()).toEqual([
      '/work/secondary-a',
      '/work/secondary-b',
    ]);
  });

  it('refuses a malformed store without overwriting it', async () => {
    const home = await tempHome();
    const store = new WorkspaceRegistrationStore('/work/primary', home);
    await fs.mkdir(path.dirname(store.filePath), { recursive: true });
    await fs.writeFile(store.filePath, '{broken', 'utf8');
    await expect(store.add('/work/secondary')).rejects.toBeInstanceOf(
      WorkspaceRegistrationStoreError,
    );
    expect(await fs.readFile(store.filePath, 'utf8')).toBe('{broken');
  });

  it('refuses a primary-scope mismatch without overwriting it', async () => {
    const home = await tempHome();
    const store = new WorkspaceRegistrationStore('/work/primary', home);
    await fs.mkdir(path.dirname(store.filePath), { recursive: true });
    const mismatched = JSON.stringify({
      schemaVersion: 1,
      primaryWorkspace: '/work/different-primary',
      workspaces: ['/work/secondary'],
    });
    await fs.writeFile(store.filePath, mismatched, 'utf8');

    await expect(store.add('/work/other')).rejects.toThrow(
      /primary does not match/,
    );
    expect(await fs.readFile(store.filePath, 'utf8')).toBe(mismatched);
  });

  it('rejects a symlink store', async () => {
    const home = await tempHome();
    const store = new WorkspaceRegistrationStore('/work/primary', home);
    await fs.mkdir(path.dirname(store.filePath), { recursive: true });
    const target = path.join(home, 'target.json');
    await fs.writeFile(target, '{}');
    await fs.symlink(target, store.filePath);
    await expect(store.read()).rejects.toThrow(/regular file/);
  });

  it('rejects an oversized store', async () => {
    const home = await tempHome();
    const store = new WorkspaceRegistrationStore('/work/primary', home);
    await fs.mkdir(path.dirname(store.filePath), { recursive: true });
    await fs.writeFile(store.filePath, Buffer.alloc(256 * 1024 + 1));
    await expect(store.read()).rejects.toThrow(/exceeds 262144 bytes/);
  });

  it('recovers an orphaned stale lock', async () => {
    const home = await tempHome();
    const store = new WorkspaceRegistrationStore('/work/primary', home);
    const lockPath = `${store.filePath}.lock`;
    await fs.mkdir(lockPath, { recursive: true });
    const staleTime = new Date(Date.now() - 20_000);
    await fs.utimes(lockPath, staleTime, staleTime);

    await expect(store.add('/work/secondary')).resolves.toBe(true);
    await expect(fs.stat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

function createHashForTest(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}
