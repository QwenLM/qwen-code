/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { execSync } from 'node:child_process';
import { rmSync, mkdirSync, existsSync, cpSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = join(__dirname, '..');

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
  target: 'node18',
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
  target: 'node18',
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

console.log('Bundling CLI into SDK package...');
const repoRoot = join(rootDir, '..', '..');
const rootDistDir = join(repoRoot, 'dist');

if (!existsSync(rootDistDir) || !existsSync(join(rootDistDir, 'cli.js'))) {
  console.log('Building CLI bundle...');
  try {
    execSync('npm run bundle', { stdio: 'inherit', cwd: repoRoot });
  } catch (error) {
    console.error('Failed to build CLI bundle:', error.message);
    throw error;
  }
}

const cliDistDir = join(rootDir, 'dist', 'cli');
mkdirSync(cliDistDir, { recursive: true });

console.log('Copying CLI bundle...');
cpSync(join(rootDistDir, 'cli.js'), join(cliDistDir, 'cli.js'));

const vendorSource = join(rootDistDir, 'vendor');
if (existsSync(vendorSource)) {
  cpSync(vendorSource, join(cliDistDir, 'vendor'), { recursive: true });
}

const localesSource = join(rootDistDir, 'locales');
if (existsSync(localesSource)) {
  cpSync(localesSource, join(cliDistDir, 'locales'), { recursive: true });
}

console.log('CLI bundle copied successfully to SDK package');
