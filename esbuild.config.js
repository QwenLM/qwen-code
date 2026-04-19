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

const commonBundleOptions = {
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  external,
  packages: 'bundle',
  define: {
    'process.env.CLI_VERSION': JSON.stringify(pkg.version),
    // Make global available for compatibility
    global: 'globalThis',
  },
  loader: { '.node': 'file' },
  plugins: [wasmBinaryPlugin, wasmLoader({ mode: 'embedded' })],
  write: true,
  keepNames: true,
};

const mainBuild = esbuild.build({
  ...commonBundleOptions,
  entryPoints: ['packages/cli/index.ts'],
  outfile: 'dist/cli.js',
  inject: [path.resolve(__dirname, 'scripts/esbuild-shims.js')],
  banner: {
    js: `// Force strict mode and setup for ESM
"use strict";`,
  },
  alias: {
    'is-in-ci': path.resolve(__dirname, 'packages/cli/src/patches/is-in-ci.ts'),
    '@qwen-code/web-templates': path.resolve(
      __dirname,
      'packages/web-templates/src/index.ts',
    ),
    // Resolve to userland punycode instead of deprecated node:punycode built-in
    punycode: require.resolve('punycode/'),
  },
  metafile: true,
});

// The file-index worker runs in its own worker_threads process and must exist
// as a standalone file next to dist/cli.js so that `new URL('./fileIndexWorker.js',
// import.meta.url)` resolves at runtime (the main bundle's import.meta.url is
// dist/cli.js). We bundle it self-contained so fzf/fdir get inlined and no
// node_modules resolution is required from the published tarball.
const workerBuild = esbuild.build({
  ...commonBundleOptions,
  entryPoints: ['packages/core/src/utils/filesearch/fileIndexWorker.ts'],
  outfile: 'dist/fileIndexWorker.js',
  // fdir and other transitive CJS deps use require() at runtime, which is
  // not available in ESM output without this shim. Same pattern as the main
  // CLI bundle above.
  inject: [path.resolve(__dirname, 'scripts/esbuild-shims.js')],
  banner: {
    js: `"use strict";`,
  },
});

Promise.all([mainBuild, workerBuild])
  .then(([{ metafile }]) => {
    if (process.env.DEV === 'true') {
      writeFileSync('./dist/esbuild.json', JSON.stringify(metafile, null, 2));
    }
  })
  .catch((error) => {
    console.error('esbuild build failed:', error);
    process.exitCode = 1;
  });
