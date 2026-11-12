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
import {
  BUN_VERSION,
  NODE_VERSION,
  RUNTIME_ARCHIVE_DIGESTS,
} from '../lib/standalone-runtime-pins.js';
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

// A disposable container starts with an empty cache, and the job's cache step
// points at $HOME INSIDE that container, so the host's persistent cache is
// never reached: on hz4 both archives sit on the host while the container's
// directory does not exist. The fetch then gives each archive three 300 s
// attempts and rethrows, and the standalone step's exit 1 becomes the side
// lane's verdict after every workspace suite and the whole scripts suite have
// passed — job 131062149608 reports `Side lane exited with 1` under 2786
// passing script tests, with no failing test anywhere. So the image carries
// both archives, exactly as it already carries the browsers.
describe('the ephemeral image seeds the runtime archives', () => {
  const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
  const dockerfile = () => read('scripts/ci/ephemeral-runner/Dockerfile');

  it('bakes the versions the script pins', () => {
    const declared = (name) => {
      const match = new RegExp(`^ARG ${name}=(.+)$`, 'm').exec(dockerfile());
      expect(match, `the Dockerfile must declare ${name}`).not.toBe(null);
      return match[1];
    };
    expect(declared('NODE_RUNTIME_VERSION')).toBe(NODE_VERSION);
    expect(declared('BUN_RUNTIME_VERSION')).toBe(BUN_VERSION);
  });

  // The digests are duplicated because the image's build context is its own
  // directory and cannot read the pins module. Without this pin a version bump
  // would seed an archive nothing verifies against, and the job would download
  // it anyway — the cost this layer exists to remove, silently restored.
  it('verifies the published digest of each architecture it bakes', () => {
    const text = dockerfile();
    // Scoped to the RUN that assigns the runtime digests first: the runner
    // tarball has its own `case` with the same `amd64)`/`arm64)` labels, so
    // matching a label against the whole file reads whichever layer comes
    // first and would start comparing against the runner's sha if the two were
    // ever reordered. A lookahead cannot fix that either — it reaches past the
    // arm's own `;;` into the next layer (both measured).
    const layer = text
      .replace(/\\\n\s*/g, ' ')
      .split('\n')
      .find((line) => /^RUN\s/.test(line) && line.includes('bun_sha512='));
    expect(layer, 'the image must verify a bun digest').toBeTruthy();
    for (const [arch, digests] of Object.entries({
      amd64: RUNTIME_ARCHIVE_DIGESTS['linux-x64'],
      arm64: RUNTIME_ARCHIVE_DIGESTS['linux-arm64'],
    })) {
      const arm = new RegExp(`${arch}\\)([\\s\\S]*?);;`).exec(layer);
      expect(arm, `the image must bake ${arch}`).not.toBe(null);
      expect(arm[1], `${arch} node digest`).toContain(digests.node);
      expect(arm[1], `${arch} bun digest`).toContain(
        digests.bun.slice('sha512-'.length),
      );
    }
    // Anchored on the archive being checked, not on the tool's name: the
    // runner tarball two layers down is verified with the same `sha256sum -c -`
    // spelling, so a bare substring assertion stays green when the Node
    // archive's own verification is deleted (measured).
    expect(text).toMatch(
      /echo "\$\{node_sha\}\s+\$\{QWEN_CI_BAKED_RUNTIME_CACHE\}\/\$\{node_file\}" \| sha256sum -c -/,
    );
    // sha512 specifically: the npm integrity is a sha512 digest, and switching
    // the hash would compare a sha256 against it and fail every build — or,
    // with the comparison dropped, verify nothing.
    expect(text).toContain('createHash("sha512")');
    expect(text).toMatch(/if\s*\(got\s*!==\s*want\)/);
  });

  // A partial or corrupt archive must fail the build, not a job: the digest
  // check already proves the bytes, and the listing proves they are an archive
  // tar can read. Both live in the LAST RUN, so a later layer that removes or
  // truncates them fails here rather than in the standalone step.
  it('asserts both archives in the final image, after every layer', () => {
    const runs = dockerfile()
      .replace(/\\\n\s*/g, ' ')
      .split('\n')
      .filter((line) => /^RUN\s/.test(line));
    const last = runs.at(-1);
    expect(last).toContain('QWEN_CI_BAKED_RUNTIME_CACHE');
    expect(last).toContain("-name '*.tgz'");
    expect(last).toContain('-eq 2');
    expect(last).toContain('tar -tzf');
  });

  // The seed cannot BE the cache: marking an archive used writes its mtime and
  // the sweep removes entries, and both are wrapped in a catch, so a read-only
  // directory would disable them silently. The entrypoint copies into the
  // job's own directory instead, and a failed copy must not fail the runner —
  // the fetch still falls back to downloading.
  it('copies the seed into the job cache instead of pointing at it', () => {
    const text = dockerfile();
    const entrypoint = read('scripts/ci/ephemeral-runner/entrypoint.sh');
    expect(text).toMatch(/^ENV QWEN_CI_BAKED_RUNTIME_CACHE=/m);
    expect(text).not.toMatch(/^ENV QWEN_STANDALONE_RUNTIME_CACHE=/m);
    expect(text).toContain('chmod -R a+rX "${QWEN_CI_BAKED_RUNTIME_CACHE}"');
    expect(entrypoint).toContain(
      'runtime_cache="${HOME}/.cache/qwen-code/standalone-runtimes"',
    );
    expect(entrypoint).toContain('mkdir -p "$runtime_cache"');
    expect(entrypoint).toContain('[ -e "$target" ] && continue');
    expect(entrypoint).toMatch(/cp "\$archive" "\$target" 2>\/dev\/null \|\|/);
    // `exec` replaces the process, so anything after it never runs: seeding
    // below it would ship an image that still downloads both archives while
    // every assertion about the copy itself stayed green. Order alone is not
    // enough to say that — a second exec appended after the block leaves the
    // first comparison satisfied — so the tail is pinned empty too.
    const lines = entrypoint.split('\n');
    const execLine = lines.findIndex((line) => /^exec \.\/run\.sh/.test(line));
    const seedLine = lines.findIndex((line) => line.includes('cp "$archive"'));
    expect(execLine, 'the entrypoint must exec the runner').toBeGreaterThan(-1);
    expect(seedLine, 'the entrypoint must seed the archives').toBeGreaterThan(
      -1,
    );
    expect(seedLine).toBeLessThan(execLine);
    // Exactly one exec, and nothing after it: a trailing block would be dead
    // code the ordering check above cannot see.
    expect(lines.filter((line) => /^exec /.test(line))).toHaveLength(1);
    expect(
      lines
        .slice(execLine + 1)
        .join('\n')
        .trim(),
    ).toBe('');
  });
});
