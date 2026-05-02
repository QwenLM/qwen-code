/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';

const {
  appendFileSync,
  chmodSync,
  existsSync,
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
const readScript = (path) => readFileSync(path, 'utf8');
const itOnUnix = process.platform === 'win32' ? it.skip : it;

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
    expect(script).toContain('qwen-code-${target}');
    expect(script).toContain('METHOD="${METHOD:-detect}"');
    expect(script).toContain('must start with https://');
    expect(script).toContain('Falling back to npm installation');
    expect(script).toContain('standalone_status=$?');
    expect(script).toContain('[[ "${standalone_status}" -eq 2 ]]');
    expect(script).toContain(
      'Standalone install failed. Retry with --method npm',
    );
    expect(script).not.toContain('ln -sf "${INSTALL_LIB_DIR}/bin/qwen"');
    expect(script).toContain('exec "${INSTALL_LIB_DIR}/bin/qwen"');
    expect(script).toContain('qwen-code/node/bin/node');
    expect(script).toContain('Archive contains symlinks; refusing to install');
    expect(script).toContain('not a Qwen Code standalone install');
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
    expect(script).toContain('qwen-code-win-x64.zip');
    expect(script).toContain('Expand-Archive');
    expect(script).toContain('$env:QWEN_DOWNLOAD_URL');
    expect(script).toContain('$env:QWEN_ARCHIVE_FILE');
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
  });
});

describe('standalone release packaging', () => {
  it('defines a standalone packaging script', () => {
    const packageJson = JSON.parse(readScript('package.json'));

    expect(packageJson.scripts['package:standalone']).toBe(
      'node scripts/create-standalone-package.js',
    );
    expect(existsSync('scripts/create-standalone-package.js')).toBe(true);

    const packageScript = readScript('scripts/create-standalone-package.js');
    expect(packageScript).toContain("'bundled/qc-helper/docs'");
    expect(packageScript).toContain("path.join(packageRoot, 'package.json')");
    expect(packageScript).toContain('validateNodeRuntime');
    expect(packageScript).toContain('refusing to write empty SHA256SUMS');
  });

  it('rejects a runtime archive without a Node executable', () => {
    const createdDist = ensureMinimalDist();
    const tmpDir = mkdtempSync(path.join(tmpdir(), 'qwen-package-test-'));

    try {
      const fakeRuntimeDir = path.join(tmpDir, 'not-node');
      mkdirSync(fakeRuntimeDir, { recursive: true });
      writeFileSync(path.join(fakeRuntimeDir, 'README.txt'), 'not node\n');
      const fakeRuntimeArchive = path.join(tmpDir, 'bad-runtime.tar.gz');
      execFileSync(
        'tar',
        ['-czf', fakeRuntimeArchive, '-C', tmpDir, 'not-node'],
        {
          env: { ...process.env, LC_ALL: 'C' },
          stdio: 'ignore',
        },
      );

      expect(() =>
        execFileSync(
          'node',
          [
            'scripts/create-standalone-package.js',
            '--target',
            'linux-x64',
            '--node-archive',
            fakeRuntimeArchive,
            '--out-dir',
            path.join(tmpDir, 'out'),
            '--version',
            '0.0.0-test',
          ],
          { stdio: 'pipe' },
        ),
      ).toThrow(/Node.js runtime for linux-x64 must contain/);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
      if (createdDist) {
        rmSync('dist', { recursive: true, force: true });
      }
    }
  });

  it('uploads standalone archives during release', () => {
    const workflow = readScript('.github/workflows/release.yml');

    expect(workflow).toContain('set -euo pipefail');
    expect(workflow).toContain('SHASUMS256.txt');
    expect(workflow).toContain('$2 == name');
    expect(workflow).toContain('does not list ${archive_name}');
    expect(workflow).toContain('sha256sum -c -');
    expect(workflow).toContain('Expected 5 standalone checksums');
    expect(workflow).toContain('npm run package:standalone');
    expect(workflow).toContain('dist/standalone/qwen-code-*');
    expect(workflow).toContain('dist/standalone/SHA256SUMS');
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

function createFakeNodeArchive(tmpDir) {
  const fakeNodeDir = path.join(tmpDir, 'node-v20.0.0-linux-x64');
  mkdirSync(path.join(fakeNodeDir, 'bin'), { recursive: true });
  writeFileSync(
    path.join(fakeNodeDir, 'bin', 'node'),
    '#!/usr/bin/env sh\necho 0.0.0-smoke\n',
  );
  chmodSync(path.join(fakeNodeDir, 'bin', 'node'), 0o755);

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

function packageFakeStandalone(tmpDir) {
  const outDir = path.join(tmpDir, 'out');
  mkdirSync(outDir, { recursive: true });
  execFileSync(
    'node',
    [
      'scripts/create-standalone-package.js',
      '--target',
      'linux-x64',
      '--node-archive',
      createFakeNodeArchive(tmpDir),
      '--out-dir',
      outDir,
      '--version',
      '0.0.0-smoke',
    ],
    { stdio: 'pipe' },
  );
  return path.join(outDir, 'qwen-code-linux-x64.tar.gz');
}

function runUnixInstaller(archive, installRoot, home) {
  mkdirSync(home, { recursive: true });
  try {
    return execFileSync(
      'bash',
      [
        'scripts/installation/install-qwen-with-source.sh',
        '--method',
        'standalone',
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

function writeChecksumFile(outDir, archiveName) {
  const archive = path.join(outDir, archiveName);
  const hash = crypto
    .createHash('sha256')
    .update(readFileSync(archive))
    .digest('hex');
  writeFileSync(path.join(outDir, 'SHA256SUMS'), `${hash}  ${archiveName}\n`);
}
