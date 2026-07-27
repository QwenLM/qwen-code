import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { build as esbuild } from 'esbuild';
import { build as viteBuild } from 'vite';

const appDir = dirname(dirname(fileURLToPath(import.meta.url)));
const distDir = join(appDir, 'dist');
rmSync(distDir, { recursive: true, force: true });
mkdirSync(distDir, { recursive: true });

const nativeResult = spawnSync(
  process.execPath,
  [join(appDir, 'scripts', 'build-native-helper.mjs')],
  {
    stdio: 'inherit',
  },
);
if (nativeResult.status !== 0) process.exit(nativeResult.status ?? 1);

await esbuild({
  entryPoints: [join(appDir, 'src', 'main', 'index.ts')],
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  outfile: join(distDir, 'main.cjs'),
  external: ['electron'],
  sourcemap: true,
});

await esbuild({
  entryPoints: [join(appDir, 'src', 'preload', 'index.ts')],
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  outfile: join(distDir, 'preload.cjs'),
  external: ['electron'],
  sourcemap: true,
});

await viteBuild({ configFile: join(appDir, 'vite.config.ts') });

const license = join(appDir, '..', '..', 'LICENSE');
cpSync(license, join(distDir, 'LICENSE'));
const iconRoot = join(
  appDir,
  '..',
  'electron',
  'resources',
  'brands',
  'qwen-code',
);
cpSync(join(iconRoot, 'icon.icns'), join(distDir, 'icon.icns'));
cpSync(join(iconRoot, 'icon.png'), join(distDir, 'icon.png'));
