#!/usr/bin/env node

/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Get the package root directory
const packageRoot = path.join(__dirname, '..');
const vendorDir = path.join(packageRoot, 'vendor', 'ripgrep');

/**
 * Remove quarantine attribute and set executable permissions on macOS/Linux
 */
function setupRipgrepBinaries() {
  if (!fs.existsSync(vendorDir)) {
    console.log('Vendor directory not found, skipping ripgrep setup');
    return;
  }

  const platform = process.platform;
  const arch = process.arch;

  // Determine the binary directory based on platform and architecture
  let binaryDir;
  if (platform === 'darwin' || platform === 'linux') {
    const archStr = arch === 'x64' || arch === 'arm64' ? arch : null;
    if (archStr) {
      binaryDir = path.join(vendorDir, `${archStr}-${platform}`);
    }
  } else if (platform === 'win32') {
    // Windows doesn't need these fixes
    return;
  }

  if (!binaryDir || !fs.existsSync(binaryDir)) {
    console.log(
      `Binary directory not found for ${platform}-${arch}, skipping ripgrep setup`,
    );
    return;
  }

  const rgBinary = path.join(binaryDir, 'rg');

  if (!fs.existsSync(rgBinary)) {
    console.log(`Ripgrep binary not found at ${rgBinary}`);
    return;
  }

  try {
    // Set executable permissions
    fs.chmodSync(rgBinary, 0o755);
    console.log(`✓ Set executable permissions on ${rgBinary}`);

    // On macOS, remove quarantine attribute
    if (platform === 'darwin') {
      try {
        execSync(`xattr -d com.apple.quarantine "${rgBinary}"`, {
          stdio: 'pipe',
        });
        console.log(`✓ Removed quarantine attribute from ${rgBinary}`);
      } catch (error) {
        // Quarantine attribute might not exist, which is fine
        if (error.message && !error.message.includes('No such xattr')) {
          console.warn(
            `Warning: Could not remove quarantine attribute: ${error.message}`,
          );
        }
      }
    }
  } catch (error) {
    console.error(`Error setting up ripgrep binary: ${error.message}`);
  }
}

setupRipgrepBinaries();
