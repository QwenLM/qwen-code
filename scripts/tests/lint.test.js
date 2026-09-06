/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { execSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// getLinterTempDir joins with the platform separator; compare normalized
// paths so the suite also passes on the Windows gate.
const toPosix = (value) => value.replaceAll(path.sep, '/');

describe('linter directories', () => {
  const originalArgv = process.argv;

  beforeEach(() => {
    process.argv = ['node', 'scripts/lint.js', '--test-import'];
  });

  afterEach(() => {
    process.argv = originalArgv;
  });

  it('isolates GitHub Actions linter installs by run and job', async () => {
    const { getLinterTempDir } = await import('../lint.js');

    const first = getLinterTempDir({
      cwd: '/runner/_work/qwen-code/qwen-code',
      env: {
        RUNNER_TEMP: '/runner/_work/_temp',
        GITHUB_RUN_ID: '28501834362',
        GITHUB_RUN_ATTEMPT: '1',
        GITHUB_JOB: 'test',
      },
    });
    const second = getLinterTempDir({
      cwd: '/runner/_work/qwen-code/qwen-code',
      env: {
        RUNNER_TEMP: '/runner/_work/_temp',
        GITHUB_RUN_ID: '28501834363',
        GITHUB_RUN_ATTEMPT: '1',
        GITHUB_JOB: 'integration_cli',
      },
    });

    expect(toPosix(first)).toBe(
      '/runner/_work/_temp/qwen-code-linters/28501834362-1-test',
    );
    expect(toPosix(second)).toBe(
      '/runner/_work/_temp/qwen-code-linters/28501834363-1-integration_cli',
    );
    expect(first).not.toBe(second);
  });

  it('isolates local linter installs by workspace', async () => {
    const { getLinterTempDir } = await import('../lint.js');

    const first = getLinterTempDir({
      cwd: '/tmp/qwen-code-a',
      env: {},
    });
    const second = getLinterTempDir({
      cwd: '/tmp/qwen-code-b',
      env: {},
    });

    expect(toPosix(first)).toMatch(/\/qwen-code-linters\/local-[a-f0-9]{16}$/);
    expect(toPosix(second)).toMatch(/\/qwen-code-linters\/local-[a-f0-9]{16}$/);
    expect(first).not.toBe(second);
  });

  it('shares cached downloads across GitHub Actions runs', async () => {
    const { getLinterCacheDir } = await import('../lint.js');

    const first = getLinterCacheDir({
      env: {
        XDG_CACHE_HOME: '/runner/cache',
        GITHUB_RUN_ID: '31583913822',
      },
    });
    const second = getLinterCacheDir({
      env: {
        XDG_CACHE_HOME: '/runner/cache',
        GITHUB_RUN_ID: '31583913823',
      },
    });

    expect(toPosix(first)).toBe('/runner/cache/qwen-code/linters');
    expect(second).toBe(first);
    expect(
      toPosix(getLinterCacheDir({ env: {}, homeDir: '/home/runner' })),
    ).toBe('/home/runner/.cache/qwen-code/linters');
  });

  it.skipIf(process.platform === 'win32')(
    'verifies and reuses archives without depending on cache writes',
    async () => {
      const { getCachedArchiveInstaller } = await import('../lint.js');
      const root = mkdtempSync(path.join(tmpdir(), 'linter-cache-'));

      try {
        const binDir = path.join(root, 'bin');
        const cacheArchive = path.join(root, 'cache', 'tool.tar');
        const localArchive = path.join(root, 'job', 'tool.tar');
        const executable = path.join(root, 'job', 'tool');
        const fixture = path.join(root, 'official.tar');
        const curlLog = path.join(root, 'curl.log');
        const curl = path.join(binDir, 'curl');
        mkdirSync(binDir, { recursive: true });
        mkdirSync(path.dirname(cacheArchive), { recursive: true });
        mkdirSync(path.dirname(localArchive), { recursive: true });
        writeFileSync(cacheArchive, 'validator-passing plant');
        writeFileSync(fixture, 'official archive');
        writeFileSync(
          curl,
          '#!/bin/sh\nprintf "download\\n" >> "$CURL_LOG"\nwhile [ "$#" -gt 0 ]; do\n  if [ "$1" = "-o" ]; then\n    if [ "$CORRUPT_DOWNLOAD" = "1" ]; then printf corrupt > "$2"; else cp "$FIXTURE_ARCHIVE" "$2"; fi\n    exit\n  fi\n  shift\ndone\nexit 1\n',
        );
        chmodSync(curl, 0o755);

        const expectedSha256 = createHash('sha256')
          .update(readFileSync(fixture))
          .digest('hex');
        expect(() =>
          getCachedArchiveInstaller({
            cacheArchive,
            localArchive,
            downloadUrl: 'https://example.invalid/unpinned.tar',
          }),
        ).toThrow('Missing SHA-256 pin');
        const installer = getCachedArchiveInstaller({
          cacheArchive,
          localArchive,
          expectedSha256,
          downloadUrl: 'https://example.invalid/tool.tar',
          archiveCheck: 'true',
          extract: `cp "${localArchive}" "${executable}" && chmod +x "${executable}"`,
          executable,
        });
        const env = {
          ...process.env,
          PATH: `${binDir}:${process.env.PATH}`,
          CURL_LOG: curlLog,
          CORRUPT_DOWNLOAD: '0',
          FIXTURE_ARCHIVE: fixture,
        };

        expect(() =>
          execSync(installer, {
            env: { ...env, CORRUPT_DOWNLOAD: '1' },
          }),
        ).toThrow();
        expect(readFileSync(cacheArchive, 'utf8')).toBe(
          'validator-passing plant',
        );

        execSync(installer, { env });
        expect(readFileSync(cacheArchive, 'utf8')).toBe('official archive');
        expect(readFileSync(executable, 'utf8')).toBe('official archive');
        expect(readFileSync(curlLog, 'utf8')).toBe('download\ndownload\n');

        rmSync(localArchive);
        rmSync(executable);
        const nonExecutableInstaller = getCachedArchiveInstaller({
          cacheArchive,
          localArchive,
          expectedSha256,
          downloadUrl: 'https://example.invalid/tool.tar',
          archiveCheck: 'true',
          extract: `cp "${localArchive}" "${executable}"`,
          executable,
        });
        expect(() => execSync(nonExecutableInstaller, { env })).toThrow();

        rmSync(localArchive);
        rmSync(executable);
        rmSync(fixture);
        execSync(installer, { env });
        expect(readFileSync(executable, 'utf8')).toBe('official archive');
        expect(readFileSync(curlLog, 'utf8')).toBe('download\ndownload\n');

        writeFileSync(fixture, 'official archive');
        rmSync(localArchive);
        rmSync(executable);
        rmSync(path.dirname(cacheArchive), { recursive: true });
        execSync(installer, { env });
        expect(readFileSync(cacheArchive, 'utf8')).toBe('official archive');
        expect(readFileSync(curlLog, 'utf8')).toBe(
          'download\ndownload\ndownload\n',
        );

        rmSync(localArchive);
        rmSync(executable);
        rmSync(cacheArchive);
        mkdirSync(cacheArchive);
        const result = spawnSync(installer, { env, shell: true });
        expect(result.status).toBe(0);
        expect(result.stderr.toString()).toContain('EISDIR');
        expect(result.stderr.toString()).toContain(
          'Warning: could not persist linter archive',
        );
        expect(readFileSync(executable, 'utf8')).toBe('official archive');
        expect(statSync(cacheArchive).isDirectory()).toBe(true);
        expect(readFileSync(curlLog, 'utf8')).toBe(
          'download\ndownload\ndownload\ndownload\n',
        );
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    15_000,
  );
});
