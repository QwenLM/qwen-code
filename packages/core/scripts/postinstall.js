#!/usr/bin/env node

/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const packageRoot = path.join(__dirname, '..');

const vendorBinaries = [
  ['ripgrep', 'rg'],
  ['bfs', 'bfs'],
  ['ugrep', 'ugrep'],
];

function setupVendorBinaries() {
  const { platform, arch } = process;
  if (platform === 'win32') {
    console.log('ℹ Windows detected, skipping vendor binary setup');
    return;
  }
  if (
    (platform !== 'darwin' && platform !== 'linux') ||
    (arch !== 'x64' && arch !== 'arm64')
  ) {
    console.log(`ℹ Unsupported platform ${platform}-${arch}, skipping setup`);
    return;
  }

  for (const [vendor, executable] of vendorBinaries) {
    const binary = path.join(
      packageRoot,
      'vendor',
      vendor,
      `${arch}-${platform}`,
      executable,
    );
    if (!fs.existsSync(binary)) {
      continue;
    }

    try {
      fs.chmodSync(binary, 0o755);
      if (platform === 'darwin') {
        try {
          execFileSync('xattr', ['-d', 'com.apple.quarantine', binary], {
            stdio: 'ignore',
          });
        } catch {
          // The quarantine attribute is normally absent.
        }
      }
    } catch (error) {
      console.log(
        `⚠ Could not set up ${vendor}: ${error.message || 'Unknown error'}`,
      );
    }
  }
}

try {
  setupVendorBinaries();
} catch {
  // Never block npm installation because of an optional permission repair.
  console.log('⚠ Vendor binary setup encountered an unexpected error');
}
