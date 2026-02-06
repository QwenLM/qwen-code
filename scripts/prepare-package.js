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
import { execSync } from 'node:child_process';
import { copyRecursiveSync } from './copy_bundle_assets.js';

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
  copyRecursiveSync(extensionExamplesDir, extensionExamplesDestDir);
  console.log('Copied extension examples folder');
} else {
  console.warn(
    `Warning: extension examples folder not found at ${extensionExamplesDir}`,
  );
}

// Copy insight templates directory
console.log('Copying insight templates...');
const insightTemplatesDir = path.join(
  rootDir,
  'packages',
  'cli',
  'src',
  'services',
  'insight',
  'templates',
);
const destTemplatesDir = path.join(distDir, 'templates');

if (fs.existsSync(insightTemplatesDir)) {
  copyRecursiveSync(insightTemplatesDir, destTemplatesDir);
  console.log('Copied insight templates to dist/');
} else {
  console.warn(
    `Warning: Insight templates directory not found at ${insightTemplatesDir}`,
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
    rootPackageJson.description || 'Qwen Code - AI-powered coding assistant',
  repository: rootPackageJson.repository,
  type: 'module',
  main: 'cli.js',
  bin: {
    qwen: 'cli.js',
  },
  files: [
    'cli.js',
    'vendor',
    '*.sb',
    'README.md',
    'LICENSE',
    'locales',
    'templates',
  ],
  config: rootPackageJson.config,
  dependencies: {},
  optionalDependencies: {
    '@lydell/node-pty': '1.1.0',
    '@lydell/node-pty-darwin-arm64': '1.1.0',
    '@lydell/node-pty-darwin-x64': '1.1.0',
    '@lydell/node-pty-linux-x64': '1.1.0',
    '@lydell/node-pty-win32-arm64': '1.1.0',
    '@lydell/node-pty-win32-x64': '1.1.0',
  },
  engines: rootPackageJson.engines,
};

fs.writeFileSync(
  path.join(distDir, 'package.json'),
  JSON.stringify(distPackageJson, null, 2) + '\n',
);

console.log('\n✅ Package prepared for publishing at dist/');
console.log('\nPackage structure:');
execSync('ls -lh dist/', { stdio: 'inherit', cwd: rootDir });
