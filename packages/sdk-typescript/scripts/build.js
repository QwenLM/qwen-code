/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { execSync } from 'node:child_process';
import {
  rmSync,
  mkdirSync,
  existsSync,
  cpSync,
  readFileSync,
  statSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = join(__dirname, '..');
// Budget includes the DaemonTransport interface + DaemonTransportClosedError +
// RestSseTransport (default transport, constructed by DaemonClient).
// Bumped from 116KB to 118KB for the transport abstraction layer (~1.5KB).
// Bumped from 118KB to 119KB for the mid-turn drain surface (enqueue methods +
// `mid_turn_message_injected` event type/guard/registration, ~150 bytes).
// Bumped from 119KB to 122KB for the workspace extension management surface
// (install/update/enable/disable/uninstall/refresh/check update endpoints).
// Bumped from 122KB to 124KB for daemon fork-session APIs/events.
const MAX_DAEMON_BROWSER_BUNDLE_BYTES = 124 * 1024;

rmSync(join(rootDir, 'dist'), { recursive: true, force: true });
mkdirSync(join(rootDir, 'dist'), { recursive: true });

execSync('tsc --project tsconfig.build.json', {
  stdio: 'inherit',
  cwd: rootDir,
});

try {
  execSync(
    'npx dts-bundle-generator --project tsconfig.build.json -o dist/index.d.ts src/index.ts',
    {
      stdio: 'inherit',
      cwd: rootDir,
    },
  );

  const dirsToRemove = ['mcp', 'query', 'transport', 'types', 'utils'];
  for (const dir of dirsToRemove) {
    const dirPath = join(rootDir, 'dist', dir);
    if (existsSync(dirPath)) {
      rmSync(dirPath, { recursive: true, force: true });
    }
  }
} catch (error) {
  console.warn(
    'Could not bundle type definitions, keeping separate .d.ts files',
    error.message,
  );
}

await esbuild.build({
  entryPoints: [join(rootDir, 'src', 'index.ts')],
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  outfile: join(rootDir, 'dist', 'index.mjs'),
  external: ['@modelcontextprotocol/sdk'],
  sourcemap: false,
  minify: true,
  minifyWhitespace: true,
  minifyIdentifiers: true,
  minifySyntax: true,
  legalComments: 'none',
  keepNames: false,
  treeShaking: true,
});

await esbuild.build({
  entryPoints: [join(rootDir, 'src', 'index.ts')],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node22',
  outfile: join(rootDir, 'dist', 'index.cjs'),
  external: ['@modelcontextprotocol/sdk'],
  sourcemap: false,
  minify: true,
  minifyWhitespace: true,
  minifyIdentifiers: true,
  minifySyntax: true,
  legalComments: 'none',
  keepNames: false,
  treeShaking: true,
});

await esbuild.build({
  entryPoints: [join(rootDir, 'src', 'daemon', 'index.ts')],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  outfile: join(rootDir, 'dist', 'daemon', 'index.js'),
  sourcemap: false,
  minify: true,
  minifyWhitespace: true,
  minifyIdentifiers: true,
  minifySyntax: true,
  legalComments: 'none',
  keepNames: false,
  treeShaking: true,
});

assertBrowserSafeBundle(join(rootDir, 'dist', 'daemon', 'index.js'));

await esbuild.build({
  entryPoints: [join(rootDir, 'src', 'daemon', 'index.ts')],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node22',
  outfile: join(rootDir, 'dist', 'daemon', 'index.cjs'),
  sourcemap: false,
  minify: true,
  minifyWhitespace: true,
  minifyIdentifiers: true,
  minifySyntax: true,
  legalComments: 'none',
  keepNames: false,
  treeShaking: true,
});

// Build serve-bridge CLI bin entry
await esbuild.build({
  entryPoints: [join(rootDir, 'src', 'daemon-mcp', 'serve-bridge', 'bin.ts')],
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  outfile: join(rootDir, 'dist', 'daemon-mcp', 'serve-bridge', 'bin.js'),
  external: ['@modelcontextprotocol/sdk'],
  sourcemap: false,
  banner: { js: '#!/usr/bin/env node' },
});

// Copy LICENSE from root directory to dist
const licenseSource = join(rootDir, '..', '..', 'LICENSE');
const licenseTarget = join(rootDir, 'dist', 'LICENSE');
if (existsSync(licenseSource)) {
  try {
    cpSync(licenseSource, licenseTarget);
  } catch (error) {
    console.warn('Could not copy LICENSE:', error.message);
  }
}

function assertBrowserSafeBundle(filePath) {
  const size = statSync(filePath).size;
  if (size > MAX_DAEMON_BROWSER_BUNDLE_BYTES) {
    throw new Error(
      `Browser daemon SDK bundle is ${size} bytes; expected <= ${MAX_DAEMON_BROWSER_BUNDLE_BYTES}`,
    );
  }

  const contents = readFileSync(filePath, 'utf8');
  if (contents.includes('node:')) {
    throw new Error('Browser daemon SDK bundle contains Node-only token node:');
  }
  const forbiddenBuiltins = [
    'assert',
    'buffer',
    'child_process',
    'cluster',
    'crypto',
    'fs',
    'http',
    'https',
    'module',
    'net',
    'os',
    'path',
    'perf_hooks',
    'process',
    'readline',
    'stream',
    'tls',
    'tty',
    'url',
    'util',
    'worker_threads',
    'zlib',
  ];
  const requirePattern = new RegExp(
    `require\\((["'])(${forbiddenBuiltins.join('|')})(?:/[^"']*)?\\1\\)`,
  );
  const found = contents.match(requirePattern);
  if (found) {
    throw new Error(
      `Browser daemon SDK bundle contains Node-only token ${found[0]}`,
    );
  }
}
