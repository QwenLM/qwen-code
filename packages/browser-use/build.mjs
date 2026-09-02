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

rmSync(dist, { recursive: true, force: true });

await build({
  absWorkingDir: root,
  entryPoints: {
    index: 'src/index.mjs',
    'browser-broker': 'src/browser-broker.ts',
    'native-host': 'src/native-host.ts',
  },
  outdir: dist,
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  banner: {
    js: "import { createRequire as __qwenCreateRequire } from 'node:module'; import { fileURLToPath as __qwenFileURLToPath } from 'node:url'; import { dirname as __qwenDirname } from 'node:path'; const require = __qwenCreateRequire(import.meta.url); const __filename = __qwenFileURLToPath(import.meta.url); const __dirname = __qwenDirname(__filename);",
  },
  packages: 'bundle',
  loader: { '.wasm': 'binary' },
});

for (const executable of [
  path.join(dist, 'browser-broker.js'),
  path.join(dist, 'native-host.js'),
]) {
  chmodSync(executable, 0o755);
}
