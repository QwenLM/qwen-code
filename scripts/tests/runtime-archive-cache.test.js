/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { arePermissionBitsEnforced } from '../../packages/cli/src/test-utils/permission-bits.js';
import {
  fetchVerifiedArchive,
  sweepRuntimeCache,
} from '../lib/runtime-archive-cache.js';
import { RUNTIME_ARCHIVE_DIGESTS } from '../lib/standalone-runtime-pins.js';
import { getWorkflowJob, getWorkflowStep } from './workflow-helpers.js';

const ARCHIVE = Buffer.from('pinned archive bytes');
const WRONG = Buffer.from('stale archive bytes');
const URL = 'https://example.invalid/runtime.tgz';
const FILENAME = 'runtime.tgz';
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const PIN = { digest: sha256, expected: sha256(ARCHIVE) };
const DAY_MS = 24 * 60 * 60 * 1000;
const ROOT = path.resolve(import.meta.dirname, '../..');

describe('fetchVerifiedArchive', () => {
  let root;
  let fetchImpl;
  let sleep;
  let log;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-archive-cache-'));
    fetchImpl = vi.fn(async () => new Response(ARCHIVE));
    sleep = vi.fn(async () => undefined);
    log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    log.mockRestore();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const fetchWith = (options) =>
    fetchVerifiedArchive(URL, FILENAME, PIN, { fetchImpl, sleep, ...options });
  const age = (file, ms) => {
    const time = new Date(Date.now() - ms);
    fs.utimesSync(file, time, time);
  };

  it('caches a verified download and reuses it without fetching', async () => {
    const cacheDir = path.join(root, 'cache');

    const first = await fetchWith({ cacheDir });
    const second = await fetchWith({ cacheDir });

    expect(first.equals(ARCHIVE)).toBe(true);
    expect(second.equals(ARCHIVE)).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledWith(URL, {
      signal: expect.any(AbortSignal),
    });
    expect(fs.readdirSync(cacheDir)).toEqual([FILENAME]);
    expect(log.mock.calls).toEqual([
      [`runtime archive cached: ${path.join(cacheDir, FILENAME)}`],
      [`runtime archive reused from cache: ${path.join(cacheDir, FILENAME)}`],
    ]);
  });

  it('replaces a cached copy that fails verification', async () => {
    const cacheDir = path.join(root, 'cache');
    fs.mkdirSync(cacheDir);
    fs.writeFileSync(path.join(cacheDir, FILENAME), 'tampered');

    const bytes = await fetchWith({ cacheDir });

    expect(bytes.equals(ARCHIVE)).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fs.readFileSync(path.join(cacheDir, FILENAME)).equals(ARCHIVE)).toBe(
      true,
    );
    expect(log).toHaveBeenCalledWith(
      `runtime archive in cache failed verification: ${path.join(cacheDir, FILENAME)}`,
    );
  });

  it('downloads without touching the disk when no cache is configured', async () => {
    const bytes = await fetchWith({});

    expect(bytes.equals(ARCHIVE)).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fs.readdirSync(root)).toEqual([]);
    expect(log).not.toHaveBeenCalled();
  });

  it('retries failed requests and logs why each one failed', async () => {
    fetchImpl
      .mockResolvedValueOnce(new Response('bad gateway', { status: 502 }))
      .mockRejectedValueOnce(
        Object.assign(new TypeError('fetch failed'), {
          cause: new Error('socket hang up'),
        }),
      );

    const bytes = await fetchWith({});

    expect(bytes.equals(ARCHIVE)).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls).toEqual([[5_000], [10_000]]);
    expect(log.mock.calls).toEqual([
      [
        expect.stringMatching(
          /^runtime download attempt 1 failed: .*returned 502/,
        ),
      ],
      [
        'runtime download attempt 2 failed: TypeError: fetch failed (cause: socket hang up)',
      ],
    ]);
  });

  it('retries a download that fails verification', async () => {
    const cacheDir = path.join(root, 'cache');
    fetchImpl.mockResolvedValueOnce(new Response(WRONG));

    const bytes = await fetchWith({ cacheDir });

    expect(bytes.equals(ARCHIVE)).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fs.readFileSync(path.join(cacheDir, FILENAME)).equals(ARCHIVE)).toBe(
      true,
    );
  });

  it('gives up after three downloads, naming both digests', async () => {
    const cacheDir = path.join(root, 'cache');
    fetchImpl.mockImplementation(async () => new Response(WRONG));

    await expect(fetchWith({ cacheDir })).rejects.toThrow(
      `runtime archive digest mismatch: ${URL} is ${sha256(WRONG)}, pinned ${sha256(ARCHIVE)}`,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(fs.existsSync(cacheDir)).toBe(false);
  });

  it('removes cache entries no run has used for a week', async () => {
    const cacheDir = path.join(root, 'cache');
    fs.mkdirSync(cacheDir);
    const seed = (entry, ms) => {
      fs.writeFileSync(path.join(cacheDir, entry), 'x');
      age(path.join(cacheDir, entry), ms);
    };
    // A previous pin and a partial file from a killed run.
    seed('runtime-old.tgz', 8 * DAY_MS);
    seed(`${FILENAME}.999999.tmp`, 8 * DAY_MS);
    // Another revision's pin and a concurrent job's partial file.
    seed('runtime-other.tgz', DAY_MS);
    seed(`${FILENAME}.123.tmp`, 0);
    // Not a cache entry: left alone, and the sweep goes on past it.
    fs.mkdirSync(path.join(cacheDir, 'a-directory'));
    age(path.join(cacheDir, 'a-directory'), 8 * DAY_MS);

    await fetchWith({ cacheDir });
    sweepRuntimeCache(cacheDir, [FILENAME]);

    expect(fs.readdirSync(cacheDir).sort()).toEqual([
      'a-directory',
      'runtime-other.tgz',
      FILENAME,
      `${FILENAME}.123.tmp`,
    ]);
  });

  it('keeps every archive a run uses when it sweeps after the last fetch', async () => {
    const cacheDir = path.join(root, 'cache');
    fs.mkdirSync(cacheDir);
    const second = Buffer.from('second pinned archive bytes');
    // Both pins are cached but unused for a week, as after a quiet week.
    for (const [entry, bytes] of [
      [FILENAME, ARCHIVE],
      ['second.tgz', second],
      ['runtime-old.tgz', WRONG],
    ]) {
      fs.writeFileSync(path.join(cacheDir, entry), bytes);
      age(path.join(cacheDir, entry), 8 * DAY_MS);
    }

    await fetchWith({ cacheDir });
    await fetchVerifiedArchive(
      'https://example.invalid/second.tgz',
      'second.tgz',
      { digest: sha256, expected: sha256(second) },
      { cacheDir, fetchImpl, sleep },
    );
    sweepRuntimeCache(cacheDir, [FILENAME, 'second.tgz']);

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(fs.readdirSync(cacheDir).sort()).toEqual([FILENAME, 'second.tgz']);
  });

  it('marks a reused archive as used', async () => {
    const cacheDir = path.join(root, 'cache');
    fs.mkdirSync(cacheDir);
    const cached = path.join(cacheDir, FILENAME);
    fs.writeFileSync(cached, ARCHIVE);
    age(cached, 8 * DAY_MS);
    fs.writeFileSync(path.join(cacheDir, 'runtime-old.tgz'), 'x');
    age(path.join(cacheDir, 'runtime-old.tgz'), 8 * DAY_MS);

    await fetchWith({ cacheDir });
    // Even without naming it, a later sweep keeps what a run just used.
    sweepRuntimeCache(cacheDir, []);

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(fs.statSync(cached).mtimeMs).toBeGreaterThan(Date.now() - DAY_MS);
    expect(fs.readdirSync(cacheDir)).toEqual([FILENAME]);
  });

  it('caches through a partial file, so a failed write leaves no cached copy', async () => {
    const cacheDir = path.join(root, 'cache');
    const writeFileSync = fs.writeFileSync.bind(fs);
    const write = vi
      .spyOn(fs, 'writeFileSync')
      .mockImplementationOnce((file, data) => {
        writeFileSync(file, data.subarray(0, 4));
        throw new Error('disk full');
      });
    try {
      const bytes = await fetchWith({ cacheDir });

      expect(bytes.equals(ARCHIVE)).toBe(true);
      expect(write).toHaveBeenCalledWith(
        `${path.join(cacheDir, FILENAME)}.${process.pid}.tmp`,
        ARCHIVE,
      );
    } finally {
      write.mockRestore();
    }
    expect(fs.readdirSync(cacheDir)).toEqual([]);
    expect(log).toHaveBeenCalledWith(
      'runtime archive not cached: Error: disk full',
    );
  });

  it('keeps a verified download when the cache path runs through a file', async () => {
    const blocker = path.join(root, 'not-a-directory');
    fs.writeFileSync(blocker, '');

    const bytes = await fetchWith({ cacheDir: path.join(blocker, 'cache') });

    expect(bytes.equals(ARCHIVE)).toBe(true);
    expect(log).toHaveBeenCalledWith(
      expect.stringMatching(/^runtime archive not cached: /),
    );
  });

  it.skipIf(!arePermissionBitsEnforced())(
    'keeps a verified download when the cache directory cannot be searched',
    async () => {
      const cacheDir = path.join(root, 'cache');
      fs.mkdirSync(cacheDir);
      fs.chmodSync(cacheDir, 0o000);
      try {
        const bytes = await fetchWith({ cacheDir });

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

describe('standalone runtime cache wiring', () => {
  const CACHE_STEP =
    'Configure persistent standalone runtime cache (self-hosted)';
  const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
  const expectCacheExportedBefore = (job, consumer) => {
    const step = getWorkflowStep(job, CACHE_STEP);
    expect(step).toMatch(/^\s+if: .*runner\.environment == 'self-hosted'/m);
    expect(step).toContain(
      'cache_dir="${HOME}/.cache/qwen-code/standalone-runtimes"',
    );
    expect(step).toContain(
      'echo "QWEN_STANDALONE_RUNTIME_CACHE=${cache_dir}" >> "${GITHUB_ENV}"',
    );
    expect(step).toContain('du -sh "${cache_dir}"');
    // $GITHUB_ENV reaches only the steps after the one that writes it.
    getWorkflowStep(job, consumer);
    expect(job.indexOf(`- name: '${CACHE_STEP}'`)).toBeLessThan(
      job.indexOf(`- name: '${consumer}'`),
    );
  };

  it('exports the cache directory before the CI tests run', () => {
    expectCacheExportedBefore(
      getWorkflowJob(read('.github/workflows/ci.yml'), 'test'),
      'Run tests and generate reports',
    );
  });

  it('exports the cache directory before the release script tests run', () => {
    expectCacheExportedBefore(
      getWorkflowJob(read('.github/workflows/release.yml'), 'quality_scripts'),
      'Run Script Tests',
    );
  });

  it('hands the exported directory to every fetch and sweeps after the last', () => {
    const script = read('scripts/test-standalone-runtimes.mjs');

    expect(script).toContain(
      'const cacheDir = process.env.QWEN_STANDALONE_RUNTIME_CACHE;',
    );
    expect(script).toMatch(
      /return fetchVerifiedArchive\(url, filename, pin, \{\s*cacheDir,\s*fetchImpl: setup\.fetch,?\s*\}\)/,
    );
    expect(script.indexOf('sweepRuntimeCache(cacheDir, used)')).toBeGreaterThan(
      script.lastIndexOf('await fetchArchive('),
    );
  });
});

describe('pinned standalone runtime archives', () => {
  it('pins a well-formed, distinct digest of each runtime for every POSIX platform', () => {
    expect(Object.keys(RUNTIME_ARCHIVE_DIGESTS).sort()).toEqual([
      'darwin-arm64',
      'darwin-x64',
      'linux-arm64',
      'linux-x64',
    ]);
    const digests = Object.values(RUNTIME_ARCHIVE_DIGESTS).flatMap(
      ({ node, bun }) => {
        expect(node).toMatch(/^[a-f0-9]{64}$/);
        expect(bun).toMatch(/^sha512-[A-Za-z0-9+/]{86}==$/);
        expect(Buffer.from(bun.slice('sha512-'.length), 'base64')).toHaveLength(
          64,
        );
        return [node, bun];
      },
    );
    // A row pasted over another platform's.
    expect(new Set(digests).size).toBe(digests.length);
  });
});
