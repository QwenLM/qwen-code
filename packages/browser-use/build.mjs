/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { chmodSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const root = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(root, 'dist');
const nodeBanner =
  "import { createRequire as __qwenCreateRequire } from 'node:module'; import { fileURLToPath as __qwenFileURLToPath } from 'node:url'; import { dirname as __qwenDirname } from 'node:path'; const require = __qwenCreateRequire(import.meta.url); const __filename = __qwenFileURLToPath(import.meta.url); const __dirname = __qwenDirname(__filename);";
// The bundled skill imports dist/index.js (staged as runtime/index.js) from
// inside the node_repl kernel: packages/node-repl/src/runtime/module-loader.mjs
// compiles absolute-path imports as vm.SourceTextModule in the kernel's
// untrusted vm context, which is built from Object.create(null), never defines
// a `process` global, and denies the `node:process` import specifier. The SDK
// reads process.env/process.platform, so bind `process` through createRequire,
// the one route the kernel leaves open. The load check at the bottom of this
// file runs in Node's main realm, where `process` is always a global, so it
// cannot detect this binding going missing; src/skill-runtime-kernel.test.ts
// runs the skill's first cell through the real kernel for that.
const kernelBanner =
  "import { createRequire as __qwenCreateRequire } from 'node:module'; const process = __qwenCreateRequire(import.meta.url)('node:process');";

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
    js: kernelBanner,
  },
  packages: 'bundle',
  external: ['playwright-core', 'playwright-core/*'],
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

// esbuild only proves the bundle parses; a load-time failure (a duplicate
// top-level binding, an unresolved external) would otherwise surface first in
// the Node kernel that imports the published artifact.
await import(pathToFileURL(path.join(dist, 'index.js')).href);
