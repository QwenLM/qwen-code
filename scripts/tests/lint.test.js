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
import { fileURLToPath } from 'node:url';
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

// The --write to --check flip in runPrettier() is the whole point of the
// Prettier lane: --write reformats in place and exits 0 whether or not
// anything changed, so the lane reported a pass on unformatted code for as
// long as it was there (#11109). Nothing else pins the flag —
// ci-platform-lanes.test.js asserts the step exists and is gated, not what it
// runs — so a refactor or a well-meant "make lint auto-fix again" could
// restore the silent pass with every suite green.
describe('prettier lane', () => {
  const repoRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
  );
  const lintSource = readFileSync(
    path.join(repoRoot, 'scripts', 'lint.js'),
    'utf8',
  );

  it('checks formatting rather than rewriting it', () => {
    expect(lintSource).toContain('prettier --experimental-cli --check .');
    expect(lintSource).not.toMatch(/prettier[^\n'"]*--write/);
  });

  // The gate and the remedy it points people at must resolve the same file
  // set. The classic CLI reads only the repo-root .gitignore while the
  // experimental one also honours nested ones, and this repo has 23 of those,
  // so a mismatch lets the lane go red on files `npm run format` cannot reach.
  it('uses the same Prettier CLI as npm run format', () => {
    const pkg = JSON.parse(
      readFileSync(path.join(repoRoot, 'package.json'), 'utf8'),
    );
    const formatIsExperimental =
      pkg.scripts.format.includes('--experimental-cli');
    const gateIsExperimental = lintSource.includes(
      'prettier --experimental-cli --check',
    );
    expect(gateIsExperimental).toBe(formatIsExperimental);
  });
});

// #12635: on the shared ECS runners $HOME persists across jobs, so
// `command -v yamllint` can resolve to a stale ~/.local/bin shim that no
// longer runs (interpreter upgrade, interrupted pip install) or to the
// wrong version — setup then skips the pinned reinstall and the Run
// yamllint step fails instantly with no lint output on a clean tree. The
// availability check must require the pinned version to actually run.
describe('yamllint availability check', () => {
  const repoRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
  );
  const lintSource = readFileSync(
    path.join(repoRoot, 'scripts', 'lint.js'),
    'utf8',
  );
  const pinnedVersion = /const YAMLLINT_VERSION = '([^']+)'/.exec(
    lintSource,
  )?.[1];
  // yamllint's is the only template-literal check; actionlint and
  // shellcheck use plain strings.
  const checkTemplate = /check: `([^`]+)`/.exec(lintSource)?.[1];
  const check = checkTemplate?.replaceAll(
    '${YAMLLINT_VERSION}',
    pinnedVersion ?? '',
  );

  it('requires the pinned yamllint version to run, not just to exist', () => {
    expect(pinnedVersion).toBeTruthy();
    expect(checkTemplate).toBeTruthy();
    expect(checkTemplate).toContain('yamllint --version');
    expect(lintSource).not.toContain('command -v yamllint');
  });

  it.skipIf(process.platform === 'win32')(
    'accepts only a running yamllint at the pinned version',
    () => {
      expect(check).toBeTruthy();
      const root = mkdtempSync(path.join(tmpdir(), 'yamllint-check-'));
      try {
        const binDir = path.join(root, 'bin');
        mkdirSync(binDir, { recursive: true });
        const env = { PATH: `${binDir}:/usr/bin:/bin` };
        const runCheck = () => spawnSync('sh', ['-c', check], { env }).status;
        const writeShim = (body) => {
          const shim = path.join(binDir, 'yamllint');
          writeFileSync(shim, body);
          chmodSync(shim, 0o755);
        };

        // Absent: install must run, as before.
        expect(runCheck()).not.toBe(0);

        // Present but fails when run: a stale broken shim must not satisfy
        // the check — the #12635 failure mode.
        writeShim('#!/bin/sh\nexit 1\n');
        expect(runCheck()).not.toBe(0);

        // Runs but reports another version: the tree is gated on the pin,
        // so setup must reinstall it.
        writeShim("#!/bin/sh\necho 'yamllint 0.0.0'\n");
        expect(runCheck()).not.toBe(0);

        // Runs and reports the pinned version: reuse it.
        writeShim(`#!/bin/sh\necho 'yamllint ${pinnedVersion}'\n`);
        expect(runCheck()).toBe(0);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
});
