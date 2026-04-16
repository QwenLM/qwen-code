/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Prepares packages/cli/ for npm publishing in bundle mode.
 *
 * After `npm run bundle` produces the esbuild output in root dist/,
 * this script replaces packages/cli/dist/ with the bundled artifacts
 * and rewrites packages/cli/package.json to have zero dependencies —
 * matching how upstream @qwen-code/qwen-code is published.
 *
 * This allows the AoneCI npm-publisher to publish the bundled version
 * of @alife/dataworks-qwen-code instead of the tsc output with broken
 * file: workspace references.
 *
 * Usage:
 *   npm run build          # tsc build (required for bundle to resolve imports)
 *   npm run bundle         # esbuild → dist/cli.js + copy_bundle_assets
 *   node scripts/prepare-cli-for-publish.js   # this script
 *   # npm-publisher then publishes packages/cli/ as bundled package
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const bundleDistDir = path.join(rootDir, 'dist');
const cliDir = path.join(rootDir, 'packages', 'cli');
const cliDistDir = path.join(cliDir, 'dist');

// ---------------------------------------------------------------------------
// Verify prerequisites
// ---------------------------------------------------------------------------

const cliBundlePath = path.join(bundleDistDir, 'cli.js');
if (!fs.existsSync(cliBundlePath)) {
  console.error(
    'Error: dist/cli.js not found. Run "npm run bundle" before this script.',
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 1. Replace packages/cli/dist/ with bundle output
// ---------------------------------------------------------------------------

console.log('Replacing packages/cli/dist/ with bundled output...');

if (fs.existsSync(cliDistDir)) {
  fs.rmSync(cliDistDir, { recursive: true, force: true });
}
fs.mkdirSync(cliDistDir, { recursive: true });

// Copy cli.js (the single esbuild bundle)
fs.copyFileSync(cliBundlePath, path.join(cliDistDir, 'cli.js'));
console.log('  Copied cli.js');

// Copy directories: vendor, bundled, locales, examples
const assetDirs = ['vendor', 'bundled', 'locales', 'examples'];
for (const dir of assetDirs) {
  const src = path.join(bundleDistDir, dir);
  if (fs.existsSync(src)) {
    copyRecursiveSync(src, path.join(cliDistDir, dir));
    console.log(`  Copied ${dir}/`);
  }
}

// Copy *.sb sandbox profiles
const distEntries = fs.readdirSync(bundleDistDir);
for (const entry of distEntries) {
  if (entry.endsWith('.sb')) {
    fs.copyFileSync(
      path.join(bundleDistDir, entry),
      path.join(cliDistDir, entry),
    );
    console.log(`  Copied ${entry}`);
  }
}

// ---------------------------------------------------------------------------
// 2. Rewrite packages/cli/package.json for zero-deps bundle publish
// ---------------------------------------------------------------------------

console.log('Rewriting packages/cli/package.json for bundle publish...');

const cliPkgPath = path.join(cliDir, 'package.json');
const cliPkg = JSON.parse(fs.readFileSync(cliPkgPath, 'utf-8'));

const publishPkg = {
  name: cliPkg.name,
  version: cliPkg.version,
  description: cliPkg.description || 'Qwen Code - AI-powered coding assistant',
  repository: cliPkg.repository,
  type: 'module',
  main: 'dist/cli.js',
  bin: {
    qwen: 'dist/cli.js',
  },
  files: [
    'dist/cli.js',
    'dist/vendor',
    'dist/*.sb',
    'dist/locales',
    'dist/bundled',
    'dist/examples',
    'README.md',
    'LICENSE',
  ],
  config: cliPkg.config,
  dependencies: {},
  optionalDependencies: {
    '@lydell/node-pty': '1.2.0-beta.10',
    '@lydell/node-pty-darwin-arm64': '1.2.0-beta.10',
    '@lydell/node-pty-darwin-x64': '1.2.0-beta.10',
    '@lydell/node-pty-linux-x64': '1.2.0-beta.10',
    '@lydell/node-pty-win32-arm64': '1.2.0-beta.10',
    '@lydell/node-pty-win32-x64': '1.2.0-beta.10',
    '@teddyzhu/clipboard': '0.0.5',
    '@teddyzhu/clipboard-darwin-arm64': '0.0.5',
    '@teddyzhu/clipboard-darwin-x64': '0.0.5',
    '@teddyzhu/clipboard-linux-x64-gnu': '0.0.5',
    '@teddyzhu/clipboard-linux-arm64-gnu': '0.0.5',
    '@teddyzhu/clipboard-win32-x64-msvc': '0.0.5',
    '@teddyzhu/clipboard-win32-arm64-msvc': '0.0.5',
  },
  publishConfig: cliPkg.publishConfig,
  engines: cliPkg.engines,
};

fs.writeFileSync(cliPkgPath, JSON.stringify(publishPkg, null, 2) + '\n');
console.log('  Wrote zero-deps package.json');

// ---------------------------------------------------------------------------
// Done
// ---------------------------------------------------------------------------

console.log('\n✅ packages/cli/ is ready for bundle publish');
console.log(`   name:    ${publishPkg.name}`);
console.log(`   version: ${publishPkg.version}`);
console.log(`   main:    ${publishPkg.main}`);
console.log(`   deps:    0 (bundled)`);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function copyRecursiveSync(src, dest) {
  if (!fs.existsSync(src)) return;
  const stats = fs.statSync(src);
  if (stats.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src)) {
      if (entry === '.DS_Store') continue;
      copyRecursiveSync(path.join(src, entry), path.join(dest, entry));
    }
  } else {
    fs.copyFileSync(src, dest);
    if (stats.mode & 0o111) {
      fs.chmodSync(dest, stats.mode);
    }
  }
}
