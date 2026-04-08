/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

vi.unmock('fs');
vi.unmock('node:fs');

const {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} = await import('node:fs');

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..', '..');
const scriptSource = join(repoRoot, 'scripts', 'copy-to-package.sh');

const tempDirs = [];

function writeJson(filePath, value) {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function writeFile(filePath, content = '') {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, content);
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

describe('copy-to-package.sh', () => {
  it('copies every non-private package into .package/<package-dir>/ preserving files entries', () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'copy-to-package-'));
    tempDirs.push(tempRoot);

    mkdirSync(join(tempRoot, 'scripts'), { recursive: true });
    writeFileSync(
      join(tempRoot, 'scripts', 'copy-to-package.sh'),
      readFileSync(scriptSource),
    );
    writeJson(join(tempRoot, 'package.json'), {
      workspaces: ['packages/*', 'packages/channels/base'],
    });

    writeJson(join(tempRoot, 'packages', 'cli', 'package.json'), {
      name: '@alife/dataworks-qwen-code',
      version: '1.0.0',
      files: ['dist'],
    });
    writeFile(join(tempRoot, 'packages', 'cli', 'dist', 'index.js'), 'cli');

    writeJson(join(tempRoot, 'packages', 'core', 'package.json'), {
      name: '@alife/dataworks-qwen-code-core',
      version: '1.0.0',
      files: ['dist', 'vendor', 'scripts/postinstall.js'],
    });
    writeFile(join(tempRoot, 'packages', 'core', 'dist', 'index.js'), 'core');
    writeFile(
      join(tempRoot, 'packages', 'core', 'vendor', 'asset.txt'),
      'vendor',
    );
    writeFile(
      join(tempRoot, 'packages', 'core', 'scripts', 'postinstall.js'),
      'postinstall',
    );

    writeJson(join(tempRoot, 'packages', 'channels', 'base', 'package.json'), {
      name: '@alife/dataworks-qwen-code-channel-base',
      version: '1.0.0',
      files: ['dist'],
    });
    writeFile(
      join(tempRoot, 'packages', 'channels', 'base', 'dist', 'index.js'),
      'channel',
    );

    writeJson(join(tempRoot, 'packages', 'test-utils', 'package.json'), {
      name: '@qwen-code/qwen-code-test-utils',
      version: '1.0.0',
      private: true,
      files: ['dist'],
    });
    writeFile(
      join(tempRoot, 'packages', 'test-utils', 'dist', 'index.js'),
      'private',
    );

    writeJson(
      join(
        tempRoot,
        'packages',
        'cli',
        'src',
        'commands',
        'extensions',
        'examples',
        'mcp-server',
        'package.json',
      ),
      {
        name: 'mcp-server-example',
        version: '1.0.0',
        files: ['dist'],
      },
    );

    execFileSync('bash', [join(tempRoot, 'scripts', 'copy-to-package.sh')], {
      cwd: tempRoot,
      stdio: 'pipe',
    });

    expect(
      existsSync(join(tempRoot, '.package', 'cli', 'dist', 'index.js')),
    ).toBe(true);
    expect(existsSync(join(tempRoot, '.package', 'cli', 'package.json'))).toBe(
      true,
    );
    expect(
      existsSync(join(tempRoot, '.package', 'core', 'dist', 'index.js')),
    ).toBe(true);
    expect(
      existsSync(join(tempRoot, '.package', 'core', 'vendor', 'asset.txt')),
    ).toBe(true);
    expect(
      existsSync(
        join(tempRoot, '.package', 'core', 'scripts', 'postinstall.js'),
      ),
    ).toBe(true);
    expect(
      existsSync(
        join(tempRoot, '.package', 'channel-base', 'dist', 'index.js'),
      ),
    ).toBe(true);
    expect(existsSync(join(tempRoot, '.package', 'package.json'))).toBe(false);
    expect(existsSync(join(tempRoot, '.package', 'dist'))).toBe(false);
    expect(existsSync(join(tempRoot, '.package', 'test-utils'))).toBe(false);
    expect(
      existsSync(
        join(
          tempRoot,
          '.package',
          'cli',
          'src',
          'commands',
          'extensions',
          'examples',
          'mcp-server',
        ),
      ),
    ).toBe(false);
  });

  it('uses Beijing time for the daily release timestamp', () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'copy-to-package-'));
    tempDirs.push(tempRoot);

    mkdirSync(join(tempRoot, 'scripts'), { recursive: true });
    writeFileSync(
      join(tempRoot, 'scripts', 'copy-to-package.sh'),
      readFileSync(scriptSource),
    );

    const mockBinDir = join(tempRoot, 'mock-bin');
    mkdirSync(mockBinDir, { recursive: true });

    writeFile(
      join(mockBinDir, 'date'),
      `#!/usr/bin/env bash
if [ "$1" = "-u" ]; then
  echo "202501011600"
elif [ "$TZ" = "Asia/Shanghai" ]; then
  echo "202501020000"
else
  echo "202501011600"
fi
`,
    );
    chmodSync(join(mockBinDir, 'date'), 0o755);

    writeFile(
      join(mockBinDir, 'node'),
      `#!/usr/bin/env bash
exec "${process.execPath}" "$@"
`,
    );
    chmodSync(join(mockBinDir, 'node'), 0o755);

    writeJson(join(tempRoot, 'package.json'), {
      workspaces: ['packages/*'],
    });

    writeJson(join(tempRoot, 'packages', 'cli', 'package.json'), {
      name: '@alife/dataworks-qwen-code',
      version: '1.0.0',
      files: ['dist'],
    });
    writeFile(join(tempRoot, 'packages', 'cli', 'dist', 'index.js'), 'cli');

    execFileSync('bash', [join(tempRoot, 'scripts', 'copy-to-package.sh')], {
      cwd: tempRoot,
      stdio: 'pipe',
      env: {
        ...process.env,
        PATH: `${mockBinDir}:${process.env.PATH}`,
      },
    });

    const copiedPackageJson = JSON.parse(
      readFileSync(join(tempRoot, '.package', 'cli', 'package.json'), 'utf8'),
    );

    expect(copiedPackageJson.version).toBe('1.0.0-beta.202501020000');
  });
});
