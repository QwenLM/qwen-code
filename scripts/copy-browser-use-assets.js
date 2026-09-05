/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

export function copyBrowserUseAssets(root, skillDir) {
  const browserUseDir = path.join(root, 'packages', 'browser-use');
  const runtimeFiles = [
    'index.js',
    'native-host.js',
    'scripts/native-host-setup.js',
  ];
  for (const file of runtimeFiles) {
    const source = path.join(browserUseDir, 'dist', file);
    if (!fs.existsSync(source)) {
      throw new Error(
        `Browser-use runtime not found: ${source}. ` +
          'Run "npm run build --workspace=@qwen-code/browser-use" first.',
      );
    }
  }

  const manifestPath = path.join(browserUseDir, 'package.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const require = createRequire(manifestPath);
  const playwrightManifestPath = require.resolve(
    'playwright-core/package.json',
  );
  const playwrightManifest = JSON.parse(
    fs.readFileSync(playwrightManifestPath, 'utf8'),
  );
  const pinnedVersion = manifest.dependencies['playwright-core'];
  if (playwrightManifest.version !== pinnedVersion) {
    throw new Error(
      `Browser-use requires playwright-core ${pinnedVersion}, ` +
        `but resolved ${playwrightManifest.version}. Run "npm install" first.`,
    );
  }

  const runtimeDir = path.join(skillDir, 'runtime');
  fs.rmSync(runtimeDir, { recursive: true, force: true });
  for (const file of runtimeFiles) {
    const target = path.join(runtimeDir, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(browserUseDir, 'dist', file), target);
  }
  fs.copyFileSync(
    path.join(browserUseDir, 'NOTICE'),
    path.join(runtimeDir, 'NOTICE'),
  );
  fs.cpSync(
    path.dirname(playwrightManifestPath),
    path.join(runtimeDir, 'node_modules', 'playwright-core'),
    { recursive: true },
  );
}
