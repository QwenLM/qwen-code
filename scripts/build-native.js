/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Native Binary Build Script
 * Builds Qwen Code as standalone executables for all platforms.
 */

/* global Bun */

import { resolve } from 'path';
import { readFileSync } from 'fs';

const __dirname = resolve(import.meta.url.replace('file://', ''), '..');
const pkg = JSON.parse(
  readFileSync(resolve(__dirname, 'package.json'), 'utf-8'),
);

const PLATFORMS = [
  'bun-linux-x64',
  'bun-linux-arm64',
  'bun-darwin-x64',
  'bun-darwin-arm64',
  'bun-windows-x64',
];

const FEATURES = {
  CORE: true,
  SKILLS: true,
  MCP: true,
  FAST_MODE: true,
  VOICE_MODE: process.env.ENABLE_VOICE === 'true',
  TEAMMEM: process.env.ENABLE_TEAMMEM === 'true',
};

// Generate define object
const define = {};
for (const [key, value] of Object.entries(FEATURES)) {
  define[`process.env.FEATURE_${key}`] = JSON.stringify(value);
}

async function buildNative() {
  console.log('Building native binaries...');
  console.log(`Version: ${pkg.version}`);

  // Check if Bun is available
  if (typeof Bun === 'undefined') {
    console.error('Error: This script must be run with Bun runtime');
    console.error('Run with: bun run scripts/build-native.js');
    process.exit(1);
  }

  // Clean dist/native
  console.log('Cleaning dist/native...');
  try {
    await Bun.$`rm -rf dist/native`.quiet();
  } catch {
    // Ignore if directory doesn't exist
  }
  await Bun.$`mkdir -p dist/native`.quiet();

  // Build for each platform
  for (const platform of PLATFORMS) {
    console.log(`Building for ${platform}...`);

    try {
      const result = await Bun.build({
        entrypoints: ['packages/cli/index.ts'],
        outdir: 'dist/native',
        target: platform,
        compile: true,
        bytecode: true,
        minify: { whitespace: true, syntax: true },
        define: {
          ...define,
          'process.env.CLI_VERSION': JSON.stringify(pkg.version),
          'process.env.BUILD_TARGET': '"native"',
          global: 'globalThis',
        },
        external: [
          '@lydell/node-pty',
          '@lydell/node-pty-*',
          '@teddyzhu/clipboard',
          '@teddyzhu/clipboard-*',
        ],
        sourcemap: 'external',
      });

      if (result.success) {
        console.log(`  ✓ ${platform} built successfully`);
        for (const output of result.outputs) {
          console.log(`    - ${output.path}`);
        }
      } else {
        console.error(`  ✗ ${platform} build failed:`);
        for (const error of result.logs) {
          console.error(`    ${error}`);
        }
      }
    } catch (error) {
      console.error(`  ✗ ${platform} build error:`, error.message);
    }
  }

  console.log('\nNative binaries build complete!');
  console.log('Binaries available in: dist/native/');
}

// Run build
buildNative().catch((error) => {
  console.error('Build failed:', error);
  process.exit(1);
});
