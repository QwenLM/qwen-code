/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Config } from '../config/config.js';
import { FileReadCache } from '../services/fileReadCache.js';
import { recordGrepResultFileReads } from './grepReadTracking.js';

describe('recordGrepResultFileReads', () => {
  let tempRootDir: string;
  let fileReadCache: FileReadCache;

  beforeEach(async () => {
    tempRootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'grep-read-cache-'));
    fileReadCache = new FileReadCache();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(tempRootDir, { recursive: true, force: true });
  });

  function mockConfig(
    cache: FileReadCache | undefined = fileReadCache,
    disabled = false,
  ): Config {
    return {
      getFileReadCacheDisabled: () => disabled,
      getFileReadCache: () => cache,
    } as unknown as Config;
  }

  it('does nothing when the cache is disabled', async () => {
    const filePath = path.join(tempRootDir, 'result.ts');
    await fs.writeFile(filePath, 'match');
    const stats = await fs.stat(filePath);

    await recordGrepResultFileReads(mockConfig(fileReadCache, true), [
      filePath,
    ]);

    expect(fileReadCache.check(stats).state).toBe('unknown');
  });

  it('does nothing when the config has no cache', async () => {
    const filePath = path.join(tempRootDir, 'result.ts');
    await fs.writeFile(filePath, 'match');

    await expect(
      recordGrepResultFileReads(mockConfig(undefined), [filePath]),
    ).resolves.toBeUndefined();
  });

  it('records text grep results as partial cacheable reads', async () => {
    const filePath = path.join(tempRootDir, 'result.ts');
    await fs.writeFile(filePath, 'const value = "match";');
    const stats = await fs.stat(filePath);

    await recordGrepResultFileReads(mockConfig(), [filePath]);

    const result = fileReadCache.check(stats);
    expect(result.state).toBe('fresh');
    if (result.state === 'fresh') {
      expect(result.entry.lastReadWasFull).toBe(false);
      expect(result.entry.lastReadCacheable).toBe(true);
    }
  });

  it('does not make notebook grep results cacheable', async () => {
    const filePath = path.join(tempRootDir, 'notebook.ipynb');
    await fs.writeFile(filePath, '{"cells":[{"source":"match"}]}');
    const stats = await fs.stat(filePath);

    await recordGrepResultFileReads(mockConfig(), [filePath]);

    const result = fileReadCache.check(stats);
    expect(result.state).toBe('fresh');
    if (result.state === 'fresh') {
      expect(result.entry.lastReadWasFull).toBe(false);
      expect(result.entry.lastReadCacheable).toBe(false);
    }
  });

  it('ignores non-file grep result paths', async () => {
    const dirPath = path.join(tempRootDir, 'nested');
    await fs.mkdir(dirPath);
    const stats = await fs.stat(dirPath);

    await recordGrepResultFileReads(mockConfig(), [dirPath]);

    expect(fileReadCache.check(stats).state).toBe('unknown');
  });

  it('ignores result paths that disappear before stat', async () => {
    await expect(
      recordGrepResultFileReads(mockConfig(), [
        path.join(tempRootDir, 'missing.ts'),
      ]),
    ).resolves.toBeUndefined();
  });

  it('continues after a stat failure', async () => {
    const filePath = path.join(tempRootDir, 'result.ts');
    const blockedPath = path.join(tempRootDir, 'blocked.ts');
    await fs.writeFile(filePath, 'match');
    const stats = await fs.stat(filePath);
    const actualStat = fs.stat.bind(fs);
    vi.spyOn(fs, 'stat').mockImplementation(async (target) => {
      if (target === blockedPath) {
        throw Object.assign(new Error('denied'), { code: 'EACCES' });
      }
      return actualStat(target);
    });

    await recordGrepResultFileReads(mockConfig(), [blockedPath, filePath]);

    expect(fileReadCache.check(stats).state).toBe('fresh');
  });
});
