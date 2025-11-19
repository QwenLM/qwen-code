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
 * This script never throws errors to avoid blocking npm workflows.
 */
function setupRipgrepBinaries() {
  try {
    if (!fs.existsSync(vendorDir)) {
      console.log('ℹ Vendor directory not found, skipping ripgrep setup');
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
      console.log('ℹ Windows detected, skipping ripgrep setup');
      return;
    }

    if (!binaryDir || !fs.existsSync(binaryDir)) {
      console.log(
        `ℹ Binary directory not found for ${platform}-${arch}, skipping ripgrep setup`,
      );
      return;
    }

    const rgBinary = path.join(binaryDir, 'rg');

    if (!fs.existsSync(rgBinary)) {
      console.log(`ℹ Ripgrep binary not found at ${rgBinary}, skipping setup`);
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
        } catch {
          // Quarantine attribute might not exist, which is fine
          console.log('ℹ Quarantine attribute not present or already removed');
        }
      }
    } catch (error) {
      console.log(
        `⚠ Could not complete ripgrep setup: ${error.message || 'Unknown error'}`,
      );
      console.log('  This is not critical - ripgrep may still work correctly');
    }
  } catch (error) {
    console.log(
      `⚠ Ripgrep setup encountered an issue: ${error.message || 'Unknown error'}`,
    );
    console.log('  Continuing anyway - this should not affect functionality');
  }
}

// Wrap the entire execution to ensure no errors escape to npm
try {
  setupRipgrepBinaries();
} catch {
  // Last resort catch - never let errors block npm
  console.log('⚠ Postinstall script encountered an unexpected error');
  console.log('  This will not affect the installation');
}
