import { cpSync, existsSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build as esbuild } from 'esbuild';
import { build as viteBuild } from 'vite';

const appDir = dirname(dirname(fileURLToPath(import.meta.url)));
const distDir = join(appDir, 'dist');
rmSync(distDir, { recursive: true, force: true });
mkdirSync(distDir, { recursive: true });

const nodeIncludeCandidates = [
  process.env['NODE_INCLUDE_DIR'],
  join(dirname(dirname(realpathSync(process.execPath))), 'include', 'node'),
  '/opt/homebrew/include/node',
  '/usr/local/include/node',
].filter(Boolean);
const nodeInclude = nodeIncludeCandidates.find((candidate) =>
  existsSync(join(candidate, 'node_api.h')),
);
if (process.platform !== 'darwin' || !nodeInclude) {
  throw new Error(
    'Building Qwen Live Host Appshot requires macOS Node headers.',
  );
}
const nativeDirectory = join(distDir, 'native');
mkdirSync(nativeDirectory, { recursive: true });
const clang = execFileSync('/usr/bin/xcrun', ['--find', 'clang++'], {
  encoding: 'utf8',
}).trim();
const macosSdk = execFileSync('/usr/bin/xcrun', ['--show-sdk-path'], {
  encoding: 'utf8',
}).trim();
execFileSync(
  clang,
  [
    '-std=c++20',
    '-fobjc-arc',
    '-fblocks',
    '-bundle',
    '-undefined',
    'dynamic_lookup',
    '-mmacosx-version-min=12.0',
    '-isysroot',
    macosSdk,
    '-arch',
    'arm64',
    '-arch',
    'x86_64',
    '-I',
    nodeInclude,
    join(appDir, 'src', 'native', 'appshot.mm'),
    '-framework',
    'AppKit',
    '-framework',
    'ApplicationServices',
    '-framework',
    'ImageIO',
    '-framework',
    'ScreenCaptureKit',
    '-o',
    join(nativeDirectory, 'qwen-live-appshot.node'),
  ],
  { stdio: 'inherit' },
);

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
