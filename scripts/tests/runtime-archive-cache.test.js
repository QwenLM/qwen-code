/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fetchVerifiedArchive } from '../lib/runtime-archive-cache.js';

const ARCHIVE = Buffer.from('pinned archive bytes');
const URL = 'https://example.invalid/runtime.tgz';
const FILENAME = 'runtime.tgz';
const verified = (bytes) => bytes.equals(ARCHIVE);

describe('fetchVerifiedArchive', () => {
  let root;
  let fetchImpl;
  let log;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-archive-cache-'));
    fetchImpl = vi.fn(async () => new Response(ARCHIVE));
    log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    log.mockRestore();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('caches a verified download and reuses it without fetching', async () => {
    const cacheDir = path.join(root, 'cache');

    const first = await fetchVerifiedArchive(URL, FILENAME, verified, {
      cacheDir,
      fetchImpl,
    });
    const second = await fetchVerifiedArchive(URL, FILENAME, verified, {
      cacheDir,
      fetchImpl,
    });

    expect(first.equals(ARCHIVE)).toBe(true);
    expect(second.equals(ARCHIVE)).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fs.readdirSync(cacheDir)).toEqual([FILENAME]);
  });

  it('replaces a cached copy that fails verification', async () => {
    const cacheDir = path.join(root, 'cache');
    fs.mkdirSync(cacheDir);
    fs.writeFileSync(path.join(cacheDir, FILENAME), 'tampered');

    const bytes = await fetchVerifiedArchive(URL, FILENAME, verified, {
      cacheDir,
      fetchImpl,
    });

    expect(bytes.equals(ARCHIVE)).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fs.readFileSync(path.join(cacheDir, FILENAME)).equals(ARCHIVE)).toBe(
      true,
    );
  });

  it('keeps a verified download when the cache path runs through a file', async () => {
    const blocker = path.join(root, 'not-a-directory');
    fs.writeFileSync(blocker, '');

    const bytes = await fetchVerifiedArchive(URL, FILENAME, verified, {
      cacheDir: path.join(blocker, 'cache'),
      fetchImpl,
    });

    expect(bytes.equals(ARCHIVE)).toBe(true);
    expect(log).toHaveBeenCalledWith(
      expect.stringMatching(/^runtime archive not cached: /),
    );
  });

  // Root bypasses directory permissions, and Windows ignores the mode.
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'keeps a verified download when the cache directory cannot be searched',
    async () => {
      const cacheDir = path.join(root, 'cache');
      fs.mkdirSync(cacheDir);
      fs.chmodSync(cacheDir, 0o000);
      try {
        const bytes = await fetchVerifiedArchive(URL, FILENAME, verified, {
          cacheDir,
          fetchImpl,
        });

        expect(bytes.equals(ARCHIVE)).toBe(true);
        expect(log).toHaveBeenCalledWith(
          expect.stringMatching(/^runtime archive not cached: .*EACCES/),
        );
      } finally {
        fs.chmodSync(cacheDir, 0o700);
      }
      expect(fs.readdirSync(cacheDir)).toEqual([]);
    },
  );
});
