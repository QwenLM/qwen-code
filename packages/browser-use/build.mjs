/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const root = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(root, 'dist');

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
  packages: 'bundle',
  external: ['playwright-core', 'playwright-core/*'],
});

// esbuild only proves the bundle parses; a load-time failure (a duplicate
// top-level binding, an unresolved external) would otherwise surface first in
// the Node kernel that imports the published artifact.
await import(pathToFileURL(path.join(dist, 'index.js')).href);
