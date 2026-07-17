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

const entryPoints = [resolveEntry('src/background/service-worker')];

async function build() {
  const ctx = await esbuild.context({
    entryPoints,
    bundle: true,
    platform: 'browser',
    format: 'iife',
    target: ['chrome115'],
    minify: isProduction,
    sourcemap: !isProduction,
    metafile: !isWatch,
    outdir: path.join(projectRoot, outDir),
    outbase: path.join(projectRoot, 'src'),
    logLevel: 'info',
  });

  if (isWatch) {
    console.log('Watching background/content scripts...');
    await ctx.watch();
  } else {
    const result = await ctx.rebuild();
    if (result.metafile) {
      const metafilePath = path.join(projectRoot, 'dist/esbuild.json');
      fs.mkdirSync(path.dirname(metafilePath), { recursive: true });
      fs.writeFileSync(metafilePath, JSON.stringify(result.metafile, null, 2));
    }
    await ctx.dispose();
    console.log('Background/content build complete!');
  }
}

build().catch((err) => {
  console.error(err);
  process.exit(1);
});
