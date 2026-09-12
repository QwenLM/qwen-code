/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { chmodSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(root, 'dist');
const nodeBanner =
  "import { createRequire as __qwenCreateRequire } from 'node:module'; import { fileURLToPath as __qwenFileURLToPath } from 'node:url'; import { dirname as __qwenDirname } from 'node:path'; const require = __qwenCreateRequire(import.meta.url); const __filename = __qwenFileURLToPath(import.meta.url); const __dirname = __qwenDirname(__filename);";

rmSync(dist, { recursive: true, force: true });

await build({
  absWorkingDir: root,
  entryPoints: {
    index: 'src/index.ts',
  },
  outdir: dist,
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  banner: {
    js: `${nodeBanner} const process = require('node:process');`,
  },
  packages: 'bundle',
  external: ['playwright-core', 'playwright-core/*'],
  loader: { '.wasm': 'binary' },
});

await build({
  absWorkingDir: root,
  entryPoints: {
    'native-host': 'src/bridge/native-host/index.ts',
    'scripts/native-host-setup': 'scripts/native-host-setup.ts',
    'scripts/managed-chrome': 'scripts/managed-chrome.ts',
    'scripts/managed-chrome-preflight': 'scripts/managed-chrome-preflight.ts',
    'scripts/smoke-qwen-saucedemo': 'scripts/smoke-qwen-saucedemo.ts',
  },
  outdir: dist,
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  banner: {
    js: nodeBanner,
  },
  packages: 'bundle',
  external: ['playwright-core', 'playwright-core/*'],
  loader: { '.wasm': 'binary' },
});

for (const executable of [
  path.join(dist, 'native-host.js'),
  path.join(dist, 'scripts/native-host-setup.js'),
]) {
  chmodSync(executable, 0o755);
}
