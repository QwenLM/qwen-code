/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import esbuild from 'esbuild';
import { cpSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * @type {import('esbuild').Plugin}
 */
const esbuildProblemMatcherPlugin = {
  name: 'esbuild-problem-matcher',

  setup(build) {
    const isWatchMode = build.initialOptions.watch;
    build.onStart(() => {
      if (isWatchMode) {
        console.log('[watch] build started');
      }
    });
    build.onEnd((result) => {
      result.errors.forEach(({ text, location }) => {
        console.error(`✘ [ERROR] ${text}`);
        if (location) {
          console.error(
            `    ${location.file}:${location.line}:${location.column}:`,
          );
        }
      });
      if (isWatchMode) {
        console.log('[watch] build finished');
      }
    });
  },
};

/** Copy the static renderer assets (index.html, styles.css) into dist/renderer. */
const copyRendererAssetsPlugin = {
  name: 'copy-renderer-assets',
  setup(build) {
    build.onEnd((result) => {
      if (result.errors.length > 0) return;
      mkdirSync(resolve(__dirname, 'dist/renderer'), { recursive: true });
      for (const file of ['index.html', 'styles.css']) {
        cpSync(
          resolve(__dirname, 'src/renderer', file),
          resolve(__dirname, 'dist/renderer', file),
        );
      }
    });
  },
};

const nodeBuildOptions = {
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  minify: production,
  sourcemap: !production,
  sourcesContent: false,
  external: ['electron'],
  logLevel: 'silent',
  // Source is ESM and uses `import.meta.url`, but these bundles are emitted as
  // CJS and run under Electron/Node (CJS). esbuild's CJS shim leaves
  // `import.meta.url` undefined, which crashes `fileURLToPath` at load. Rebind
  // it to a real file URL derived from the native CJS `__filename`.
  define: { 'import.meta.url': 'importMetaUrl' },
  banner: {
    js: "const importMetaUrl = require('url').pathToFileURL(__filename).href;",
  },
};

async function main() {
  const mainCtx = await esbuild.context({
    ...nodeBuildOptions,
    entryPoints: ['src/main/main.ts'],
    outfile: 'dist/main/main.cjs',
    plugins: [esbuildProblemMatcherPlugin],
  });

  const preloadCtx = await esbuild.context({
    ...nodeBuildOptions,
    entryPoints: ['src/preload/preload.ts'],
    outfile: 'dist/preload/preload.cjs',
    plugins: [esbuildProblemMatcherPlugin],
  });

  const rendererCtx = await esbuild.context({
    entryPoints: ['src/renderer/renderer.ts'],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'es2022',
    minify: production,
    sourcemap: !production,
    sourcesContent: false,
    outfile: 'dist/renderer/renderer.js',
    logLevel: 'silent',
    plugins: [copyRendererAssetsPlugin, esbuildProblemMatcherPlugin],
  });

  if (watch) {
    await Promise.all([
      mainCtx.watch(),
      preloadCtx.watch(),
      rendererCtx.watch(),
    ]);
  } else {
    await Promise.all([
      mainCtx.rebuild(),
      preloadCtx.rebuild(),
      rendererCtx.rebuild(),
    ]);
    await Promise.all([
      mainCtx.dispose(),
      preloadCtx.dispose(),
      rendererCtx.dispose(),
    ]);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
