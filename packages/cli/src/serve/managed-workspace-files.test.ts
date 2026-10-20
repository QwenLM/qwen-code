/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readWorkspaceFiles } from './managed-workspace-files.js';

describe('Managed Workspace file snapshots', () => {
  let root: string;
  let identity: { device: string; inode: string };
  beforeEach(async () => {
    root = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-reference-unit-')),
    );
    const stat = await fs.stat(root, { bigint: true });
    identity = { device: String(stat.dev), inode: String(stat.ino) };
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  const request = (
    operation: string,
    fields: Record<string, unknown> = {},
    cwd = '.',
  ) =>
    readWorkspaceFiles(
      root,
      cwd,
      { protocolVersion: 1, operation, ...fields },
      identity,
    );

  it('browses directories, searches paths and preserves exact UTF-8 including BOM', async () => {
    await fs.mkdir(path.join(root, 'folder with spaces'));
    const text = '\uFEFF你好\r\n  exact\n';
    await fs.writeFile(path.join(root, 'folder with spaces', 'same.ts'), text);
    await fs.writeFile(path.join(root, 'same.ts'), 'different');
    const listing = await request('query');
    expect(listing['entries']).toEqual(
      expect.arrayContaining([
        {
          path: 'folder with spaces',
          name: 'folder with spaces',
          kind: 'directory',
        },
      ]),
    );
    const search = await request('query', { query: 'same.ts' });
    expect(
      (search['entries'] as Array<{ path: string }>)
        .map((entry) => entry.path)
        .sort(),
    ).toEqual(['folder with spaces/same.ts', 'same.ts']);
    const read = await request(
      'read',
      { path: 'same.ts' },
      'folder with spaces',
    );
    expect(read['text']).toBe(text);
    expect(read['byteLength']).toBe(Buffer.byteLength(text));
    expect(read['sha256']).toMatch(/^[a-f0-9]{64}$/);
  });

  it.each([
    '../secret',
    '/etc/passwd',
    'a/../secret',
    'a//b',
    'a\\b',
    '.git/config',
    '.qwen-managed-storage.json',
    '\u0000',
  ])('refuses %s', async (relative) => {
    await expect(request('read', { path: relative })).rejects.toThrow();
  });

  it('refuses symlink files, symlink ancestors, wrong root identity and special files', async () => {
    await fs.writeFile(path.join(root, 'real'), 'text');
    await fs.symlink(path.join(root, 'real'), path.join(root, 'link'));
    await fs.symlink(root, path.join(root, 'alias'));
    await expect(request('read', { path: 'link' })).rejects.toThrow();
    await expect(request('read', { path: 'alias/real' })).rejects.toThrow();
    await expect(request('read', { path: '.' })).rejects.toThrow();
    identity = { ...identity, inode: '0' };
    await expect(request('query')).rejects.toThrow();
  });

  it.each([
    Buffer.alloc(0),
    Buffer.from([0xff]),
    Buffer.from('a\0b'),
    Buffer.alloc(24577, 97),
  ])('refuses unsupported content %#', async (bytes) => {
    await fs.writeFile(path.join(root, 'input'), bytes);
    await expect(request('read', { path: 'input' })).rejects.toThrow();
  });

  it('bounds both directory results and escaped snapshot bytes', async () => {
    await Promise.all(
      Array.from({ length: 60 }, (_, n) =>
        fs.writeFile(path.join(root, `${n}.txt`), 'text'),
      ),
    );
    const listing = await request('query');
    expect(listing['truncated']).toBe(true);
    expect(listing['entries']).toHaveLength(50);
    await fs.writeFile(path.join(root, 'escaped.txt'), '\u0001'.repeat(10000));
    await expect(request('read', { path: 'escaped.txt' })).rejects.toThrow(
      'unavailable',
    );
    expect(await fs.readdir(root)).toHaveLength(61);
  });
});
