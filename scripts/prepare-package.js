/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Prepares the bundled CLI package for npm publishing
 * This script adds publishing metadata (package.json, README, LICENSE) to dist/
 * All runtime assets (cli.js, vendor/, *.sb) are already in dist/ from the bundle step
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

const distDir = path.join(rootDir, 'dist');
const cliBundlePath = path.join(distDir, 'cli.js');
const vendorDir = path.join(distDir, 'vendor');

// Verify dist directory and bundle exist
if (!fs.existsSync(distDir)) {
  console.error('Error: dist/ directory not found');
  console.error('Please run "npm run bundle" first');
  process.exit(1);
}

if (!fs.existsSync(cliBundlePath)) {
  console.error(`Error: Bundle not found at ${cliBundlePath}`);
  console.error('Please run "npm run bundle" first');
  process.exit(1);
}

if (!fs.existsSync(vendorDir)) {
  console.error(`Error: Vendor directory not found at ${vendorDir}`);
  console.error('Please run "npm run bundle" first');
  process.exit(1);
}

const bundledDocsDir = path.join(distDir, 'bundled', 'qc-helper', 'docs');
if (!fs.existsSync(bundledDocsDir)) {
  console.error(`Error: Bundled docs not found at ${bundledDocsDir}`);
  console.error('Please run "npm run bundle" first');
  process.exit(1);
}

// Copy README and LICENSE
console.log('Copying documentation files...');
const filesToCopy = ['README.md', 'LICENSE'];
for (const file of filesToCopy) {
  const sourcePath = path.join(rootDir, file);
  const destPath = path.join(distDir, file);
  if (fs.existsSync(sourcePath)) {
    fs.copyFileSync(sourcePath, destPath);
    console.log(`Copied ${file}`);
  } else {
    console.warn(`Warning: ${file} not found at ${sourcePath}`);
  }
}

// Copy locales folder
console.log('Copying locales folder...');
const localesSourceDir = path.join(
  rootDir,
  'packages',
  'cli',
  'src',
  'i18n',
  'locales',
);
const localesDestDir = path.join(distDir, 'locales');

if (fs.existsSync(localesSourceDir)) {
  // Recursive copy function
  function copyRecursiveSync(src, dest) {
    const stats = fs.statSync(src);
    if (stats.isDirectory()) {
      if (!fs.existsSync(dest)) {
        fs.mkdirSync(dest, { recursive: true });
      }
      const entries = fs.readdirSync(src);
      for (const entry of entries) {
        const srcPath = path.join(src, entry);
        const destPath = path.join(dest, entry);
        copyRecursiveSync(srcPath, destPath);
      }
    } else {
      fs.copyFileSync(src, dest);
    }
  }

  copyRecursiveSync(localesSourceDir, localesDestDir);
  console.log('Copied locales folder');
} else {
  console.warn(`Warning: locales folder not found at ${localesSourceDir}`);
}

// Copy extensions folder
console.log('Copying extension examples folder...');
const extensionExamplesDir = path.join(
  rootDir,
  'packages',
  'cli',
  'src',
  'commands',
  'extensions',
  'examples',
);
const extensionExamplesDestDir = path.join(distDir, 'examples');

if (fs.existsSync(extensionExamplesDir)) {
  // Recursive copy function
  function copyRecursiveSync(src, dest) {
    const stats = fs.statSync(src);
    if (stats.isDirectory()) {
      if (!fs.existsSync(dest)) {
        fs.mkdirSync(dest, { recursive: true });
      }
      const entries = fs.readdirSync(src);
      for (const entry of entries) {
        const srcPath = path.join(src, entry);
        const destPath = path.join(dest, entry);
        copyRecursiveSync(srcPath, destPath);
      }
    } else {
      fs.copyFileSync(src, dest);
    }
  }

  copyRecursiveSync(extensionExamplesDir, extensionExamplesDestDir);
  console.log('Copied extension examples folder');
} else {
  console.warn(
    `Warning: extension examples folder not found at ${extensionExamplesDir}`,
  );
}

// Copy package.json from root and modify it for publishing
console.log('Creating package.json for distribution...');
const rootPackageJson = JSON.parse(
  fs.readFileSync(path.join(rootDir, 'package.json'), 'utf-8'),
);

// Create a clean package.json for the published package
const distPackageJson = {
  name: rootPackageJson.name,
  version: rootPackageJson.version,
  description:
    rootPackageJson.description || 'proto - AI-powered coding agent',
  repository: rootPackageJson.repository,
  type: 'module',
  main: 'cli.js',
  bin: {
    proto: 'cli.js',
  },
  files: [
    'cli.js',
    'vendor',
    '*.sb',
    'README.md',
    'LICENSE',
    'locales',
    'bundled',
  ],
  config: rootPackageJson.config,
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
    // Sharp — image resize for drag-and-drop (4K screenshot support)
    'sharp': '0.34.5',
    '@img/sharp-darwin-arm64': '0.34.5',
    '@img/sharp-darwin-x64': '0.34.5',
    '@img/sharp-linux-arm64': '0.34.5',
    '@img/sharp-linux-x64': '0.34.5',
    '@img/sharp-linuxmusl-arm64': '0.34.5',
    '@img/sharp-linuxmusl-x64': '0.34.5',
    '@img/sharp-win32-x64': '0.34.5',
    '@img/sharp-win32-arm64': '0.34.5',
    '@img/sharp-libvips-darwin-arm64': '1.2.4',
    '@img/sharp-libvips-darwin-x64': '1.2.4',
    '@img/sharp-libvips-linux-arm64': '1.2.4',
    '@img/sharp-libvips-linux-x64': '1.2.4',
    '@img/sharp-libvips-linuxmusl-arm64': '1.2.4',
    '@img/sharp-libvips-linuxmusl-x64': '1.2.4',
  },
  engines: rootPackageJson.engines,
};

fs.writeFileSync(
  path.join(distDir, 'package.json'),
  JSON.stringify(distPackageJson, null, 2) + '\n',
);

console.log('\n✅ Package prepared for publishing at dist/');
console.log('\nPackage structure:');
// Use Node.js to list directory contents (cross-platform)
const distFiles = fs.readdirSync(distDir);
for (const file of distFiles) {
  const filePath = path.join(distDir, file);
  const stats = fs.statSync(filePath);
  const size = stats.isDirectory() ? '<DIR>' : formatBytes(stats.size);
  console.log(`  ${size.padEnd(12)} ${file}`);
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
