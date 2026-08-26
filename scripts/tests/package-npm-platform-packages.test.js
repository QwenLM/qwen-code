/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'package-npm-platform-packages.js',
);

const PLATFORM_ARCHIVES = [
  'qwen-code-darwin-arm64.tar.gz',
  'qwen-code-darwin-x64.tar.gz',
  'qwen-code-linux-arm64.tar.gz',
  'qwen-code-linux-x64.tar.gz',
  'qwen-code-win-x64.zip',
];

// Mirrors the standalone payload layout create-standalone-package.js stamps,
// including the standalone fingerprints the repackager must strip.
function createStandaloneFixture(standaloneDir, archiveName) {
  const isWindows = archiveName.endsWith('.zip');
  const root = path.join(standaloneDir, '.fixture', 'qwen-code');
  rmSync(path.dirname(root), { recursive: true, force: true });
  mkdirSync(path.join(root, 'lib'), { recursive: true });
  mkdirSync(path.join(root, 'bin'), { recursive: true });
  mkdirSync(path.join(root, 'node', 'bin'), { recursive: true });
  mkdirSync(path.join(root, 'bun', 'bin'), { recursive: true });
  writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({ name: '@qwen-code/qwen-code', files: ['lib'] }),
  );
  writeFileSync(
    path.join(root, 'manifest.json'),
    JSON.stringify({ name: '@qwen-code/qwen-code', target: 'fixture' }),
  );
  writeFileSync(path.join(root, 'lib', 'cli-entry.js'), '// cli\n');
  writeFileSync(
    path.join(root, 'bin', isWindows ? 'qwen.cmd' : 'qwen'),
    '#!/bin/sh\n',
  );
  writeFileSync(
    path.join(root, 'node', isWindows ? 'node.exe' : path.join('bin', 'node')),
    '// node mirror\n',
  );
  writeFileSync(
    path.join(root, 'bun', isWindows ? 'bun.exe' : path.join('bin', 'bun')),
    '// bun\n',
  );

  const archivePath = path.join(standaloneDir, archiveName);
  if (isWindows) {
    execFileSync('zip', ['-qr', archivePath, 'qwen-code'], {
      cwd: path.dirname(root),
    });
  } else {
    execFileSync('tar', ['-czf', archivePath, 'qwen-code'], {
      cwd: path.dirname(root),
    });
  }
}

describe('scripts/package-npm-platform-packages.js', () => {
  let workDir;
  let standaloneDir;
  let outDir;

  beforeEach(() => {
    workDir = mkdtempSync(path.join(tmpdir(), 'npm-platform-test-'));
    standaloneDir = path.join(workDir, 'standalone');
    outDir = path.join(workDir, 'out');
    mkdirSync(standaloneDir, { recursive: true });
    for (const archiveName of PLATFORM_ARCHIVES) {
      createStandaloneFixture(standaloneDir, archiveName);
    }
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  const runScript = (extraArgs = []) =>
    execFileSync(
      process.execPath,
      [
        SCRIPT_PATH,
        '--version',
        '9.9.9',
        '--standalone-dir',
        standaloneDir,
        '--out-dir',
        outDir,
        ...extraArgs,
      ],
      { encoding: 'utf8' },
    );

  it('packages every release target and emits the optionalDependencies map', () => {
    runScript();

    const optionalDependencies = JSON.parse(
      readFileSync(path.join(outDir, 'optional-dependencies.json'), 'utf8'),
    );
    expect(optionalDependencies).toEqual({
      '@qwen-code/qwen-code-darwin-arm64': '9.9.9',
      '@qwen-code/qwen-code-darwin-x64': '9.9.9',
      '@qwen-code/qwen-code-linux-arm64': '9.9.9',
      '@qwen-code/qwen-code-linux-x64': '9.9.9',
      '@qwen-code/qwen-code-win-x64': '9.9.9',
    });

    for (const name of Object.keys(optionalDependencies)) {
      const packageDir = path.join(outDir, name.replace('@qwen-code/', ''));
      const manifest = JSON.parse(
        readFileSync(path.join(packageDir, 'package.json'), 'utf8'),
      );
      expect(manifest.name).toBe(name);
      expect(manifest.version).toBe('9.9.9');
      expect(manifest.os).toHaveLength(1);
      expect(manifest.cpu).toHaveLength(1);
      expect(existsSync(path.join(packageDir, 'lib', 'cli-entry.js'))).toBe(
        true,
      );
    }
  });

  it('strips every standalone fingerprint isStandaloneInstallDir probes', () => {
    runScript();

    for (const shortName of [
      'qwen-code-darwin-arm64',
      'qwen-code-darwin-x64',
      'qwen-code-linux-arm64',
      'qwen-code-linux-x64',
      'qwen-code-win-x64',
    ]) {
      const packageDir = path.join(outDir, shortName);
      expect(existsSync(path.join(packageDir, 'manifest.json'))).toBe(false);
      expect(existsSync(path.join(packageDir, 'bin'))).toBe(false);
      // The node/ compat mirror is standalone-installer-only dead weight — on
      // win-x64 a byte-for-byte second copy of the Bun executable.
      expect(existsSync(path.join(packageDir, 'node'))).toBe(false);
    }
  });

  it('accepts the sibling scripts --key=value syntax', () => {
    execFileSync(
      process.execPath,
      [
        SCRIPT_PATH,
        `--version=9.9.9`,
        `--standalone-dir=${standaloneDir}`,
        `--out-dir=${outDir}`,
      ],
      { encoding: 'utf8' },
    );
    expect(existsSync(path.join(outDir, 'optional-dependencies.json'))).toBe(
      true,
    );
  });

  it('refuses to run without --version', () => {
    expect(() =>
      execFileSync(
        process.execPath,
        [SCRIPT_PATH, '--standalone-dir', standaloneDir, '--out-dir', outDir],
        { encoding: 'utf8', stdio: 'pipe' },
      ),
    ).toThrowError(/--version is required/);
  });
});
