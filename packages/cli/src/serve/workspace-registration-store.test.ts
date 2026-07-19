/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  WorkspaceRegistrationStore,
  WorkspaceRegistrationStoreError,
  WorkspaceDisplayNameValidationError,
  getWorkspaceRegistrationStorePath,
  normalizeWorkspaceDisplayName,
  workspaceRegistrationId,
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
    const id = workspaceRegistrationId('/work/secondary');
    await expect(store.removeById(id)).resolves.toBe(true);
    await expect(store.read()).resolves.toMatchObject({ workspaces: [] });
  });

  it('reads legacy snapshots without display names', async () => {
    const home = await tempHome();
    const store = new WorkspaceRegistrationStore('/work/primary', home);
    await fs.mkdir(path.dirname(store.filePath), { recursive: true });
    await fs.writeFile(
      store.filePath,
      JSON.stringify({
        schemaVersion: 1,
        primaryWorkspace: '/work/primary',
        workspaces: ['/work/secondary'],
      }),
    );

    await expect(store.read()).resolves.toEqual({
      schemaVersion: 1,
      primaryWorkspace: '/work/primary',
      workspaces: ['/work/secondary'],
    });
  });

  it('stores a display name when adding a registration', async () => {
    const home = await tempHome();
    const store = new WorkspaceRegistrationStore('/work/primary', home);
    const id = workspaceRegistrationId('/work/secondary');

    await expect(store.add('/work/secondary', 'Secondary')).resolves.toBe(true);
    await expect(store.read()).resolves.toMatchObject({
      workspaces: ['/work/secondary'],
      displayNames: { [id]: 'Secondary' },
    });

    await expect(store.add('/work/secondary', 'Renamed')).resolves.toBe(false);
    await expect(store.add('/work/secondary')).resolves.toBe(false);
    await expect(store.add('/work/secondary', '')).resolves.toBe(false);
    await expect(store.read()).resolves.toMatchObject({
      displayNames: { [id]: 'Secondary' },
    });
  });

  it('removes display names with their registrations', async () => {
    const home = await tempHome();
    const store = new WorkspaceRegistrationStore('/work/primary', home);
    const firstId = workspaceRegistrationId('/work/secondary-a');
    const secondId = workspaceRegistrationId('/work/secondary-b');
    await store.add('/work/secondary-a', 'First');
    await store.add('/work/secondary-b', 'Second');

    await expect(store.removeById(firstId)).resolves.toBe(true);
    await expect(store.read()).resolves.toMatchObject({
      workspaces: ['/work/secondary-b'],
      displayNames: { [secondId]: 'Second' },
    });
    await expect(store.removeById(secondId)).resolves.toBe(true);
    await expect(store.read()).resolves.toEqual({
      schemaVersion: 1,
      primaryWorkspace: '/work/primary',
      workspaces: [],
    });
  });

  it('normalizes empty display names and rejects invalid values', () => {
    expect(normalizeWorkspaceDisplayName('')).toBeUndefined();
    expect(normalizeWorkspaceDisplayName('   ')).toBeUndefined();
    expect(normalizeWorkspaceDisplayName('  Workspace  ')).toBe('Workspace');
    expect(normalizeWorkspaceDisplayName('x'.repeat(256))).toBe(
      'x'.repeat(256),
    );
    for (const invalid of [
      'x'.repeat(257),
      'line\nbreak',
      'nul\0byte',
      `delete${String.fromCharCode(0x7f)}`,
      42,
    ]) {
      expect(() => normalizeWorkspaceDisplayName(invalid)).toThrow(
        WorkspaceDisplayNameValidationError,
      );
    }
  });

  it('returns false when removing a missing workspace id', async () => {
    const home = await tempHome();
    const store = new WorkspaceRegistrationStore('/work/primary', home);
    await expect(store.add('/work/secondary')).resolves.toBe(true);
    await expect(store.removeById('missing')).resolves.toBe(false);
    await expect(store.read()).resolves.toMatchObject({
      workspaces: ['/work/secondary'],
    });
  });

  it.skipIf(process.platform !== 'win32')(
    'deduplicates workspace paths case-insensitively on Windows',
    async () => {
      const home = await tempHome();
      const store = new WorkspaceRegistrationStore('C:\\work\\primary', home);
      await expect(store.add('C:\\Work\\Secondary')).resolves.toBe(true);
      await expect(store.add('c:\\work\\secondary')).resolves.toBe(false);
      await expect(store.read()).resolves.toMatchObject({
        workspaces: ['C:\\Work\\Secondary'],
      });
    },
  );

  it('removes multiple raw and canonical registration identities atomically', async () => {
    const home = await tempHome();
    const store = new WorkspaceRegistrationStore('/work/primary', home);
    await store.add('/work/raw-alias-a');
    await store.add('/work/raw-alias-b');
    await store.add('/work/other');

    await expect(
      store.removeByIds([
        workspaceRegistrationId('/work/raw-alias-a'),
        workspaceRegistrationId('/work/raw-alias-b'),
        'missing',
      ]),
    ).resolves.toBe(2);
    await expect(store.read()).resolves.toMatchObject({
      workspaces: ['/work/other'],
    });
    await expect(store.removeByIds([])).resolves.toBe(0);
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

  it('rejects unknown schema versions and duplicate entries', async () => {
    const home = await tempHome();
    const store = new WorkspaceRegistrationStore('/work/primary', home);
    await fs.mkdir(path.dirname(store.filePath), { recursive: true });
    await fs.writeFile(
      store.filePath,
      JSON.stringify({
        schemaVersion: 2,
        primaryWorkspace: '/work/primary',
        workspaces: [],
      }),
    );
    await expect(store.read()).rejects.toThrow(/Unsupported.*schema 2/);

    await fs.writeFile(
      store.filePath,
      JSON.stringify({
        schemaVersion: 1,
        primaryWorkspace: '/work/primary',
        workspaces: ['/work/secondary', '/work/secondary'],
      }),
    );
    await expect(store.read()).rejects.toThrow(/duplicate paths/);
  });

  it.each([
    ['a non-object map', [], /displayNames must be an object/],
    [
      'an unknown registration id',
      { missing: 'Name' },
      /unknown registration id/,
    ],
    [
      'an empty stored name',
      { [workspaceRegistrationId('/work/secondary')]: '' },
      /must not be empty/,
    ],
    [
      'a non-string stored name',
      { [workspaceRegistrationId('/work/secondary')]: 42 },
      /must be a string/,
    ],
    [
      'an oversized stored name',
      { [workspaceRegistrationId('/work/secondary')]: 'x'.repeat(257) },
      /exceeds 256 characters/,
    ],
    [
      'a stored name with control characters',
      { [workspaceRegistrationId('/work/secondary')]: 'line\nbreak' },
      /control characters/,
    ],
  ])(
    'rejects displayNames with %s',
    async (_description, displayNames, error) => {
      const home = await tempHome();
      const store = new WorkspaceRegistrationStore('/work/primary', home);
      await fs.mkdir(path.dirname(store.filePath), { recursive: true });
      await fs.writeFile(
        store.filePath,
        JSON.stringify({
          schemaVersion: 1,
          primaryWorkspace: '/work/primary',
          workspaces: ['/work/secondary'],
          displayNames,
        }),
      );

      await expect(store.read()).rejects.toThrow(error);
    },
  );

  it('rejects additions after reaching the secondary workspace limit', async () => {
    const home = await tempHome();
    const store = new WorkspaceRegistrationStore('/work/primary', home);
    await fs.mkdir(path.dirname(store.filePath), { recursive: true });
    const workspaces = Array.from(
      { length: 24 },
      (_, index) => `/work/secondary-${index}`,
    );
    await fs.writeFile(
      store.filePath,
      JSON.stringify({
        schemaVersion: 1,
        primaryWorkspace: '/work/primary',
        workspaces,
      }),
    );

    await expect(store.add('/work/overflow')).rejects.toThrow(
      /limit of 24 reached/,
    );
    await expect(store.read()).resolves.toMatchObject({ workspaces });
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

  it('reports lock release failure after a committed write', async () => {
    const home = await tempHome();
    vi.resetModules();
    vi.doMock('proper-lockfile', () => ({
      default: {
        lock: vi.fn(async () => async () => {
          throw new Error('release failed');
        }),
      },
    }));
    try {
      const storeModule = await import('./workspace-registration-store.js');
      const store = new storeModule.WorkspaceRegistrationStore(
        '/work/primary',
        home,
      );
      await fs.mkdir(path.dirname(store.filePath), { recursive: true });
      await fs.writeFile(
        store.filePath,
        JSON.stringify({
          schemaVersion: 1,
          primaryWorkspace: '/work/primary',
          workspaces: ['/work/secondary'],
          displayNames: {
            [storeModule.workspaceRegistrationId('/work/secondary')]:
              'Secondary',
          },
        }),
      );

      await expect(
        store.removeByIds([
          storeModule.workspaceRegistrationId('/work/secondary'),
        ]),
      ).rejects.toBeInstanceOf(
        storeModule.WorkspaceRegistrationStoreCommittedError,
      );
      expect(
        JSON.parse(await fs.readFile(store.filePath, 'utf8')),
      ).toMatchObject({ workspaces: [] });
      expect(
        JSON.parse(await fs.readFile(store.filePath, 'utf8')),
      ).not.toHaveProperty('displayNames');
    } finally {
      vi.doUnmock('proper-lockfile');
      vi.resetModules();
    }
  });

  it('preserves the write failure when lock release also fails', async () => {
    const home = await tempHome();
    const writeError = new Error('write failed');
    const releaseError = new Error('release failed');
    vi.resetModules();
    vi.doMock('proper-lockfile', () => ({
      default: {
        lock: vi.fn(async () => async () => {
          throw releaseError;
        }),
      },
    }));
    vi.doMock('@qwen-code/qwen-code-core', () => ({
      atomicWriteFile: vi.fn().mockRejectedValue(writeError),
    }));
    try {
      const storeModule = await import('./workspace-registration-store.js');
      const store = new storeModule.WorkspaceRegistrationStore(
        '/work/primary',
        home,
      );
      await fs.mkdir(path.dirname(store.filePath), { recursive: true });
      await fs.writeFile(
        store.filePath,
        JSON.stringify({
          schemaVersion: 1,
          primaryWorkspace: '/work/primary',
          workspaces: ['/work/secondary'],
        }),
      );

      await expect(
        store.removeByIds([
          storeModule.workspaceRegistrationId('/work/secondary'),
        ]),
      ).rejects.toBe(writeError);
      expect(writeError.cause).toBe(releaseError);
    } finally {
      vi.doUnmock('proper-lockfile');
      vi.doUnmock('@qwen-code/qwen-code-core');
      vi.resetModules();
    }
  });
});
