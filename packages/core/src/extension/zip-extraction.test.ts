/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Entry, ZipFile } from 'yauzl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { extractZipArchive } from './zip-extraction.js';

const mockOpen = vi.hoisted(() => vi.fn());

vi.mock('yauzl', () => ({ open: mockOpen }));

describe('extractZipArchive', () => {
  let tempDir: string;

  afterEach(async () => {
    vi.clearAllMocks();
    if (tempDir) await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('rejects entries that escape the destination', async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'zip-extraction-'));
    const destination = path.join(tempDir, 'destination');
    const zipFile = new EventEmitter() as ZipFile;
    const entry = {
      fileName: '../../outside.txt',
      externalFileAttributes: 0,
      versionMadeBy: 0,
    } as Entry;
    zipFile.readEntry = vi.fn(() => zipFile.emit('entry', entry));
    zipFile.close = vi.fn(() => zipFile.emit('close'));
    mockOpen.mockImplementation(
      (
        _file: string,
        _options: unknown,
        callback: (error: Error | null, opened?: ZipFile) => void,
      ) => callback(null, zipFile),
    );

    await expect(
      extractZipArchive(path.join(tempDir, 'archive.zip'), destination),
    ).rejects.toThrow('Out of bound path');
    await expect(fs.stat(path.join(tempDir, 'outside.txt'))).rejects.toThrow();
  });
});
