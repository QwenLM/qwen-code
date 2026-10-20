/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { Buffer } from 'node:buffer';
import { readFile, writeFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
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
const browser = {
  bundle: true,
  platform: 'browser',
  target: 'es2022',
  format: 'iife',
  minify: true,
  legalComments: 'inline',
  write: false,
};
const worker = await build({
  ...browser,
  entryPoints: ['src/app/worker.ts'],
});
const workerGzip = gzipSync(worker.outputFiles[0].contents).toString('base64');
const app = await build({
  ...browser,
  entryPoints: ['src/app/main.ts'],
  outfile: 'dist/app.js',
  define: {
    __WORKER_GZIP_BASE64__: JSON.stringify(workerGzip),
    'process.env.NODE_ENV': '"production"',
  },
});
const script = app.outputFiles.find((file) => file.path.endsWith('.js')).text;
const style = app.outputFiles.find((file) => file.path.endsWith('.css')).text;
const html = (await readFile('src/app/index.html', 'utf8'))
  .replace('<!-- APP_STYLE -->', () => `<style>${style}</style>`)
  .replace(
    '<!-- APP_SCRIPT -->',
    () => `<script>${script.replace(/<\/script/gi, '<\\/script')}</script>`,
  );
if (Buffer.byteLength(html, 'utf8') > 1024 * 1024) {
  throw new Error('Generated UI bootstrap exceeds the host 1 MiB limit.');
}
await writeFile('dist/app.html', html);
