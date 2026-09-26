/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { execSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
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

// #12647 (2026-09-24, runner ecs-qwen-hk4-19): `git ls-files` died with
// "fatal: detected dubious ownership", so the git-sourced file list reached
// the lanes empty — yamllint failed on a zero-file invocation whose only
// output was its own usage screen, and shellcheck PASSED having linted
// nothing (its pipeline ends in sed, which swallows every upstream status).
// Both lanes now stage the list first and refuse to run on an empty one, so
// the lane fails on git's own error instead of a misleading usage screen or
// a false green. `xargs -r` alone would only convert the loud failure into
// the same false green, so it is deliberately not used.
describe('git-sourced lint lanes', () => {
  const originalArgv = process.argv;

  beforeEach(() => {
    process.argv = ['node', 'scripts/lint.js', '--test-import'];
  });

  afterEach(() => {
    process.argv = originalArgv;
  });

  // A scratch dir with a stub bin/ on PATH; when `files` is given, a real
  // git repo holding exactly those files (git ls-files reads the index, so
  // `git add` suffices — no commit needed).
  const setup = (files) => {
    const root = mkdtempSync(path.join(tmpdir(), 'lint-lanes-'));
    const bin = path.join(root, 'bin');
    mkdirSync(bin);
    let repo = root;
    if (files) {
      repo = path.join(root, 'repo');
      mkdirSync(repo);
      for (const [name, content] of Object.entries(files)) {
        writeFileSync(path.join(repo, name), content);
      }
      execSync('git init -q && git add -A', { cwd: repo });
    }
    return { root, repo, bin };
  };

  const stub = (bin, name, body) => {
    const file = path.join(bin, name);
    writeFileSync(file, `#!/bin/sh\n${body}\n`);
    chmodSync(file, 0o755);
  };

  const runLane = (run, { repo, bin }) =>
    spawnSync(run, {
      shell: true,
      cwd: repo,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
      encoding: 'utf8',
    });

  it.skipIf(process.platform === 'win32')(
    'yamllint fails on the git error and never runs yamllint when git ls-files fails',
    async () => {
      const { getLinters } = await import('../lint.js');
      const { root, repo, bin } = setup(null);
      try {
        const yamllintLog = path.join(root, 'yamllint.log');
        // The #12647 failure mode, verbatim.
        stub(
          bin,
          'git',
          "echo 'fatal: detected dubious ownership in repository' >&2\nexit 128",
        );
        stub(bin, 'yamllint', `echo "$@" >> '${yamllintLog}'`);

        const result = runLane(getLinters().yamllint.run, { repo, bin });
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain('dubious ownership');
        expect(result.stderr).toContain('git ls-files failed');
        expect(existsSync(yamllintLog)).toBe(false);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform === 'win32')(
    'yamllint refuses to lint an empty file list',
    async () => {
      const { getLinters } = await import('../lint.js');
      const { root, repo, bin } = setup({ 'index.js': 'console.log(1)\n' });
      try {
        const yamllintLog = path.join(root, 'yamllint.log');
        stub(bin, 'yamllint', `echo "$@" >> '${yamllintLog}'`);

        const result = runLane(getLinters().yamllint.run, { repo, bin });
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain('no yaml files');
        expect(existsSync(yamllintLog)).toBe(false);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform === 'win32')(
    'yamllint lints exactly the yaml files git lists',
    async () => {
      const { getLinters } = await import('../lint.js');
      const { root, repo, bin } = setup({
        'ci.yml': 'on: push\n',
        'deploy.yaml': '---\n',
        'index.js': 'console.log(1)\n',
      });
      try {
        const yamllintLog = path.join(root, 'yamllint.log');
        stub(bin, 'yamllint', `echo "$@" >> '${yamllintLog}'`);

        const result = runLane(getLinters().yamllint.run, { repo, bin });
        expect(result.status).toBe(0);
        const args = readFileSync(yamllintLog, 'utf8');
        expect(args).toContain('ci.yml');
        expect(args).toContain('deploy.yaml');
        expect(args).not.toContain('index.js');
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform === 'win32')(
    'shellcheck fails on the git error and never runs shellcheck when git ls-files fails',
    async () => {
      const { getLinters } = await import('../lint.js');
      const { root, repo, bin } = setup(null);
      try {
        const shellcheckLog = path.join(root, 'shellcheck.log');
        stub(
          bin,
          'git',
          "echo 'fatal: detected dubious ownership in repository' >&2\nexit 128",
        );
        stub(bin, 'file', 'exit 0');
        stub(bin, 'shellcheck', `echo "$@" >> '${shellcheckLog}'`);

        const result = runLane(getLinters().shellcheck.run, { repo, bin });
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain('dubious ownership');
        expect(result.stderr).toContain('git ls-files failed');
        expect(existsSync(shellcheckLog)).toBe(false);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform === 'win32')(
    'shellcheck refuses to pass when git lists no shell-script candidates',
    async () => {
      const { getLinters } = await import('../lint.js');
      // Only dotfiles: nothing matches the candidate grep.
      const { root, repo, bin } = setup({ '.yamllint.yml': '---\n' });
      try {
        const shellcheckLog = path.join(root, 'shellcheck.log');
        stub(bin, 'file', 'exit 0');
        stub(bin, 'shellcheck', `echo "$@" >> '${shellcheckLog}'`);

        const result = runLane(getLinters().shellcheck.run, { repo, bin });
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain('no shell-script candidates');
        expect(existsSync(shellcheckLog)).toBe(false);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform === 'win32')(
    'shellcheck refuses to pass when no shell scripts are detected',
    async () => {
      const { getLinters } = await import('../lint.js');
      const { root, repo, bin } = setup({ 'README.md': '# hi\n' });
      try {
        const shellcheckLog = path.join(root, 'shellcheck.log');
        stub(
          bin,
          'file',
          '[ "$1" = "--mime-type" ] && shift\nfor f in "$@"; do echo "$f: text/plain"; done',
        );
        stub(bin, 'shellcheck', `echo "$@" >> '${shellcheckLog}'`);

        const result = runLane(getLinters().shellcheck.run, { repo, bin });
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain('no shell scripts');
        expect(existsSync(shellcheckLog)).toBe(false);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform === 'win32')(
    'shellcheck lints exactly the files file(1) detects as shell scripts',
    async () => {
      const { getLinters } = await import('../lint.js');
      const { root, repo, bin } = setup({
        'tool.sh': '#!/bin/sh\necho hi\n',
        'main.js': 'console.log(1)\n',
      });
      try {
        const shellcheckLog = path.join(root, 'shellcheck.log');
        stub(
          bin,
          'file',
          '[ "$1" = "--mime-type" ] && shift\nfor f in "$@"; do\n  case "$f" in\n    *.sh) echo "$f: text/x-shellscript";;\n    *) echo "$f: text/plain";;\n  esac\ndone',
        );
        stub(bin, 'shellcheck', `echo "$@" >> '${shellcheckLog}'`);

        const result = runLane(getLinters().shellcheck.run, { repo, bin });
        expect(result.status).toBe(0);
        const args = readFileSync(shellcheckLog, 'utf8');
        expect(args).toContain('tool.sh');
        expect(args).not.toContain('main.js');
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it('appends the pip --user bin dir after the inherited PATH', async () => {
    const { getLinterPath } = await import('../lint.js');
    const env = { HOME: '/home/runner', PATH: '/usr/bin:/bin' };

    const linux = toPosix(
      getLinterPath({ env, platform: 'linux', cwd: '/repo' }),
    );
    expect(linux.startsWith('/repo/node_modules/.bin:')).toBe(true);
    expect(linux.indexOf('/home/runner/.local/bin')).toBeGreaterThan(
      linux.indexOf('/usr/bin'),
    );

    const darwin = toPosix(
      getLinterPath({ env, platform: 'darwin', cwd: '/repo' }),
    );
    const darwinUserBin = '/home/runner/Library/Python/3.12/bin';
    expect(darwin.indexOf(darwinUserBin)).toBeGreaterThan(-1);
    expect(darwin.indexOf(darwinUserBin)).toBeGreaterThan(
      darwin.indexOf('/usr/bin'),
    );

    const win32 = toPosix(
      getLinterPath({ env, platform: 'win32', cwd: '/repo' }),
    );
    expect(win32).not.toContain('.local/bin');
    expect(win32.endsWith(':/usr/bin:/bin')).toBe(true);
  });
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
