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

// The 2026-09-24 main-CI failure: on runner ecs-qwen-hk4-19 the image's own
// yamllint satisfied `command -v yamllint`, so setup skipped the pinned
// install and the broken copy died the instant the Run yamllint step invoked
// it. The lane now probes the version (a missing, stale, or launch-crashing
// binary all fall through to the pinned install) and resolves the pip --user
// bin dir ahead of the inherited PATH so the pinned install is the one the
// lint step runs.
describe('yamllint lane', () => {
  const originalArgv = process.argv;

  beforeEach(() => {
    process.argv = ['node', 'scripts/lint.js', '--test-import'];
  });

  afterEach(() => {
    process.argv = originalArgv;
  });

  it.skipIf(process.platform === 'win32')(
    'accepts only the pinned yamllint version',
    async () => {
      const { getLinters } = await import('../lint.js');
      const { check, installer } = getLinters().yamllint;
      // The probe must accept exactly what the installer lays down.
      const pin = installer.match(/yamllint==(\d+\.\d+\.\d+)/)?.[1];
      expect(pin).toBeTruthy();
      expect(check).toContain(pin);

      const root = mkdtempSync(path.join(tmpdir(), 'yamllint-check-'));
      try {
        const binDir = path.join(root, 'bin');
        mkdirSync(binDir);
        const fake = path.join(binDir, 'yamllint');
        const status = () =>
          spawnSync(check, { shell: true, env: { PATH: binDir } }).status;

        // Absent from PATH: the pinned install must run.
        expect(status()).not.toBe(0);

        writeFileSync(fake, `#!/bin/sh\necho 'yamllint ${pin}'\n`);
        chmodSync(fake, 0o755);
        expect(status()).toBe(0);

        // A stale copy must trigger the pinned install, not satisfy it.
        writeFileSync(fake, "#!/bin/sh\necho 'yamllint 1.30.0'\n");
        expect(status()).not.toBe(0);

        // The ecs-qwen-hk4-19 failure mode: present for `command -v`, dead
        // on launch.
        writeFileSync(fake, '#!/bin/sh\nexit 1\n');
        expect(status()).not.toBe(0);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it('prefers the pip --user bin dir over the inherited PATH', async () => {
    const { getLinterPath } = await import('../lint.js');
    const env = { HOME: '/home/runner', PATH: '/usr/bin:/bin' };

    const linux = toPosix(
      getLinterPath({ env, platform: 'linux', cwd: '/repo' }),
    );
    expect(linux.startsWith('/repo/node_modules/.bin:')).toBe(true);
    expect(linux.indexOf('/home/runner/.local/bin')).toBeGreaterThan(-1);
    expect(linux.indexOf('/home/runner/.local/bin')).toBeLessThan(
      linux.indexOf('/usr/bin'),
    );

    const darwin = toPosix(
      getLinterPath({ env, platform: 'darwin', cwd: '/repo' }),
    );
    const darwinUserBin = '/home/runner/Library/Python/3.12/bin';
    expect(darwin.indexOf(darwinUserBin)).toBeGreaterThan(-1);
    expect(darwin.indexOf(darwinUserBin)).toBeLessThan(
      darwin.indexOf('/usr/bin'),
    );

    const win32 = toPosix(
      getLinterPath({ env, platform: 'win32', cwd: '/repo' }),
    );
    expect(win32).not.toContain('.local/bin');
    expect(win32.endsWith(':/usr/bin:/bin')).toBe(true);
  });

  it.skipIf(process.platform === 'win32')(
    'replaces a broken runner-image yamllint with the pinned install',
    () => {
      const repoRoot = path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),
        '..',
        '..',
      );
      const root = mkdtempSync(path.join(tmpdir(), 'yamllint-lane-'));
      try {
        const home = path.join(root, 'home');
        const imageBin = path.join(root, 'image-bin');
        const userBin =
          process.platform === 'darwin'
            ? path.join(home, 'Library', 'Python', '3.12', 'bin')
            : path.join(home, '.local', 'bin');
        const brokenLog = path.join(root, 'broken.log');
        const installedLog = path.join(root, 'installed.log');
        mkdirSync(imageBin, { recursive: true });
        mkdirSync(userBin, { recursive: true });

        // The image's yamllint dies on launch; the image's pip3 lays down a
        // healthy yamllint in the pip --user bin dir, like the real
        // installer. actionlint/shellcheck stubs keep setup off their
        // network installers.
        writeFileSync(
          path.join(imageBin, 'yamllint'),
          `#!/bin/sh\necho "$*" >> '${brokenLog}'\nexit 1\n`,
        );
        writeFileSync(
          path.join(imageBin, 'pip3'),
          `#!/bin/sh
cat > '${userBin}/yamllint' <<'EOF'
#!/bin/sh
echo "$*" >> '${installedLog}'
exit 0
EOF
chmod +x '${userBin}/yamllint'
`,
        );
        for (const tool of ['actionlint', 'shellcheck']) {
          writeFileSync(path.join(imageBin, tool), '#!/bin/sh\nexit 0\n');
        }
        for (const tool of ['yamllint', 'pip3', 'actionlint', 'shellcheck']) {
          chmodSync(path.join(imageBin, tool), 0o755);
        }

        const env = {
          ...process.env,
          HOME: home,
          RUNNER_TEMP: path.join(root, 'rt'),
          PATH: `${imageBin}:${process.env.PATH}`,
        };
        delete env.GITHUB_RUN_ID;
        delete env.GITHUB_RUN_ATTEMPT;
        delete env.GITHUB_JOB;

        const result = spawnSync(
          process.execPath,
          ['scripts/lint.js', '--setup', '--yamllint'],
          { cwd: repoRoot, env, encoding: 'utf8' },
        );
        if (result.status !== 0) {
          console.error(result.stdout);
          console.error(result.stderr);
        }
        expect(result.status).toBe(0);

        // The probe met the broken copy (--version); the lint run went to
        // the pinned install (--format).
        const brokenCalls = readFileSync(brokenLog, 'utf8');
        expect(brokenCalls).toContain('--version');
        expect(brokenCalls).not.toContain('--format');
        expect(readFileSync(installedLog, 'utf8')).toContain('--format');
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
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
