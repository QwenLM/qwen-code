#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const packageDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const outDir = path.join(packageDir, 'dist');

fs.rmSync(path.join(outDir, 'main'), { recursive: true, force: true });
fs.rmSync(path.join(outDir, 'preload'), { recursive: true, force: true });
fs.rmSync(path.join(outDir, 'renderer'), { recursive: true, force: true });

await build({
  entryPoints: [path.join(packageDir, 'src/main/index.ts')],
  outfile: path.join(outDir, 'main/index.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  external: ['electron'],
  sourcemap: false,
});

await build({
  entryPoints: [path.join(packageDir, 'src/preload/index.ts')],
  outfile: path.join(outDir, 'preload/index.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  external: ['electron'],
  sourcemap: false,
});

console.log('Built Electron main process and preload.');
