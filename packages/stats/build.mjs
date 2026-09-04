/**
 * Build script for @qwen-code/stats.
 * Compiles the React client bundle and copies the HTML template.
 */

import { cpSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST_CLIENT = join(__dirname, 'dist', 'client');

// Ensure output directory
mkdirSync(DIST_CLIENT, { recursive: true });

// Bundle the React client
try {
  const result = await build({
    entryPoints: [join(__dirname, 'src', 'client', 'index.tsx')],
    outdir: DIST_CLIENT,
    minify: true,
    platform: 'browser',
    format: 'esm',
    jsx: 'automatic',
    loader: { '.css': 'css' },
    entryNames: '[name]',
    bundle: true,
  });

  if (result.errors.length > 0) {
    console.error('Build failed:');
    for (const err of result.errors) {
      console.error(err);
    }
    process.exit(1);
  }

  // Copy HTML template
  cpSync(join(__dirname, 'src', 'client', 'index.html'), join(DIST_CLIENT, 'index.html'));

  console.log(`Built ${result.outputFiles?.length ?? 0} file(s) to dist/client/`);
} catch (err) {
  console.error('Build failed:', err);
  process.exit(1);
}
