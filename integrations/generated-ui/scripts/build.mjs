/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { Buffer } from 'node:buffer';
import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  writeFile,
} from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { build } from 'esbuild';

const server = await build({
  entryPoints: ['src/main.ts', 'src/bundled-main.ts'],
  outdir: 'dist',
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  metafile: true,
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
  metafile: true,
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
await mkdir('dist/skills/generated-ui', { recursive: true });
await copyFile(
  'skills/generated-ui/SKILL.md',
  'dist/skills/generated-ui/SKILL.md',
);

const packages = new Map();
for (const artifact of [server, worker, app]) {
  for (const input of Object.keys(artifact.metafile.inputs)) {
    if (!input.replaceAll('\\', '/').includes('node_modules/')) continue;
    let directory = dirname(resolve(input));
    while (directory !== dirname(directory)) {
      let manifest;
      try {
        manifest = JSON.parse(
          await readFile(join(directory, 'package.json'), 'utf8'),
        );
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      if (manifest?.name) {
        packages.set(directory, manifest);
        break;
      }
      directory = dirname(directory);
    }
  }
}
const notices = [];
for (const [directory, manifest] of [...packages].sort(([, a], [, b]) =>
  `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`),
)) {
  const licenses = (await readdir(directory, { withFileTypes: true }))
    .filter(
      (entry) =>
        entry.isFile() &&
        /^(licen[cs]e|copying|notice)([.-].*)?$/i.test(entry.name),
    )
    .map((entry) => entry.name)
    .sort();
  if (licenses.length === 0) {
    throw new Error(`Bundled dependency has no license file: ${manifest.name}`);
  }
  notices.push(
    `${manifest.name}@${manifest.version}\nLicense: ${manifest.license ?? 'See below'}\n` +
      (
        await Promise.all(
          licenses.map(
            async (file) =>
              `${file}\n${await readFile(join(directory, file), 'utf8')}`,
          ),
        )
      ).join('\n'),
  );
}
await writeFile('dist/THIRD_PARTY_NOTICES.txt', notices.join('\n\n---\n\n'));
