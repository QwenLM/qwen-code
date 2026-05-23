/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';

const {
  appendFileSync,
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} = await vi.importActual('node:fs');
const { execFileSync } = await vi.importActual('node:child_process');
const crypto = await vi.importActual('node:crypto');
const { tmpdir } = await vi.importActual('node:os');
const path = await vi.importActual('node:path');
const { pathToFileURL } = await vi.importActual('node:url');
const readScript = (path) => readFileSync(path, 'utf8');
const standaloneReleaseScriptUrl = pathToFileURL(
  path.resolve('scripts/build-standalone-release.js'),
).href;
// These E2E cases execute the Unix shell installer and POSIX symlink behavior.
// Windows batch behavior has separate Windows-only E2E coverage below.
const itOnUnix = process.platform === 'win32' ? it.skip : it;
const itOnWindows = process.platform === 'win32' ? it : it.skip;

describe('installation scripts', () => {
  it('keeps the Linux/macOS installer lightweight', () => {
    const script = readScript(
      'scripts/installation/install-qwen-with-source.sh',
    );

    expect(script).not.toContain('install_nvm');
    expect(script).not.toContain('install_nvm.sh');
    expect(script).not.toContain('nvm install');
    expect(script).not.toContain('NVM_NODEJS_ORG_MIRROR');
    expect(script).not.toContain('npm config set prefix');
    expect(script).not.toContain('clean_npmrc_conflict');
    expect(script).not.toContain('.npmrc');
    expect(script).not.toContain('.npm-global');
    expect(script).not.toMatch(/^\s*exec\s+qwen\s*$/m);
    expect(script).not.toContain('--print-env');
    expect(script).not.toContain('brew install node@20');
    expect(script).toContain('brew install node');
    expect(script).toContain(
      '--source may only contain letters, numbers, dot, underscore, or dash',
    );
    expect(script).toContain('Node.js 20 or newer is required');
    expect(script).toContain(
      'npm install -g @qwen-code/qwen-code@latest --registry',
    );
    expect(script).toContain('You can now run: qwen');
  });

  it('supports code-server-style standalone install on Linux/macOS', () => {
    const script = readScript(
      'scripts/installation/install-qwen-with-source.sh',
    );

    expect(script).toContain('--method METHOD');
    expect(script).toContain('--mirror MIRROR');
    expect(script).toContain('--base-url URL');
    expect(script).toContain('--archive PATH');
    expect(script).toContain('install_standalone()');
    expect(script).toContain('install_npm()');
    expect(script).toContain('detect_target()');
    expect(script).toContain('verify_checksum()');
    expect(script).toContain('SHA256SUMS not found; cannot verify archive');
    expect(script).toContain('awk -v archive_name');
    expect(script).not.toContain(
      'grep -E "(^|[[:space:]])[*]?${archive_name}$"',
    );
    expect(script).toContain('validate_archive_contents()');
    expect(script).toContain('Archive contains unsafe path');
    expect(script).toContain('qwen-code-${target}');
    expect(script).toContain('*.tar.xz)');
    expect(script).toContain('METHOD="${METHOD:-detect}"');
    expect(script).toContain('must start with https://');
    expect(script).toContain('Falling back to npm installation');
    expect(script).toContain('standalone_status=$?');
    expect(script).toContain('[[ "${standalone_status}" -eq 2 ]]');
    expect(script).toContain(
      'Standalone install failed. Retry with --method npm',
    );
    expect(script).not.toContain('ln -sf "${INSTALL_LIB_DIR}/bin/qwen"');
    expect(script).toContain('shell_quote()');
    expect(script).toContain('exec ${quoted_qwen_bin} "\\$@"');
    expect(script).toContain('validate_version()');
    expect(script).toContain('validate_install_path');
    expect(script).toContain('validate_https_url "${NPM_REGISTRY}"');
    expect(script).toContain('qwen-code/node/bin/node');
    expect(script).toContain('Archive contains symlinks; refusing to install');
    expect(script).toContain('not a Qwen Code standalone install');
    expect(script).toContain(
      'Return 2 only when a standalone archive is unavailable',
    );
    expect(script).toContain('npm fallback also failed');
    expect(script).toContain(
      'unzip -q "${archive_path}" -d "${destination}" || return 1',
    );
    expect(script).toContain(
      'tar -xzf "${archive_path}" -C "${destination}" || return 1',
    );
    expect(script).toContain('wget -q --tries=3 "${url}" -O "${destination}"');
    expect(script).toContain('TEMP_DIRS+=');
    expect(script).not.toContain('-print -quit');
  });

  it('keeps the Windows installer lightweight', () => {
    const script = readScript(
      'scripts/installation/install-qwen-with-source.bat',
    );

    expect(script).not.toContain('InstallNodeJSDirectly');
    expect(script).not.toContain('node-v!NODE_VERSION!');
    expect(script).not.toContain('msiexec');
    expect(script).not.toContain('Invoke-WebRequest');
    expect(script).not.toContain('PowerShell (Administrator)');
    expect(script).not.toContain('echo INFO: Installation source: %SOURCE%');
    expect(script).not.toMatch(/^\s*call\s+qwen\s*$/m);
    expect(script).toContain(':ValidateSource');
    expect(script).toContain(':PrintUsage');
    expect(script).toContain('findstr /R');
    expect(script).toContain(
      '--source may only contain letters, numbers, dot, underscore, or dash',
    );
    expect(script).toContain('Node.js 20 or newer is required');
    expect(script).toContain('Please install Node.js');
    expect(script).toContain(
      'npm install -g @qwen-code/qwen-code@latest --registry',
    );
    expect(script).toContain('You can now run: qwen');
  });

  it('supports code-server-style standalone install on Windows', () => {
    const script = readScript(
      'scripts/installation/install-qwen-with-source.bat',
    );

    expect(script).toContain('--method METHOD');
    expect(script).toContain('--mirror MIRROR');
    expect(script).toContain('--base-url URL');
    expect(script).toContain('--archive PATH');
    expect(script).toContain(':InstallStandalone');
    expect(script).toContain(':InstallNpm');
    expect(script).toContain(':VerifyChecksum');
    expect(script).toContain('SHA256SUMS not found; cannot verify archive');
    expect(script).toContain('Get-FileHash -Algorithm SHA256');
    expect(script).toContain('tokens=1,2');
    expect(script).toContain('CHECKSUM_NAME');
    expect(script).toContain('if "!CHECKSUM_NAME!"=="!ARCHIVE_NAME!"');
    expect(script).not.toContain('findstr /C:"!ARCHIVE_NAME!"');
    expect(script).not.toContain('certutil -hashfile');
    expect(script).toContain('qwen-code-win-x64.zip');
    expect(script).toContain('Expand-Archive');
    expect(script).toContain('$env:QWEN_DOWNLOAD_URL');
    expect(script).toContain('$env:QWEN_ARCHIVE_FILE');
    expect(script).toContain(
      'if defined QWEN_INSTALL_ROOT set "INSTALL_BASE=!QWEN_INSTALL_ROOT!"',
    );
    expect(script).not.toContain('%QWEN_INSTALL_ROOT%');
    expect(script).toContain('set "QWEN_VALIDATE_INSTALL_BASE=!INSTALL_BASE!"');
    expect(script).toContain(
      'installer options contain unsafe command characters',
    );
    expect(script).toContain('[char[]](10,13,33,34');
    expect(script).toContain('if "!INSTALL_BASE:~1,2!"==":/"');
    expect(script).toContain('if "!INSTALL_DIR:~1,2!"==":/"');
    expect(script).toContain('if "!INSTALL_BIN_DIR:~1,2!"==":/"');
    expect(script).toContain(':ValidateVersion');
    expect(script).toContain(
      'call :ValidateHttpsUrlVar "NPM_REGISTRY" "--registry"',
    );
    expect(script).toContain("$ErrorActionPreference = 'Stop'; try");
    expect(script).toContain(
      '[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; $request = [Net.WebRequest]::Create($env:QWEN_CHECK_URL)',
    );
    expect(script).toContain('must start with https://');
    expect(script).toContain('Falling back to npm installation');
    expect(script).toContain('set "STANDALONE_STATUS=!ERRORLEVEL!"');
    expect(script).toContain('if !STANDALONE_STATUS! EQU 2');
    expect(script).toContain(
      'Standalone install failed. Retry with --method npm',
    );
    expect(script).toContain('qwen-code\\node\\node.exe');
    expect(script).toContain('Archive contains symlinks or reparse points');
    expect(script).toContain('QWEN_INSTALL_ROOT');
    expect(script).toContain('npm fallback also failed');
  });
});

describe('standalone release packaging', () => {
  it('defines a standalone packaging script', () => {
    const packageJson = JSON.parse(readScript('package.json'));

    expect(packageJson.scripts['package:standalone']).toBe(
      'node scripts/create-standalone-package.js',
    );
    expect(packageJson.scripts['package:standalone:release']).toBe(
      'node scripts/build-standalone-release.js',
    );
    expect(existsSync('scripts/create-standalone-package.js')).toBe(true);
    expect(existsSync('scripts/build-standalone-release.js')).toBe(true);

    const packageScript = readScript('scripts/create-standalone-package.js');
    expect(packageScript).toContain('Copyright 2025 Qwen Team');
    expect(packageScript).toContain("'bundled/qc-helper/docs'");
    expect(packageScript).toContain('DIST_ALLOWED_ENTRIES');
    expect(packageScript).toContain('Unexpected dist asset');
    expect(packageScript).toContain('topLevelDistEntryForPath(outDir)');
    expect(packageScript).toContain("path.join(packageRoot, 'package.json')");
    expect(packageScript).toContain('validateNodeRuntime');
    expect(packageScript).toContain('copyNodeRuntimeEntry');
    expect(packageScript).toContain('symlink cycle');
    expect(packageScript).toContain('refusing to write empty SHA256SUMS');
    expect(packageScript).toContain('--skip-checksums');
    expect(packageScript).toContain('dereference: true');
    expect(packageScript).toContain('fs.createReadStream');
    expect(packageScript).toContain('Expand-Archive');
    expect(packageScript).toContain('Compress-Archive');

    const releaseScript = readScript('scripts/build-standalone-release.js');
    expect(releaseScript).toContain('Copyright 2025 Qwen Team');
    expect(releaseScript).toContain('https://nodejs.org/dist/v${nodeVersion}');
    expect(releaseScript).toContain('SHASUMS256.txt');
    expect(releaseScript).toContain('verifyNodeArchive');
    expect(releaseScript).toContain(
      'EXPECTED_ARCHIVE_COUNT = RELEASE_TARGETS.length',
    );
    expect(releaseScript).toContain('nodeArchiveExtension');
    expect(releaseScript).toContain('fs.createReadStream');
    expect(releaseScript).toContain('expectedArchiveNames');
    expect(releaseScript).toContain('qwen-code-${qwenTarget}');
    expect(releaseScript).toContain('scripts/create-standalone-package.js');
    expect(releaseScript).toContain('--skip-checksums');
    expect(releaseScript).toContain('writeSha256Sums(outDir)');
  });

  it('loads the standalone release packaging helper', () => {
    const output = execFileSync(
      process.execPath,
      ['scripts/build-standalone-release.js', '--help'],
      { encoding: 'utf8' },
    );

    expect(output).toContain('package:standalone:release');
    expect(output).toContain('--node-version VERSION');
  });

  it('parses Node.js SHASUMS entries', async () => {
    const { parseChecksums } = await import(standaloneReleaseScriptUrl);

    const checksums = parseChecksums(
      [
        'a'.repeat(64) + '  node-v20.19.0-linux-x64.tar.xz',
        'b'.repeat(64) + ' *node-v20.19.0-win-x64.zip',
        '',
      ].join('\n'),
    );

    expect(checksums.get('node-v20.19.0-linux-x64.tar.xz')).toBe(
      'a'.repeat(64),
    );
    expect(checksums.get('node-v20.19.0-win-x64.zip')).toBe('b'.repeat(64));
  });

  it('validates standalone release checksum output', async () => {
    const { assertStandaloneOutput, RELEASE_TARGETS } = await import(
      standaloneReleaseScriptUrl
    );
    const tmpDir = mkdtempSync(path.join(tmpdir(), 'qwen-release-test-'));

    try {
      const lines = RELEASE_TARGETS.map(({ qwenTarget }) => {
        const extension = qwenTarget === 'win-x64' ? 'zip' : 'tar.gz';
        return `${'a'.repeat(64)}  qwen-code-${qwenTarget}.${extension}`;
      });
      writeFileSync(path.join(tmpDir, 'SHA256SUMS'), `${lines.join('\n')}\n`);

      expect(() => assertStandaloneOutput(tmpDir)).not.toThrow();

      writeFileSync(
        path.join(tmpDir, 'SHA256SUMS'),
        `${lines.join('\n')}\n${'b'.repeat(64)}  qwen-code-extra.tar.gz\n`,
      );
      expect(() => assertStandaloneOutput(tmpDir)).toThrow(/Extra/);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('rejects a runtime archive without a Node executable', () => {
    const createdDist = ensureMinimalDist();
    const tmpDir = mkdtempSync(path.join(tmpdir(), 'qwen-package-test-'));

    try {
      const target = process.platform === 'win32' ? 'win-x64' : 'linux-x64';
      const fakeRuntimeArchive =
        process.platform === 'win32'
          ? createBadWindowsNodeArchive(tmpDir)
          : createBadUnixNodeArchive(tmpDir);

      expect(() =>
        execFileSync(
          'node',
          [
            'scripts/create-standalone-package.js',
            '--target',
            target,
            '--node-archive',
            fakeRuntimeArchive,
            '--out-dir',
            path.join(tmpDir, 'out'),
            '--version',
            '0.0.0-test',
          ],
          { stdio: 'pipe' },
        ),
      ).toThrow(/Node\.js runtime for .* must contain/);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
      if (createdDist) {
        rmSync('dist', { recursive: true, force: true });
      }
    }
  });

  it('packages a win-x64 standalone archive', () => {
    const createdDist = ensureMinimalDist();
    const tmpDir = mkdtempSync(path.join(tmpdir(), 'qwen-package-test-'));

    try {
      const outDir = path.join(tmpDir, 'out');
      execFileSync(
        'node',
        [
          'scripts/create-standalone-package.js',
          '--target',
          'win-x64',
          '--node-archive',
          createFakeWindowsNodeArchive(tmpDir),
          '--out-dir',
          outDir,
          '--version',
          '0.0.0-test',
        ],
        { stdio: 'pipe' },
      );

      const archive = path.join(outDir, 'qwen-code-win-x64.zip');
      const extractDir = path.join(tmpDir, 'extract');
      mkdirSync(extractDir, { recursive: true });
      extractZipForTest(archive, extractDir);

      expect(existsSync(path.join(extractDir, 'qwen-code'))).toBe(true);
      expect(
        existsSync(path.join(extractDir, 'qwen-code', 'bin', 'qwen.cmd')),
      ).toBe(true);
      expect(
        existsSync(path.join(extractDir, 'qwen-code', 'node', 'node.exe')),
      ).toBe(true);
      expect(readScript(path.join(outDir, 'SHA256SUMS'))).toContain(
        'qwen-code-win-x64.zip',
      );
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
      if (createdDist) {
        rmSync('dist', { recursive: true, force: true });
      }
    }
  }, 30_000);

  itOnUnix('dereferences safe Node.js runtime symlinks', () => {
    const createdDist = ensureMinimalDist();
    const tmpDir = mkdtempSync(path.join(tmpdir(), 'qwen-package-test-'));

    try {
      const archive = packageFakeStandalone(tmpDir, {
        withSafeNodeSymlink: true,
      });
      const installRoot = path.join(tmpDir, 'install');
      runUnixInstaller(archive, installRoot, path.join(tmpDir, 'home'));

      const npmShim = path.join(
        installRoot,
        'lib',
        'qwen-code',
        'node',
        'bin',
        'npm',
      );
      expect(existsSync(npmShim)).toBe(true);
      expect(lstatSync(npmShim).isSymbolicLink()).toBe(false);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
      if (createdDist) {
        rmSync('dist', { recursive: true, force: true });
      }
    }
  });

  itOnUnix('rejects Node.js runtime symlinks that escape the archive', () => {
    const createdDist = ensureMinimalDist();
    const tmpDir = mkdtempSync(path.join(tmpdir(), 'qwen-package-test-'));

    try {
      expect(() =>
        execFileSync(
          'node',
          [
            'scripts/create-standalone-package.js',
            '--target',
            'linux-x64',
            '--node-archive',
            createFakeNodeArchive(tmpDir, {
              withEscapingNodeSymlink: true,
            }),
            '--out-dir',
            path.join(tmpDir, 'out'),
            '--version',
            '0.0.0-test',
          ],
          { stdio: 'pipe' },
        ),
      ).toThrow(/symlink escapes the archive/);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
      if (createdDist) {
        rmSync('dist', { recursive: true, force: true });
      }
    }
  });

  itOnUnix('rejects Node.js runtime symlink cycles', () => {
    const createdDist = ensureMinimalDist();
    const tmpDir = mkdtempSync(path.join(tmpdir(), 'qwen-package-test-'));

    try {
      expect(() =>
        execFileSync(
          'node',
          [
            'scripts/create-standalone-package.js',
            '--target',
            'linux-x64',
            '--node-archive',
            createFakeNodeArchive(tmpDir, {
              withNodeSymlinkCycle: true,
            }),
            '--out-dir',
            path.join(tmpDir, 'out'),
            '--version',
            '0.0.0-test',
          ],
          { stdio: 'pipe' },
        ),
      ).toThrow(/symlink cycle/);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
      if (createdDist) {
        rmSync('dist', { recursive: true, force: true });
      }
    }
  });

  it('rejects unexpected dist assets', () => {
    const createdDist = ensureMinimalDist();
    const tmpDir = mkdtempSync(path.join(tmpdir(), 'qwen-package-test-'));

    try {
      writeFileSync('dist/debug-cache.tmp', 'debug\n');

      expect(() =>
        execFileSync(
          'node',
          [
            'scripts/create-standalone-package.js',
            '--target',
            'win-x64',
            '--node-archive',
            createFakeWindowsNodeArchive(tmpDir),
            '--out-dir',
            path.join(tmpDir, 'out'),
            '--version',
            '0.0.0-test',
          ],
          { stdio: 'pipe' },
        ),
      ).toThrow(/Unexpected dist asset/);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
      if (createdDist) {
        rmSync('dist', { recursive: true, force: true });
      } else {
        rmSync('dist/debug-cache.tmp', { force: true });
      }
    }
  });

  it('uploads standalone archives during release', () => {
    const workflow = readScript('.github/workflows/release.yml');

    expect(workflow).toContain('npm run package:standalone:release --');
    expect(workflow).not.toContain('verify_node_checksum()');
    expect(workflow).not.toContain('download_node()');
    expect(workflow).toContain('dist/standalone/qwen-code-*');
    expect(workflow).toContain('dist/standalone/SHA256SUMS');
  });

  it('does not whitelist internal planning documents in gitignore', () => {
    const gitignore = readScript('.gitignore');

    expect(gitignore).not.toContain('!.qwen/design/');
    expect(gitignore).not.toContain('!.qwen/e2e-tests/');
  });

  it('documents optional native module parity for standalone installs', () => {
    const guide = readScript('scripts/installation/INSTALLATION_GUIDE.md');

    expect(guide).toContain('Optional Native Modules');
    expect(guide).toContain('node-pty');
    expect(guide).toContain('clipboard');
  });
});

describe('Linux/macOS installer end-to-end', () => {
  itOnUnix(
    'installs a local standalone archive with checksum verification',
    () => {
      const createdDist = ensureMinimalDist();
      const tmpDir = mkdtempSync(path.join(tmpdir(), 'qwen-install-test-'));

      try {
        const archive = packageFakeStandalone(tmpDir);
        const installRoot = path.join(tmpDir, 'install');
        const home = path.join(tmpDir, 'home');
        runUnixInstaller(archive, installRoot, home);

        expect(existsSync(path.join(installRoot, 'bin', 'qwen'))).toBe(true);
        expect(
          existsSync(
            path.join(installRoot, 'lib', 'qwen-code', 'node', 'bin', 'node'),
          ),
        ).toBe(true);
        expect(readScript(path.join(home, '.qwen', 'source.json'))).toContain(
          '"source": "smoke"',
        );

        const version = execFileSync(path.join(installRoot, 'bin', 'qwen'), [
          '--version',
        ])
          .toString()
          .trim();
        expect(version).toBe('0.0.0-smoke');
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
        if (createdDist) {
          rmSync('dist', { recursive: true, force: true });
        }
      }
    },
  );

  itOnUnix('shell-quotes custom install paths in the generated wrapper', () => {
    const createdDist = ensureMinimalDist();
    const tmpDir = mkdtempSync(path.join(tmpdir(), 'qwen-install-test-'));

    try {
      const archive = packageFakeStandalone(tmpDir);
      const installRoot = path.join(tmpDir, 'install');
      const home = path.join(tmpDir, 'home');
      const installLibDir = path.join(
        installRoot,
        'lib',
        'qwen-code$(touch qwen-pwned)',
      );

      runUnixInstaller(archive, installRoot, home, 'standalone', {
        QWEN_INSTALL_LIB_DIR: installLibDir,
      });

      const version = execFileSync(
        path.join(installRoot, 'bin', 'qwen'),
        ['--version'],
        {
          cwd: tmpDir,
        },
      )
        .toString()
        .trim();
      expect(version).toBe('0.0.0-smoke');
      expect(existsSync(path.join(tmpDir, 'qwen-pwned'))).toBe(false);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
      if (createdDist) {
        rmSync('dist', { recursive: true, force: true });
      }
    }
  });

  itOnUnix('rejects a tampered local archive', () => {
    const createdDist = ensureMinimalDist();
    const tmpDir = mkdtempSync(path.join(tmpdir(), 'qwen-install-test-'));

    try {
      const archive = packageFakeStandalone(tmpDir);
      appendFileSync(archive, 'tamper');

      expect(() =>
        runUnixInstaller(
          archive,
          path.join(tmpDir, 'install'),
          path.join(tmpDir, 'home'),
        ),
      ).toThrow(/Checksum verification failed/);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
      if (createdDist) {
        rmSync('dist', { recursive: true, force: true });
      }
    }
  });

  itOnUnix('rejects a local archive when SHA256SUMS is missing', () => {
    const createdDist = ensureMinimalDist();
    const tmpDir = mkdtempSync(path.join(tmpdir(), 'qwen-install-test-'));

    try {
      const archive = packageFakeStandalone(tmpDir);
      rmSync(path.join(path.dirname(archive), 'SHA256SUMS'), { force: true });

      expect(() =>
        runUnixInstaller(
          archive,
          path.join(tmpDir, 'install'),
          path.join(tmpDir, 'home'),
        ),
      ).toThrow(/SHA256SUMS not found/);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
      if (createdDist) {
        rmSync('dist', { recursive: true, force: true });
      }
    }
  });

  itOnUnix('rejects standalone archives containing symlinks', () => {
    const tmpDir = mkdtempSync(path.join(tmpdir(), 'qwen-install-test-'));

    try {
      const archive = createSymlinkStandaloneArchive(tmpDir);

      expect(() =>
        runUnixInstaller(
          archive,
          path.join(tmpDir, 'install'),
          path.join(tmpDir, 'home'),
        ),
      ).toThrow(/Archive contains symlinks/);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  itOnUnix(
    'rejects standalone archives containing path traversal entries',
    () => {
      const tmpDir = mkdtempSync(path.join(tmpdir(), 'qwen-install-test-'));

      try {
        const archive = createTraversalStandaloneArchive(tmpDir);

        expect(() =>
          runUnixInstaller(
            archive,
            path.join(tmpDir, 'install'),
            path.join(tmpDir, 'home'),
          ),
        ).toThrow(/Archive contains unsafe path/);
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    },
  );

  itOnUnix('refuses to overwrite a non-managed install directory', () => {
    const createdDist = ensureMinimalDist();
    const tmpDir = mkdtempSync(path.join(tmpdir(), 'qwen-install-test-'));

    try {
      const archive = packageFakeStandalone(tmpDir);
      const installRoot = path.join(tmpDir, 'install');
      const installDir = path.join(installRoot, 'lib', 'qwen-code');
      mkdirSync(installDir, { recursive: true });
      writeFileSync(path.join(installDir, 'important.txt'), 'keep me\n');

      expect(() =>
        runUnixInstaller(archive, installRoot, path.join(tmpDir, 'home')),
      ).toThrow(/not a Qwen Code standalone install/);
      expect(readScript(path.join(installDir, 'important.txt'))).toBe(
        'keep me\n',
      );
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
      if (createdDist) {
        rmSync('dist', { recursive: true, force: true });
      }
    }
  });

  itOnUnix('does not fall back to npm when detect finds a bad archive', () => {
    const createdDist = ensureMinimalDist();
    const tmpDir = mkdtempSync(path.join(tmpdir(), 'qwen-install-test-'));

    try {
      const archive = packageFakeStandalone(tmpDir);
      appendFileSync(archive, 'tamper');

      let failureMessage = '';
      try {
        runUnixInstaller(
          archive,
          path.join(tmpDir, 'install'),
          path.join(tmpDir, 'home'),
          'detect',
        );
      } catch (error) {
        failureMessage = error.message;
      }

      expect(failureMessage).toContain('Checksum verification failed');
      expect(failureMessage).toContain('Standalone install failed');
      expect(failureMessage).not.toContain('Falling back to npm installation');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
      if (createdDist) {
        rmSync('dist', { recursive: true, force: true });
      }
    }
  });

  itOnUnix(
    'falls back to npm in detect mode when archive is unavailable',
    () => {
      const tmpDir = mkdtempSync(path.join(tmpdir(), 'qwen-install-test-'));

      try {
        const fakeBin = path.join(tmpDir, 'bin');
        const home = path.join(tmpDir, 'home');
        const npmLog = path.join(tmpDir, 'npm-args.txt');
        mkdirSync(fakeBin, { recursive: true });
        mkdirSync(home, { recursive: true });

        writeFileSync(
          path.join(fakeBin, 'curl'),
          '#!/usr/bin/env sh\nexit 22\n',
        );
        writeFileSync(
          path.join(fakeBin, 'node'),
          [
            '#!/usr/bin/env sh',
            'if [ "$1" = "-p" ]; then',
            '  case "$2" in',
            '    *split*) echo 20 ;;',
            '    *) echo 20.19.0 ;;',
            '  esac',
            '  exit 0',
            'fi',
            'exit 0',
            '',
          ].join('\n'),
        );
        writeFileSync(
          path.join(fakeBin, 'npm'),
          [
            '#!/usr/bin/env sh',
            'case "$1" in',
            '  -v) echo 10.0.0 ;;',
            '  prefix) echo "$QWEN_FAKE_NPM_PREFIX" ;;',
            '  install) printf "%s\\n" "$*" > "$QWEN_FAKE_NPM_LOG" ;;',
            'esac',
            'exit 0',
            '',
          ].join('\n'),
        );
        writeFileSync(
          path.join(fakeBin, 'qwen'),
          '#!/usr/bin/env sh\necho 0.0.0-npm\n',
        );
        for (const command of ['curl', 'node', 'npm', 'qwen']) {
          chmodSync(path.join(fakeBin, command), 0o755);
        }

        const output = execFileSync(
          'bash',
          [
            'scripts/installation/install-qwen-with-source.sh',
            '--method',
            'detect',
            '--base-url',
            'https://example.invalid/qwen-code',
            '--source',
            'smoke',
          ],
          {
            env: {
              ...process.env,
              HOME: home,
              PATH: `${fakeBin}:${process.env.PATH}`,
              QWEN_FAKE_NPM_LOG: npmLog,
              QWEN_FAKE_NPM_PREFIX: path.join(tmpDir, 'npm-prefix'),
            },
            stdio: 'pipe',
          },
        ).toString();

        expect(output).toContain('Falling back to npm installation');
        expect(readScript(npmLog)).toContain(
          'install -g @qwen-code/qwen-code@latest --registry',
        );
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    },
  );

  itOnUnix('preserves context when npm fallback also fails', () => {
    const tmpDir = mkdtempSync(path.join(tmpdir(), 'qwen-install-test-'));

    try {
      const fakeBin = path.join(tmpDir, 'bin');
      mkdirSync(fakeBin, { recursive: true });
      writeFileSync(path.join(fakeBin, 'curl'), '#!/usr/bin/env sh\nexit 22\n');
      chmodSync(path.join(fakeBin, 'curl'), 0o755);

      let failureMessage = '';
      try {
        execFileSync(
          'bash',
          [
            'scripts/installation/install-qwen-with-source.sh',
            '--method',
            'detect',
            '--base-url',
            'https://example.invalid/qwen-code',
            '--source',
            'smoke',
          ],
          {
            env: {
              HOME: path.join(tmpDir, 'home'),
              PATH: `${fakeBin}:/usr/bin:/bin`,
            },
            stdio: 'pipe',
          },
        );
      } catch (error) {
        failureMessage = [
          error.message,
          error.stdout?.toString() || '',
          error.stderr?.toString() || '',
        ].join('\n');
      }

      expect(failureMessage).toContain('Falling back to npm installation');
      expect(failureMessage).toMatch(
        /Node\.js was not found|Unable to determine Node\.js version/,
      );
      expect(failureMessage).toContain('npm fallback also failed');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('Windows installer end-to-end', () => {
  itOnWindows(
    'installs a local standalone archive with checksum verification',
    () => {
      const tmpDir = mkdtempSync(path.join(tmpdir(), 'qwen-install-test-'));

      try {
        const archive = createFakeWindowsStandaloneArchive(tmpDir);
        const installRoot = path.join(tmpDir, 'install');
        const home = path.join(tmpDir, 'home');
        runWindowsInstaller(archive, installRoot, home);

        expect(existsSync(path.join(installRoot, 'bin', 'qwen.cmd'))).toBe(
          true,
        );
        expect(
          existsSync(path.join(installRoot, 'qwen-code', 'node', 'node.exe')),
        ).toBe(true);
        expect(readScript(path.join(home, '.qwen', 'source.json'))).toContain(
          '"source": "smoke"',
        );

        const version = runWindowsCommand(
          `call "${path.join(installRoot, 'bin', 'qwen.cmd')}" --version`,
          { USERPROFILE: home },
        )
          .toString()
          .trim();
        expect(version).toBe('0.0.0-smoke');
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    },
  );

  itOnWindows('rejects a tampered local archive', () => {
    const tmpDir = mkdtempSync(path.join(tmpdir(), 'qwen-install-test-'));

    try {
      const archive = createFakeWindowsStandaloneArchive(tmpDir);
      appendFileSync(archive, 'tamper');

      expect(() =>
        runWindowsInstaller(
          archive,
          path.join(tmpDir, 'install'),
          path.join(tmpDir, 'home'),
        ),
      ).toThrow(/Checksum verification failed/);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  itOnWindows('rejects unsafe environment-derived install paths', () => {
    const tmpDir = mkdtempSync(path.join(tmpdir(), 'qwen-install-test-'));

    try {
      const archive = createFakeWindowsStandaloneArchive(tmpDir);
      const marker = path.join(tmpDir, 'pwned.txt');

      expect(() =>
        runWindowsInstaller(
          archive,
          path.join(tmpDir, 'install'),
          path.join(tmpDir, 'home'),
          'standalone',
          {
            QWEN_INSTALL_ROOT: `${path.join(tmpDir, 'install')}" & echo pwned > "${marker}" & "`,
          },
        ),
      ).toThrow(/unsafe command characters/);
      expect(existsSync(marker)).toBe(false);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

function ensureMinimalDist() {
  if (existsSync('dist')) {
    return false;
  }

  mkdirSync('dist/vendor', { recursive: true });
  mkdirSync('dist/bundled/qc-helper/docs', { recursive: true });
  writeFileSync('dist/cli.js', 'console.log("qwen");\n');
  writeFileSync(
    'dist/package.json',
    JSON.stringify({ name: '@qwen-code/qwen-code', version: '0.0.0' }),
  );
  return true;
}

function createFakeNodeArchive(tmpDir, options = {}) {
  const fakeNodeDir = path.join(tmpDir, 'node-v20.0.0-linux-x64');
  mkdirSync(path.join(fakeNodeDir, 'bin'), { recursive: true });
  writeFileSync(
    path.join(fakeNodeDir, 'bin', 'node'),
    '#!/usr/bin/env sh\necho 0.0.0-smoke\n',
  );
  chmodSync(path.join(fakeNodeDir, 'bin', 'node'), 0o755);

  if (options.withSafeNodeSymlink) {
    mkdirSync(path.join(fakeNodeDir, 'lib'), { recursive: true });
    writeFileSync(path.join(fakeNodeDir, 'lib', 'npm-cli.js'), 'npm cli\n');
    symlinkSync('../lib/npm-cli.js', path.join(fakeNodeDir, 'bin', 'npm'));
  }

  if (options.withEscapingNodeSymlink) {
    const outsideTarget = path.join(tmpDir, 'outside-node-helper.js');
    writeFileSync(outsideTarget, 'outside\n');
    symlinkSync(outsideTarget, path.join(fakeNodeDir, 'bin', 'npm'));
  }

  if (options.withNodeSymlinkCycle) {
    symlinkSync('../bin', path.join(fakeNodeDir, 'bin', 'cycle'));
  }

  const archive = path.join(tmpDir, 'node-v20.0.0-linux-x64.tar.gz');
  execFileSync(
    'tar',
    ['-czf', archive, '-C', tmpDir, path.basename(fakeNodeDir)],
    {
      env: { ...process.env, LC_ALL: 'C' },
      stdio: 'ignore',
    },
  );
  return archive;
}

function createBadUnixNodeArchive(tmpDir) {
  const fakeRuntimeDir = path.join(tmpDir, 'not-node');
  mkdirSync(fakeRuntimeDir, { recursive: true });
  writeFileSync(path.join(fakeRuntimeDir, 'README.txt'), 'not node\n');

  const archive = path.join(tmpDir, 'bad-runtime.tar.gz');
  execFileSync('tar', ['-czf', archive, '-C', tmpDir, 'not-node'], {
    env: { ...process.env, LC_ALL: 'C' },
    stdio: 'ignore',
  });
  return archive;
}

function createBadWindowsNodeArchive(tmpDir) {
  const fakeRuntimeDir = path.join(tmpDir, 'not-node');
  mkdirSync(fakeRuntimeDir, { recursive: true });
  writeFileSync(path.join(fakeRuntimeDir, 'README.txt'), 'not node\n');

  const archive = path.join(tmpDir, 'bad-runtime.zip');
  createZipForTest(archive, tmpDir, path.basename(fakeRuntimeDir));
  return archive;
}

function createFakeWindowsNodeArchive(tmpDir) {
  const fakeNodeDir = path.join(tmpDir, 'node-v20.0.0-win-x64');
  mkdirSync(fakeNodeDir, { recursive: true });
  writeFileSync(path.join(fakeNodeDir, 'node.exe'), 'fake node.exe\n');

  const archive = path.join(tmpDir, 'node-v20.0.0-win-x64.zip');
  createZipForTest(archive, tmpDir, path.basename(fakeNodeDir));
  return archive;
}

function createFakeWindowsStandaloneArchive(tmpDir) {
  const packageRoot = path.join(tmpDir, 'qwen-code');
  const outDir = path.join(tmpDir, 'out');
  mkdirSync(path.join(packageRoot, 'bin'), { recursive: true });
  mkdirSync(path.join(packageRoot, 'node'), { recursive: true });
  mkdirSync(outDir, { recursive: true });

  writeFileSync(
    path.join(packageRoot, 'bin', 'qwen.cmd'),
    ['@echo off', 'echo 0.0.0-smoke', ''].join('\r\n'),
  );
  writeFileSync(path.join(packageRoot, 'node', 'node.exe'), 'fake node.exe\n');
  writeFileSync(
    path.join(packageRoot, 'manifest.json'),
    JSON.stringify({ name: '@qwen-code/qwen-code' }),
  );

  const archive = path.join(outDir, 'qwen-code-win-x64.zip');
  createZipForTest(archive, tmpDir, path.basename(packageRoot));
  writeChecksumFile(outDir, path.basename(archive));
  return archive;
}

function createZipForTest(archive, cwd, entry) {
  if (process.platform === 'win32') {
    execFileSync(
      'powershell',
      [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        'Compress-Archive -LiteralPath $env:QWEN_TEST_ZIP_ENTRY -DestinationPath $env:QWEN_TEST_ZIP_ARCHIVE -Force',
      ],
      {
        env: {
          ...process.env,
          QWEN_TEST_ZIP_ENTRY: path.join(cwd, entry),
          QWEN_TEST_ZIP_ARCHIVE: archive,
        },
        stdio: 'ignore',
      },
    );
    return;
  }

  execFileSync('zip', ['-qr', archive, entry], {
    cwd,
    stdio: 'ignore',
  });
}

function extractZipForTest(archive, destination) {
  if (process.platform === 'win32') {
    execFileSync(
      'powershell',
      [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        'Expand-Archive -LiteralPath $env:QWEN_TEST_ZIP_ARCHIVE -DestinationPath $env:QWEN_TEST_ZIP_DESTINATION -Force',
      ],
      {
        env: {
          ...process.env,
          QWEN_TEST_ZIP_ARCHIVE: archive,
          QWEN_TEST_ZIP_DESTINATION: destination,
        },
        stdio: 'ignore',
      },
    );
    return;
  }

  execFileSync('unzip', ['-q', archive, '-d', destination], {
    stdio: 'ignore',
  });
}

function packageFakeStandalone(tmpDir, nodeArchiveOptions = {}) {
  const outDir = path.join(tmpDir, 'out');
  mkdirSync(outDir, { recursive: true });
  execFileSync(
    'node',
    [
      'scripts/create-standalone-package.js',
      '--target',
      'linux-x64',
      '--node-archive',
      createFakeNodeArchive(tmpDir, nodeArchiveOptions),
      '--out-dir',
      outDir,
      '--version',
      '0.0.0-smoke',
    ],
    { stdio: 'pipe' },
  );
  return path.join(outDir, 'qwen-code-linux-x64.tar.gz');
}

function runUnixInstaller(
  archive,
  installRoot,
  home,
  method = 'standalone',
  extraEnv = {},
) {
  mkdirSync(home, { recursive: true });
  try {
    return execFileSync(
      'bash',
      [
        'scripts/installation/install-qwen-with-source.sh',
        '--method',
        method,
        '--archive',
        archive,
        '--source',
        'smoke',
      ],
      {
        env: {
          ...process.env,
          HOME: home,
          QWEN_INSTALL_ROOT: installRoot,
          ...extraEnv,
        },
        stdio: 'pipe',
      },
    );
  } catch (error) {
    const processError = error;
    throw new Error(
      [
        processError.message,
        processError.stdout?.toString() || '',
        processError.stderr?.toString() || '',
      ].join('\n'),
    );
  }
}

function runWindowsInstaller(
  archive,
  installRoot,
  home,
  method = 'standalone',
  extraEnv = {},
) {
  mkdirSync(home, { recursive: true });
  try {
    return runWindowsCommand(
      [
        `call "${path.resolve('scripts/installation/install-qwen-with-source.bat')}"`,
        '--method',
        method,
        '--archive',
        `"${archive}"`,
        '--source',
        'smoke',
      ].join(' '),
      {
        USERPROFILE: home,
        QWEN_INSTALL_ROOT: installRoot,
        ...extraEnv,
      },
    );
  } catch (error) {
    const processError = error;
    throw new Error(
      [
        processError.message,
        processError.stdout?.toString() || '',
        processError.stderr?.toString() || '',
      ].join('\n'),
    );
  }
}

function runWindowsCommand(command, env = {}) {
  return execFileSync(process.env.ComSpec || 'cmd.exe', ['/d', '/c', command], {
    env: {
      ...process.env,
      ...env,
    },
    stdio: 'pipe',
    // cmd.exe parses the command string itself; preserve quoted paths.
    windowsVerbatimArguments: true,
  });
}

function createSymlinkStandaloneArchive(tmpDir) {
  const packageRoot = path.join(tmpDir, 'malicious', 'qwen-code');
  mkdirSync(path.join(packageRoot, 'bin'), { recursive: true });
  mkdirSync(path.join(packageRoot, 'node', 'bin'), { recursive: true });
  symlinkSync('/usr/bin/env', path.join(packageRoot, 'bin', 'qwen'));
  writeFileSync(
    path.join(packageRoot, 'node', 'bin', 'node'),
    '#!/usr/bin/env sh\necho 0.0.0-smoke\n',
  );
  chmodSync(path.join(packageRoot, 'node', 'bin', 'node'), 0o755);
  writeFileSync(
    path.join(packageRoot, 'manifest.json'),
    JSON.stringify({ name: '@qwen-code/qwen-code' }),
  );

  const outDir = path.join(tmpDir, 'out');
  mkdirSync(outDir, { recursive: true });
  const archive = path.join(outDir, 'qwen-code-linux-x64.tar.gz');
  execFileSync(
    'tar',
    ['-czf', archive, '-C', path.dirname(packageRoot), 'qwen-code'],
    {
      env: { ...process.env, LC_ALL: 'C' },
      stdio: 'ignore',
    },
  );
  writeChecksumFile(outDir, path.basename(archive));
  return archive;
}

function createTraversalStandaloneArchive(tmpDir) {
  const maliciousRoot = path.join(tmpDir, 'malicious');
  const packageRoot = path.join(maliciousRoot, 'qwen-code');
  mkdirSync(path.join(packageRoot, 'bin'), { recursive: true });
  mkdirSync(path.join(packageRoot, 'node', 'bin'), { recursive: true });
  writeFileSync(
    path.join(packageRoot, 'bin', 'qwen'),
    '#!/usr/bin/env sh\necho 0.0.0-smoke\n',
  );
  chmodSync(path.join(packageRoot, 'bin', 'qwen'), 0o755);
  writeFileSync(
    path.join(packageRoot, 'node', 'bin', 'node'),
    '#!/usr/bin/env sh\necho 0.0.0-smoke\n',
  );
  chmodSync(path.join(packageRoot, 'node', 'bin', 'node'), 0o755);
  writeFileSync(
    path.join(packageRoot, 'manifest.json'),
    JSON.stringify({ name: '@qwen-code/qwen-code' }),
  );
  writeFileSync(path.join(tmpDir, 'qwen-slip'), 'path traversal\n');

  const outDir = path.join(tmpDir, 'out');
  mkdirSync(outDir, { recursive: true });
  const archive = path.join(outDir, 'qwen-code-linux-x64.zip');
  execFileSync('zip', ['-qr', archive, 'qwen-code', '../qwen-slip'], {
    cwd: maliciousRoot,
    stdio: 'ignore',
  });
  writeChecksumFile(outDir, path.basename(archive));
  return archive;
}

function writeChecksumFile(outDir, archiveName) {
  const archive = path.join(outDir, archiveName);
  const hash = crypto
    .createHash('sha256')
    .update(readFileSync(archive))
    .digest('hex');
  writeFileSync(path.join(outDir, 'SHA256SUMS'), `${hash}  ${archiveName}\n`);
}
