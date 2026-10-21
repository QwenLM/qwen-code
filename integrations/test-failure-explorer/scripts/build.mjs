/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { Buffer } from 'node:buffer';
import { readFile, writeFile } from 'node:fs/promises';
import { build } from 'esbuild';

await build({
  entryPoints: ['src/main.ts'],
  outfile: 'dist/main.js',
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  banner: {
    js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
  },
});
const app = await build({
  entryPoints: ['src/app/main.tsx'],
  outfile: 'dist/app.js',
  bundle: true,
  platform: 'browser',
  target: 'es2022',
  format: 'iife',
  minify: true,
  legalComments: 'inline',
  define: { 'process.env.NODE_ENV': '"production"' },
  write: false,
});
const script = app.outputFiles.find((file) => file.path.endsWith('.js')).text;
const style = app.outputFiles.find((file) => file.path.endsWith('.css')).text;
const html = (await readFile('src/app/index.html', 'utf8'))
  .replace(
    '<!-- APP_STYLE -->',
    () => `<style>${style.replace(/<\/style/gi, '<\\/style')}</style>`,
  )
  .replace(
    '<!-- APP_SCRIPT -->',
    () => `<script>${script.replace(/<\/script/gi, '<\\/script')}</script>`,
  );
if (Buffer.byteLength(html, 'utf8') > 1024 * 1024) {
  throw new Error('MCP App HTML exceeds the host 1 MiB resource limit.');
}
await writeFile('dist/app.html', html);
