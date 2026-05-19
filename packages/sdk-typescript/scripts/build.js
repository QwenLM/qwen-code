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
const MAX_DAEMON_BROWSER_BUNDLE_BYTES = 100 * 1024;

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
  const forbidden = [
    'node:',
    'require("fs")',
    "require('fs')",
    'require("path")',
    "require('path')",
    'require("http")',
    "require('http')",
    'require("https")',
    "require('https')",
  ];
  const found = forbidden.find((token) => contents.includes(token));
  if (found) {
    throw new Error(
      `Browser daemon SDK bundle contains Node-only token ${found}`,
    );
  }
}
