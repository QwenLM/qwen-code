/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockGetGlobalTempDir = vi.hoisted(() => vi.fn<() => string>());

vi.mock('../config/storage.js', () => ({
  Storage: {
    getGlobalTempDir: mockGetGlobalTempDir,
  },
}));

import {
  getClipboardImageDir,
  saveImageBufferToClipboardDir,
  pruneClipboardImages,
} from './clipboardImageStorage.js';

describe('clipboardImageStorage', () => {
  let tempRoot: string;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-clip-'));
    mockGetGlobalTempDir.mockReturnValue(tempRoot);
  });

  afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  describe('getClipboardImageDir', () => {
    it('returns <globalTempDir>/clipboard', () => {
      expect(getClipboardImageDir()).toBe(path.join(tempRoot, 'clipboard'));
    });
  });

  describe('saveImageBufferToClipboardDir', () => {
    it('creates the clipboard directory and writes the file', async () => {
      const buf = Buffer.from('hello');
      const filePath = await saveImageBufferToClipboardDir(buf, 'test.png');

      expect(filePath).toBe(path.join(tempRoot, 'clipboard', 'test.png'));
      expect(fs.existsSync(filePath)).toBe(true);
      expect(fs.readFileSync(filePath).toString()).toBe('hello');
    });

    it('writes into an already-existing clipboard directory', async () => {
      fs.mkdirSync(path.join(tempRoot, 'clipboard'), { recursive: true });

      const filePath = await saveImageBufferToClipboardDir(
        Buffer.from('world'),
        'second.png',
      );
      expect(fs.existsSync(filePath)).toBe(true);
    });
  });

  describe('pruneClipboardImages', () => {
    it('does nothing when directory does not exist', async () => {
      mockGetGlobalTempDir.mockReturnValue('/nonexistent/path');
      await expect(pruneClipboardImages()).resolves.not.toThrow();
    });

    it('does nothing when image count is within limit', async () => {
      const dir = path.join(tempRoot, 'clipboard');
      fs.mkdirSync(dir, { recursive: true });
      for (let i = 0; i < 5; i++) {
        fs.writeFileSync(path.join(dir, `clipboard-${i}.png`), `img-${i}`);
      }

      await pruneClipboardImages();
      const remaining = fs.readdirSync(dir);
      expect(remaining).toHaveLength(5);
    });

    it('removes oldest files when count exceeds maxImages', async () => {
      const dir = path.join(tempRoot, 'clipboard');
      fs.mkdirSync(dir, { recursive: true });

      for (let i = 0; i < 105; i++) {
        const filePath = path.join(dir, `clipboard-${i}.png`);
        fs.writeFileSync(filePath, `img-${i}`);
        const time = new Date(Date.now() - (105 - i) * 1000);
        fs.utimesSync(filePath, time, time);
      }

      await pruneClipboardImages(100);

      const remaining = fs
        .readdirSync(dir)
        .filter((f) => f.startsWith('clipboard-'));
      expect(remaining).toHaveLength(100);

      // Oldest files (0..4) should have been removed
      for (let i = 0; i < 5; i++) {
        expect(fs.existsSync(path.join(dir, `clipboard-${i}.png`))).toBe(false);
      }
    });

    it('ignores non-clipboard files', async () => {
      const dir = path.join(tempRoot, 'clipboard');
      fs.mkdirSync(dir, { recursive: true });

      for (let i = 0; i < 3; i++) {
        fs.writeFileSync(path.join(dir, `clipboard-${i}.png`), `img`);
      }
      fs.writeFileSync(path.join(dir, 'other-file.txt'), 'keep');

      await pruneClipboardImages(2);

      expect(fs.existsSync(path.join(dir, 'other-file.txt'))).toBe(true);
      const clipFiles = fs
        .readdirSync(dir)
        .filter((f) => f.startsWith('clipboard-'));
      expect(clipFiles).toHaveLength(2);
    });
  });
});
