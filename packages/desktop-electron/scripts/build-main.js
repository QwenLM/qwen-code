#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const packageDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const repoRoot = path.resolve(packageDir, '../..');
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

await build({
  entryPoints: [path.join(packageDir, 'src/renderer/pet.ts')],
  outfile: path.join(outDir, 'renderer/pet.js'),
  bundle: true,
  platform: 'browser',
  format: 'esm',
  target: 'chrome120',
  sourcemap: false,
});

fs.copyFileSync(
  path.join(packageDir, 'src/renderer/pet.html'),
  path.join(outDir, 'renderer/pet.html'),
);
fs.copyFileSync(
  path.join(packageDir, 'src/renderer/pet.css'),
  path.join(outDir, 'renderer/pet.css'),
);
fs.copyFileSync(
  path.join(
    repoRoot,
    'packages/desktop/apps/electron/src/renderer/assets/pets/qwen-spritesheet.webp',
  ),
  path.join(outDir, 'renderer/qwen-spritesheet.webp'),
);

console.log('Built Electron main, preload, and pet renderer.');
