/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { scanZipArtifact } from '../../packages/chrome-extension/scripts/artifact-scan.js';
import { toChromeManifestVersion } from '../../packages/chrome-extension/scripts/manifest-version.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '../..');

const zipAvailable = () =>
  spawnSync('zip', ['--version'], { stdio: 'ignore' }).status === 0;

describe('chrome extension package scripts', () => {
  it('keeps the build script portable for Windows npm lifecycle runs', () => {
    const packageJson = JSON.parse(
      readFileSync(
        path.join(root, 'packages/chrome-extension/package.json'),
        'utf8',
      ),
    );

    expect(packageJson.scripts.build).not.toMatch(
      /(?:^|\s&&\s)[A-Za-z_][A-Za-z0-9_]*=/,
    );
    expect(packageJson.scripts.package).toContain('package-extension.js');
    expect(packageJson.scripts.package).not.toContain('zip -r');

    const workflow = readFileSync(
      path.join(root, '.github/workflows/ci.yml'),
      'utf8',
    );
    expect(workflow).toContain('npm -w packages/chrome-extension run package');
  });

  it.skipIf(!zipAvailable())(
    'rejects forbidden dependency signatures inside the packaged archive',
    async () => {
      const tempDir = await mkdtemp(path.join(os.tmpdir(), 'qwen-ext-scan-'));
      const source = path.join(tempDir, 'extension');
      const archive = path.join(tempDir, 'extension.zip');
      try {
        mkdirSync(source);
        writeFileSync(
          path.join(source, 'index.js'),
          "require('node_modules/chrome-devtools-mcp/index.js');",
        );
        execFileSync('zip', [archive, 'index.js'], {
          cwd: source,
          stdio: 'ignore',
        });
        await expect(scanZipArtifact(archive)).resolves.toEqual([
          {
            file: `${archive}:index.js`,
            signature: 'node_modules/chrome-devtools-mcp',
          },
        ]);
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    },
  );

  it('keeps the pinned official id aligned with the manifest key', () => {
    const manifest = JSON.parse(
      readFileSync(
        path.join(root, 'packages/chrome-extension/public/manifest.json'),
        'utf8',
      ),
    );
    const hex = createHash('sha256')
      .update(Buffer.from(manifest.key, 'base64'))
      .digest('hex')
      .slice(0, 32);
    const extensionId = [...hex]
      .map((digit) => String.fromCharCode(97 + Number.parseInt(digit, 16)))
      .join('');

    const daemonSource = readFileSync(
      path.join(root, 'packages/cli/src/serve/run-qwen-serve.ts'),
      'utf8',
    );
    const sidePanelSource = readFileSync(
      path.join(root, 'packages/chrome-extension/public/sidepanel.js'),
      'utf8',
    );
    expect(daemonSource).toContain(`chrome-extension://${extensionId}`);
    expect(sidePanelSource).toContain(`'${extensionId}'`);
  });

  it('writes the package version into the built manifest', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'qwen-ext-build-'));
    try {
      execFileSync(
        process.execPath,
        [
          path.join(
            root,
            'packages/chrome-extension/scripts/sync-extension.js',
          ),
          `--target=${tempDir}`,
        ],
        { stdio: 'ignore' },
      );
      const manifest = JSON.parse(
        readFileSync(path.join(tempDir, 'manifest.json'), 'utf8'),
      );
      const packageJson = JSON.parse(
        readFileSync(
          path.join(root, 'packages/chrome-extension/package.json'),
          'utf8',
        ),
      );
      expect(manifest.version).toBe(
        toChromeManifestVersion(packageJson.version),
      );
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }, 30_000);
});
