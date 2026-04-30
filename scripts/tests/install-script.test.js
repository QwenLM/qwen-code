/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';

const {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} = await vi.importActual('node:fs');
const { execFileSync } = await vi.importActual('node:child_process');
const { tmpdir } = await vi.importActual('node:os');
const path = await vi.importActual('node:path');
const readScript = (path) => readFileSync(path, 'utf8');

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
    expect(script).toContain(
      'SHA256SUMS not found; cannot verify remote archive',
    );
    expect(script).toContain('qwen-code-${target}');
    expect(script).toContain('METHOD="${METHOD:-detect}"');
    expect(script).toContain('Falling back to npm installation');
    expect(script).toContain('standalone_status=$?');
    expect(script).toContain('[[ "${standalone_status}" -eq 2 ]]');
    expect(script).not.toContain('ln -sf "${INSTALL_LIB_DIR}/bin/qwen"');
    expect(script).toContain('exec "${INSTALL_LIB_DIR}/bin/qwen"');
    expect(script).toContain('qwen-code/node/bin/node');
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
    expect(script).toContain(
      'SHA256SUMS not found; cannot verify remote archive',
    );
    expect(script).toContain('qwen-code-win-x64.zip');
    expect(script).toContain('Expand-Archive');
    expect(script).toContain('Falling back to npm installation');
    expect(script).toContain('set "STANDALONE_STATUS=!ERRORLEVEL!"');
    expect(script).toContain('if !STANDALONE_STATUS! EQU 2');
    expect(script).toContain('qwen-code\\node\\node.exe');
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
