/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { writeFileSync, rmSync } from 'node:fs';

let esbuild;
try {
  esbuild = (await import('esbuild')).default;
} catch (_error) {
  console.warn('esbuild not available, skipping bundle step');
  process.exit(0);
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);
const pkg = require(path.resolve(__dirname, 'package.json'));

// Clean dist directory (cross-platform)
rmSync(path.resolve(__dirname, 'dist'), { recursive: true, force: true });

const external = [
  '@lydell/node-pty',
  'node-pty',
  '@lydell/node-pty-darwin-arm64',
  '@lydell/node-pty-darwin-x64',
  '@lydell/node-pty-linux-x64',
  '@lydell/node-pty-win32-arm64',
  '@lydell/node-pty-win32-x64',
];

// Native C++ addons and WASM-loading packages that cannot be bundled.
// These use `bindings` or filesystem APIs at runtime to locate binary files
// (.node / .wasm), which breaks when inlined by esbuild because the runtime
// path resolution starts from the wrong directory.
const nativeExternals = [
  'better-sqlite3',
  'zvec',
  'web-tree-sitter',
  'tree-sitter-javascript',
  'tree-sitter-typescript',
  'tree-sitter-python',
  'tree-sitter-java',
  'tree-sitter-go',
  'tree-sitter-rust',
  'tree-sitter-ruby',
  'tree-sitter-cpp',
  'tree-sitter-c',
  'tree-sitter-c-sharp',
  'tree-sitter-php',
  'bindings',
];

// Shared build options
const sharedOptions = {
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  external,
  packages: 'bundle',
  loader: { '.node': 'file' },
  keepNames: true,
  define: {
    // Make global available for compatibility
    global: 'globalThis',
  },
};

// Build both the main CLI bundle and the indexWorker bundle in parallel.
// The indexWorker must be a separate file because it runs in a Worker thread
// (new Worker(path)) and cannot be inlined into the main bundle.
Promise.all([
  // 1. Main CLI bundle
  // Native externals are needed here too because the main thread creates
  // MetadataStore instances (better-sqlite3) to check index status before
  // deciding whether to spawn the worker.
  esbuild.build({
    ...sharedOptions,
    external: [...external, ...nativeExternals],
    entryPoints: ['packages/cli/index.ts'],
    outfile: 'dist/cli.js',
    inject: [path.resolve(__dirname, 'scripts/esbuild-shims.js')],
    banner: {
      js: `// Force strict mode and setup for ESM
"use strict";`,
    },
    alias: {
      'is-in-ci': path.resolve(
        __dirname,
        'packages/cli/src/patches/is-in-ci.ts',
      ),
    },
    define: {
      ...sharedOptions.define,
      'process.env.CLI_VERSION': JSON.stringify(pkg.version),
    },
    metafile: true,
    write: true,
  }),

  // 2. Index Worker bundle — separate entry point for Worker thread.
  // Native addons (better-sqlite3, zvec) and WASM loaders (web-tree-sitter)
  // must be external so they resolve from node_modules at runtime.
  esbuild.build({
    ...sharedOptions,
    external: [...external, ...nativeExternals],
    entryPoints: ['packages/core/src/indexing/worker/indexWorker.ts'],
    outfile: 'dist/worker/indexWorker.js',
    inject: [path.resolve(__dirname, 'scripts/esbuild-shims.js')],
    banner: {
      js: `// Index Worker — runs in a Worker thread
"use strict";`,
    },
    metafile: true,
    write: true,
  }),
])
  .then(([cliResult]) => {
    if (process.env.DEV === 'true') {
      writeFileSync(
        './dist/esbuild.json',
        JSON.stringify(cliResult.metafile, null, 2),
      );
    }
  })
  .catch((error) => {
    console.error('esbuild build failed:', error);
    process.exitCode = 1;
  });
