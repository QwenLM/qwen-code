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

  it.runIf(process.platform !== 'win32')(
    'does not create directories through an existing symbolic link',
    async () => {
      tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'zip-extraction-'));
      const destination = path.join(tempDir, 'destination');
      const outside = path.join(tempDir, 'outside');
      await fs.mkdir(destination);
      await fs.mkdir(outside);
      await fs.symlink(outside, path.join(destination, 'link'));
      const zipFile = new EventEmitter() as ZipFile;
      const entry = {
        fileName: 'link/sub/file.txt',
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
      ).rejects.toThrow('Refusing to extract through non-directory path');
      await expect(fs.stat(path.join(outside, 'sub'))).rejects.toThrow();
    },
  );

  it('sanitizes and bounds entry names in errors', async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'zip-extraction-'));
    const destination = path.join(tempDir, 'destination');
    const zipFile = new EventEmitter() as ZipFile;
    const entry = {
      fileName: `bad\n\u001b[31m${'x'.repeat(500)}`,
      externalFileAttributes: 0xa000 << 16,
      versionMadeBy: 3 << 8,
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

    const error = await extractZipArchive(
      path.join(tempDir, 'archive.zip'),
      destination,
    ).then(
      () => undefined,
      (reason: unknown) => reason,
    );
    const message = String(error);
    expect(message).not.toContain('\n');
    expect(message).not.toContain('\u001b');
    expect(message.length).toBeLessThan(300);
  });
});
