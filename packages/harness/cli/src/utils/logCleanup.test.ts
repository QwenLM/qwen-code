/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { vi, describe, it, expect, beforeEach } from 'vitest';
import {
  promises as fs,
  type PathLike,
  type Dirent,
  type Stats,
} from 'node:fs';
import * as path from 'node:path';
import { cleanupBackgroundLogs } from './logCleanup.js';

vi.mock('@qwen-code/core', () => ({
  getTaskOutputDir: vi.fn().mockReturnValue('/tmp/gemini-cli-tasks'),
  isNodeError: (error: unknown): error is NodeJS.ErrnoException =>
    error instanceof Error && 'code' in error,
  runLogger: {
    debug: vi.fn(),
    warn: vi.fn(),
  },
}));

vi.mock('node:fs', () => ({
  promises: {
    readdir: vi.fn(),
    stat: vi.fn(),
    unlink: vi.fn(),
  },
}));

describe('logCleanup', () => {
  const outputDir = '/tmp/gemini-cli-tasks';

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should skip cleanup if the directory does not exist', async () => {
    vi.mocked(fs.readdir).mockRejectedValue(
      Object.assign(new Error('missing'), { code: 'ENOENT' }),
    );

    await expect(cleanupBackgroundLogs()).resolves.toEqual({
      scanned: 0,
      deleted: 0,
      failed: 0,
    });

    expect(fs.readdir).toHaveBeenCalledWith(outputDir, { withFileTypes: true });
    expect(fs.unlink).not.toHaveBeenCalled();
  });

  it('should skip cleanup if the directory is empty', async () => {
    vi.mocked(fs.readdir).mockResolvedValue([]);

    await expect(cleanupBackgroundLogs()).resolves.toEqual({
      scanned: 0,
      deleted: 0,
      failed: 0,
    });

    expect(fs.readdir).toHaveBeenCalledWith(outputDir, { withFileTypes: true });
    expect(fs.unlink).not.toHaveBeenCalled();
  });

  it('should delete log files older than 7 days', async () => {
    const now = Date.now();
    const oldTime = now - 8 * 24 * 60 * 60 * 1000; // 8 days ago
    const newTime = now - 1 * 24 * 60 * 60 * 1000; // 1 day ago

    const entries = [
      { name: 'old.output', isFile: () => true },
      { name: 'new.output', isFile: () => true },
      { name: 'not-an-output.txt', isFile: () => true },
      { name: 'some-dir', isFile: () => false },
    ] as Dirent[];

    vi.mocked(
      fs.readdir as (
        path: PathLike,
        options: { withFileTypes: true },
      ) => Promise<Dirent[]>,
    ).mockResolvedValue(entries);
    vi.mocked(fs.stat).mockImplementation((filePath: PathLike) => {
      const pathStr = filePath.toString();
      if (pathStr.endsWith('old.output')) {
        return Promise.resolve({ mtime: new Date(oldTime) } as Stats);
      }
      if (pathStr.endsWith('new.output')) {
        return Promise.resolve({ mtime: new Date(newTime) } as Stats);
      }
      return Promise.resolve({ mtime: new Date(now) } as Stats);
    });
    vi.mocked(fs.unlink).mockResolvedValue(undefined);

    await expect(cleanupBackgroundLogs()).resolves.toEqual({
      scanned: 2,
      deleted: 1,
      failed: 0,
    });

    expect(fs.unlink).toHaveBeenCalledTimes(1);
    expect(fs.unlink).toHaveBeenCalledWith(path.join(outputDir, 'old.output'));
    expect(fs.unlink).not.toHaveBeenCalledWith(
      path.join(outputDir, 'new.output'),
    );
  });

  it('should handle errors during file deletion gracefully', async () => {
    const now = Date.now();
    const oldTime = now - 8 * 24 * 60 * 60 * 1000;

    const entries = [{ name: 'old.output', isFile: () => true }];

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(fs.readdir).mockResolvedValue(entries as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(fs.stat).mockResolvedValue({ mtime: new Date(oldTime) } as any);
    vi.mocked(fs.unlink).mockRejectedValue(new Error('Permission denied'));

    await expect(cleanupBackgroundLogs()).resolves.toMatchObject({
      scanned: 1,
      deleted: 0,
      failed: 1,
    });
    expect(fs.unlink).toHaveBeenCalled();
  });
});
