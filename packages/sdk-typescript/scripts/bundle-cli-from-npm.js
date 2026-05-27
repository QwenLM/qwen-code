#!/usr/bin/env node

/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Bundles/copies the Qwen Code CLI from npm package into the SDK package dist/
 * so consumers don't need a separate CLI install.
 *
 * This script reads the CLI package path from CLI_PACKAGE_PATH environment variable
 * and copies the necessary files into the SDK dist/cli/ directory.
 */

import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const sdkRoot = join(__dirname, '..');

function main() {
  // Get CLI package path from environment variable
  const cliPackagePath = process.env.CLI_PACKAGE_PATH;
  if (!cliPackagePath) {
    throw new Error(
      '[sdk bundle] CLI_PACKAGE_PATH environment variable is required. ' +
        'Please set it to the path where the CLI npm package was extracted.',
    );
  }

  const cliDistDir = cliPackagePath;
  const sdkCliDistDir = join(sdkRoot, 'dist', 'cli');

  // Verify CLI package exists
  if (!existsSync(cliDistDir)) {
    throw new Error(
      `[sdk bundle] CLI package not found at: ${cliDistDir}. ` +
        `Make sure the CLI package was downloaded and extracted correctly.`,
    );
  }

  // Verify SDK dist exists
  if (!existsSync(join(sdkRoot, 'dist'))) {
    throw new Error(
      '[sdk bundle] SDK dist/ not found. Run `npm run build` in packages/sdk-typescript first.',
    );
  }

  // Clean and create SDK CLI directory
  rmSync(sdkCliDistDir, { recursive: true, force: true });
  mkdirSync(sdkCliDistDir, { recursive: true });

  console.log('[sdk bundle] Copying CLI from npm package...');
  console.log(`[sdk bundle] Source: ${cliDistDir} (package root)`);
  console.log(`[sdk bundle] Destination: ${sdkCliDistDir}`);

  // Copy main CLI file
  const cliJsSource = join(cliDistDir, 'cli.js');
  if (!existsSync(cliJsSource)) {
    throw new Error(
      `[sdk bundle] cli.js not found in CLI package at: ${cliJsSource}`,
    );
  }
  cpSync(cliJsSource, join(sdkCliDistDir, 'cli.js'));
  console.log('[sdk bundle] ✓ cli.js copied');

  // Copy vendor directory if exists
  const vendorSource = join(cliDistDir, 'vendor');
  if (existsSync(vendorSource)) {
    cpSync(vendorSource, join(sdkCliDistDir, 'vendor'), { recursive: true });
    console.log('[sdk bundle] ✓ vendor/ copied');
  }

  // Copy locales directory if exists
  const localesSource = join(cliDistDir, 'locales');
  if (existsSync(localesSource)) {
    cpSync(localesSource, join(sdkCliDistDir, 'locales'), { recursive: true });
    console.log('[sdk bundle] ✓ locales/ copied');
  }

  console.log('[sdk bundle] CLI bundled successfully from npm package');
}

main();
