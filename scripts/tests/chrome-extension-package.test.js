/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { scanZip } from '../../packages/chrome-extension/scripts/artifact-scan.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '../..');

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
    expect(packageJson.devDependencies.archiver).toBeDefined();

    const packageScript = readFileSync(
      path.join(root, 'packages/chrome-extension/scripts/package-extension.js'),
      'utf8',
    );
    expect(packageScript).toContain("archiver('zip'");
    expect(packageScript).not.toContain("execFile('zip'");

    const rootPackageJson = JSON.parse(
      readFileSync(path.join(root, 'package.json'), 'utf8'),
    );
    expect(rootPackageJson.scripts['test:release']).toContain(
      'npm -w packages/chrome-extension run package',
    );
  });

  it('rejects forbidden stale entries in the final extension archive', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'qwen-ext-scan-'));
    const archive = path.join(tempDir, 'extension.zip');
    try {
      writeFileSync(
        archive,
        'central-directory: node_modules/chrome-devtools-mcp/index.js',
      );
      await expect(scanZip(archive)).resolves.toEqual([
        `${archive}: chrome-devtools-mcp`,
      ]);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

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
});
