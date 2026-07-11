/**
 * @file esbuild configuration for the background service worker
 * Transpiles the TS/JS entry point into MV3-ready JS while keeping file layout.
 */

/* global process, console */

import * as esbuild from 'esbuild';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

const isWatch = process.argv.includes('--watch');
const isProduction = process.argv.includes('--production');
const outDir = process.env.EXTENSION_OUT_DIR || 'dist/extension';

// Resolve an entry point, preferring .ts when present (fallback to .js)
function resolveEntry(relativePathWithoutExt) {
  const tsPath = path.join(projectRoot, `${relativePathWithoutExt}.ts`);
  if (fs.existsSync(tsPath)) {
    return tsPath;
  }
  return path.join(projectRoot, `${relativePathWithoutExt}.js`);
}

const builds = [
  {
    entryPoints: [resolveEntry('src/background/service-worker')],
  },
  {
    entryPoints: [resolveEntry('src/sidepanel/capability-status')],
    globalName: 'QwenCapabilityStatus',
  },
];

async function build() {
  const contexts = await Promise.all(
    builds.map((buildOptions) =>
      esbuild.context({
        ...buildOptions,
        bundle: true,
        platform: 'browser',
        format: 'iife',
        target: ['chrome115'],
        minify: isProduction,
        sourcemap: !isProduction,
        outdir: path.join(projectRoot, outDir),
        outbase: path.join(projectRoot, 'src'),
        logLevel: 'info',
      }),
    ),
  );

  if (isWatch) {
    console.log('Watching background/content scripts...');
    await Promise.all(contexts.map((ctx) => ctx.watch()));
  } else {
    await Promise.all(contexts.map((ctx) => ctx.rebuild()));
    await Promise.all(contexts.map((ctx) => ctx.dispose()));
    console.log('Background/content build complete!');
  }
}

build().catch((err) => {
  console.error(err);
  process.exit(1);
});
