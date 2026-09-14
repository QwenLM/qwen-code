/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  chmod,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { privateDirectoryStat } from './private-directory.js';

describe('privateDirectoryStat', () => {
  let temporary: string;

  beforeEach(async () => {
    temporary = await mkdtemp(join(tmpdir(), 'qwen-live-private-directory-'));
  });

  afterEach(async () => {
    await rm(temporary, { recursive: true, force: true });
  });

  it('rejects non-directories and symlinks on every platform', async () => {
    const file = join(temporary, 'file');
    await writeFile(file, 'x');
    expect(await privateDirectoryStat(file, 'none')).toBeUndefined();
    const target = join(temporary, 'target');
    await mkdir(target, { mode: 0o700 });
    const link = join(temporary, 'link');
    await symlink(target, link);
    expect(await privateDirectoryStat(link, 'none')).toBeUndefined();
  });

  it('applies the requested strictness where POSIX mode bits are real', async () => {
    if (process.platform === 'win32') return;
    const target = join(temporary, 'target');
    await mkdir(target, { mode: 0o700 });
    expect(await privateDirectoryStat(target, 'owner-only')).toBeDefined();
    expect(await privateDirectoryStat(target, 'exact-0700')).toBeDefined();
    await chmod(target, 0o500);
    expect(await privateDirectoryStat(target, 'owner-only')).toBeDefined();
    expect(await privateDirectoryStat(target, 'exact-0700')).toBeUndefined();
    await chmod(target, 0o755);
    expect(await privateDirectoryStat(target, 'owner-only')).toBeUndefined();
    expect(await privateDirectoryStat(target, 'exact-0700')).toBeUndefined();
    expect(await privateDirectoryStat(target, 'none')).toBeDefined();
  });

  it('enforces current-user ownership at every strictness level', async () => {
    if (process.platform === 'win32') return;
    const getuid = process.getuid;
    if (!getuid) return;
    const target = join(temporary, 'target');
    await mkdir(target, { mode: 0o700 });
    const originalDescriptor = Object.getOwnPropertyDescriptor(
      process,
      'getuid',
    );
    Object.defineProperty(process, 'getuid', {
      configurable: true,
      value: () => getuid() + 1,
    });
    try {
      expect(await privateDirectoryStat(target, 'none')).toBeUndefined();
      expect(await privateDirectoryStat(target, 'owner-only')).toBeUndefined();
      expect(await privateDirectoryStat(target, 'exact-0700')).toBeUndefined();
    } finally {
      if (originalDescriptor) {
        Object.defineProperty(process, 'getuid', originalDescriptor);
      } else {
        Reflect.deleteProperty(process, 'getuid');
      }
    }
  });

  it('skips the mode and ownership checks where the bits are synthetic', async () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'win32' });
    try {
      const target = join(temporary, 'target');
      await mkdir(target, { mode: 0o700 });
      await chmod(target, 0o777);
      expect(await privateDirectoryStat(target, 'exact-0700')).toBeDefined();
      expect(await privateDirectoryStat(target, 'owner-only')).toBeDefined();
    } finally {
      if (platform) Object.defineProperty(process, 'platform', platform);
    }
  });
});
