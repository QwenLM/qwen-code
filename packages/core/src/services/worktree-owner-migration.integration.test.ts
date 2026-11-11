/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import nativeFs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  claimWorktreeOwnership,
  inspectWorktreeOwnership,
  releaseWorktreeOwnership,
} from './worktree-owner-state.js';
import { runLogger } from '../utils/runLogger.js';

describe('legacy Hook owner migration', () => {
  let root: string;
  let checkout: string;
  let legacyPath: string;
  let privatePath: string;
  let contents: string;

  beforeEach(async () => {
    root = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), 'owner-migration-')),
    );
    checkout = path.join(root, 'clone');
    execFileSync('git', ['init', '-q', checkout]);
    legacyPath = path.join(checkout, '.qwen-worktree.json');
    privatePath = path.join(checkout, '.git', 'qwen-worktree.json');
    contents = JSON.stringify({
      version: 1,
      ownerSessionId: 'owner',
      originalCwd: root,
    });
    await fs.writeFile(legacyPath, contents);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    syncBuiltinESMExports();
    await fs.rm(root, { recursive: true, force: true });
  });

  it('migrates when the platform rejects syncing a read-only file handle', async () => {
    const open = nativeFs.promises.open;
    vi.spyOn(nativeFs.promises, 'open').mockImplementation(async (...args) => {
      const handle = await Reflect.apply(open, nativeFs.promises, args);
      if (args[0] === privatePath && args[1] === 'r') {
        vi.spyOn(handle, 'sync').mockRejectedValue(
          Object.assign(new Error('read-only handle'), { code: 'EPERM' }),
        );
      }
      return handle;
    });
    syncBuiltinESMExports();

    expect(await claimWorktreeOwnership(checkout, 'owner', root)).toBe('owned');
    expect(await fs.readFile(privatePath, 'utf8')).toBe(contents);
    await expect(fs.stat(legacyPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each([
    { target: 'file', code: 'EIO', expected: 'unavailable' },
    ...(process.platform === 'win32'
      ? []
      : [
          { target: 'directory', code: 'EIO', expected: 'unavailable' },
          { target: 'directory', code: 'EINVAL', expected: 'owned' },
        ]),
  ])(
    'handles $target sync $code without losing ownership evidence',
    async ({ target, code, expected }) => {
      const open = nativeFs.promises.open;
      vi.spyOn(nativeFs.promises, 'open').mockImplementation(
        async (...args) => {
          const handle = await Reflect.apply(open, nativeFs.promises, args);
          if (
            args[0] ===
            (target === 'file' ? privatePath : path.dirname(privatePath))
          ) {
            vi.spyOn(handle, 'sync').mockRejectedValue(
              Object.assign(new Error('injected sync failure'), { code }),
            );
          }
          return handle;
        },
      );
      syncBuiltinESMExports();

      expect(await claimWorktreeOwnership(checkout, 'owner', root)).toBe(
        expected,
      );
      if (expected === 'unavailable') {
        expect(await fs.readFile(legacyPath, 'utf8')).toBe(contents);
      } else {
        await expect(fs.stat(legacyPath)).rejects.toMatchObject({
          code: 'ENOENT',
        });
      }
      expect(await fs.readFile(privatePath, 'utf8')).toBe(contents);
      vi.restoreAllMocks();
      syncBuiltinESMExports();
      expect(await claimWorktreeOwnership(checkout, 'owner', root)).toBe(
        'owned',
      );
    },
  );

  it('cleans up only its own failed exclusive copy and permits retry', async () => {
    vi.spyOn(nativeFs.promises, 'link').mockRejectedValue(
      Object.assign(new Error('cross device'), { code: 'EXDEV' }),
    );
    const open = nativeFs.promises.open;
    vi.spyOn(nativeFs.promises, 'open').mockImplementation(async (...args) => {
      const handle = await Reflect.apply(open, nativeFs.promises, args);
      if (args[0] === privatePath && args[1] === 'wx') {
        vi.spyOn(handle, 'writeFile').mockImplementation(async () => {
          await handle.write('{');
          throw Object.assign(new Error('partial write'), { code: 'EIO' });
        });
      }
      return handle;
    });
    syncBuiltinESMExports();

    expect(await claimWorktreeOwnership(checkout, 'owner', root)).toBe(
      'unavailable',
    );
    expect(await fs.readFile(legacyPath, 'utf8')).toBe(contents);
    await expect(fs.stat(privatePath)).rejects.toMatchObject({
      code: 'ENOENT',
    });
    vi.restoreAllMocks();
    syncBuiltinESMExports();
    expect(await claimWorktreeOwnership(checkout, 'owner', root)).toBe('owned');
  });

  it('preserves an unidentified truncated private owner and reports both recovery paths', async () => {
    await fs.writeFile(privatePath, '{');
    const warn = vi.spyOn(runLogger, 'warn').mockImplementation(() => {});
    expect(await claimWorktreeOwnership(checkout, 'owner', root)).toBe(
      'unavailable',
    );
    expect(await releaseWorktreeOwnership(checkout, 'owner')).toBe(false);
    expect(await fs.readFile(legacyPath, 'utf8')).toBe(contents);
    expect(await fs.readFile(privatePath, 'utf8')).toBe('{');
    const error = warn.mock.calls
      .flat()
      .find((value) => value instanceof Error);
    expect(String(error)).toContain(legacyPath);
    expect(String(error)).toContain(privatePath);
    expect(String(error)).toMatch(/repair|recover/i);
  });

  it('retains both matching owners when legacy removal fails and releases both after retry', async () => {
    const unlink = nativeFs.promises.unlink;
    vi.spyOn(nativeFs.promises, 'unlink').mockImplementation(async (file) => {
      if (file === legacyPath)
        throw Object.assign(new Error('file locked'), { code: 'EACCES' });
      return unlink(file);
    });
    const warn = vi.spyOn(runLogger, 'warn').mockImplementation(() => {});
    syncBuiltinESMExports();

    expect(await claimWorktreeOwnership(checkout, 'owner', root)).toBe(
      'unavailable',
    );
    expect(await inspectWorktreeOwnership(checkout, 'owner')).toBe(
      'owned-by-session',
    );
    warn.mockClear();
    expect(await releaseWorktreeOwnership(checkout, 'owner')).toBe(false);
    expect(await fs.readFile(legacyPath, 'utf8')).toBe(contents);
    expect(await fs.readFile(privatePath, 'utf8')).toBe(contents);
    const error = warn.mock.calls
      .flat()
      .find((value) => value instanceof Error);
    expect(String(error)).toContain(legacyPath);
    expect(String(error)).toContain(privatePath);
    expect(String(error)).toMatch(/retry/i);

    vi.restoreAllMocks();
    syncBuiltinESMExports();
    expect(await releaseWorktreeOwnership(checkout, 'owner')).toBe(true);
    await expect(fs.stat(legacyPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.stat(privatePath)).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
});
