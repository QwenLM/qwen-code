/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { writeFileSync, rmSync, readFileSync } from 'node:fs';
import { wasmLoader } from 'esbuild-plugin-wasm';

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

/**
 * Resolve `import X from '*.wasm?binary'` imports to an inline Uint8Array.
 *
 * The `?binary` suffix is a build-time hint: at bundle time (esbuild) the WASM
 * bytes are embedded as base64 and exported as a default Uint8Array, so no
 * external vendor files are needed at runtime.  In source / transpiled mode
 * the dynamic import throws and the caller falls back to reading from
 * node_modules via `require.resolve`.
 */
const wasmBinaryPlugin = {
  name: 'wasm-binary',
  setup(build) {
    build.onResolve({ filter: /\.wasm\?binary$/ }, (args) => {
      const specifier = args.path.replace(/\?binary$/, '');
      const localRequire = createRequire(
        path.resolve(args.resolveDir || __dirname, '_dummy_.js'),
      );
      return {
        path: localRequire.resolve(specifier),
        namespace: 'wasm-binary',
      };
    });
    build.onLoad({ filter: /.*/, namespace: 'wasm-binary' }, (args) => {
      const contents = readFileSync(args.path);
      return { contents, loader: 'binary' };
    });
  },
};

const external = [
  '@lydell/node-pty',
  'node-pty',
  '@lydell/node-pty-darwin-arm64',
  '@lydell/node-pty-darwin-x64',
  '@lydell/node-pty-linux-x64',
  '@lydell/node-pty-win32-arm64',
  '@lydell/node-pty-win32-x64',
  '@teddyzhu/clipboard',
  '@teddyzhu/clipboard-darwin-arm64',
  '@teddyzhu/clipboard-darwin-x64',
  '@teddyzhu/clipboard-linux-x64-gnu',
  '@teddyzhu/clipboard-linux-arm64-gnu',
  '@teddyzhu/clipboard-win32-x64-msvc',
  '@teddyzhu/clipboard-win32-arm64-msvc',
];

// Name of the directory under `dist/` that esbuild emits shared chunks into.
// MUST stay in sync with `BUNDLE_CHUNK_DIR` in
// `packages/core/src/utils/bundlePaths.ts`, whose `resolveBundleDir` helper
// strips this exact segment when modules look up sibling assets at runtime.
// Renaming here without renaming there silently breaks bundled-binary lookup
// in skill-manager / ripgrepUtils / i18n / extensions/new.
const BUNDLE_CHUNK_DIR = 'chunks';

esbuild
  .build({
    entryPoints: { cli: 'packages/cli/index.ts' },
    bundle: true,
    outdir: 'dist',
    entryNames: '[name]',
    chunkNames: `${BUNDLE_CHUNK_DIR}/[name]-[hash]`,
    splitting: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    external,
    packages: 'bundle',
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
      '@qwen-code/web-templates': path.resolve(
        __dirname,
        'packages/web-templates/src/index.ts',
      ),
      // Resolve to userland punycode instead of deprecated node:punycode built-in
      punycode: require.resolve('punycode/'),
    },
    define: {
      'process.env.CLI_VERSION': JSON.stringify(pkg.version),
      // Make global available for compatibility
      global: 'globalThis',
      // Redirect free __dirname/__filename references to the shim so that
      // vendored libraries that emit their own `var __dirname` locals don't
      // collide with our injected bindings when code-splitting is enabled.
      //
      // CONTRIBUTOR WARNING: this rewrite applies to *all* source files, so
      // any bare `__dirname` / `__filename` in our own code resolves to the
      // shim chunk's on-disk location (i.e. `dist/chunks/`), NOT the source
      // file's own directory. To get a per-file path, declare a local shadow
      // at the top of the module:
      //
      //   import { fileURLToPath } from 'node:url';
      //   const __filename = fileURLToPath(import.meta.url);
      //   const __dirname  = path.dirname(__filename);
      //
      // esbuild leaves the local binding alone (it's a declared identifier,
      // not a free reference). For sibling-asset lookups in modules that may
      // be hoisted into a shared chunk, prefer
      // `resolveBundleDir(import.meta.url)` from
      // `packages/core/src/utils/bundlePaths.ts` — it both produces a
      // per-file path and strips the chunk segment when the module ends up
      // under `dist/chunks/`.
      __dirname: '__qwen_dirname',
      __filename: '__qwen_filename',
    },
    loader: { '.node': 'file' },
    plugins: [wasmBinaryPlugin, wasmLoader({ mode: 'embedded' })],
    metafile: true,
    write: true,
    keepNames: true,
  })
  .then(({ metafile }) => {
    if (process.env.DEV === 'true') {
      writeFileSync('./dist/esbuild.json', JSON.stringify(metafile, null, 2));
    }
  })
  .catch((error) => {
    console.error('esbuild build failed:', error);
    process.exitCode = 1;
  });
