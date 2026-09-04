/**
 * Build script for @qwen-code/stats.
 * Compiles the React client bundle and copies the HTML template.
 */

import { cpSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = import.meta.dir;
const DIST_CLIENT = join(ROOT, 'dist', 'client');

// Ensure output directory
mkdirSync(DIST_CLIENT, { recursive: true });

// Bundle the React client
const result = await Bun.build({
  entrypoints: [join(ROOT, 'src', 'client', 'index.tsx')],
  outdir: DIST_CLIENT,
  minify: true,
  target: 'browser',
  naming: {
    entry: '[name].js',
  },
});

if (!result.success) {
  console.error('Build failed:');
  for (const log of result.logs) {
    console.error(log);
  }
  process.exit(1);
}

// Copy HTML template
cpSync(join(ROOT, 'src', 'client', 'index.html'), join(DIST_CLIENT, 'index.html'));

console.log(`Built ${result.outputs.length} file(s) to dist/client/`);
