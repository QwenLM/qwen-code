/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { downloadRipGrep } from '../third_party/get-ripgrep/src/downloadRipGrep.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

// npm install if node_modules was removed (e.g. via npm run clean or scripts/clean.js)
if (!existsSync(join(root, 'node_modules'))) {
  execSync('npm install', { stdio: 'inherit', cwd: root });
}

// build all workspaces/packages
execSync('npm run generate', { stdio: 'inherit', cwd: root });

// Build shared workspaces in dependency order, including runtime asset copies.
const PRIORITY_WORKSPACES = [
  '@qwen-code/resource',
  '@qwen-code/core',
  '@qwen-code/qwen-code',
];

if (process.env.CI) {
  console.log('CI environment detected. Building workspaces sequentially...');
  for (const w of PRIORITY_WORKSPACES) {
    console.log(`Building ${w}...`);
    execSync(`npm run build -w ${w}`, { stdio: 'inherit', cwd: root });
  }
  const workspaceInfo = JSON.parse(
    execSync('npm query .workspace --json', { cwd: root, encoding: 'utf-8' }),
  );
  const remaining = workspaceInfo
    .map((w) => w.name)
    .filter((name) => !PRIORITY_WORKSPACES.includes(name));
  for (const w of remaining) {
    execSync(`npm run build -w ${w}`, { stdio: 'inherit', cwd: root });
  }
} else {
  // Build shared dependencies before independent workspaces.
  for (const w of PRIORITY_WORKSPACES) {
    console.log(`Building ${w}...`);
    execSync(`npm run build -w ${w}`, { stdio: 'inherit', cwd: root });
  }

  // Build the rest. Default is parallel via npm-run-all; setting
  // BUILD_SERIAL=1 drops to sequential, which is slower but avoids
  // npm-run-all's child-stdio EBADF flake we've seen on self-hosted
  // macOS runners under load.
  const workspaceInfo = JSON.parse(
    execSync('npm query .workspace --json', { cwd: root, encoding: 'utf-8' }),
  );
  const otherWorkspaces = workspaceInfo
    .map((w) => w.name)
    .filter((name) => !PRIORITY_WORKSPACES.includes(name));

  if (process.env.BUILD_SERIAL === '1') {
    console.log('Building other workspaces sequentially (BUILD_SERIAL=1)...');
    for (const w of otherWorkspaces) {
      execSync(`npm run build -w ${w}`, { stdio: 'inherit', cwd: root });
    }
  } else {
    console.log('Building other workspaces in parallel...');
    execSync(
      `npx npm-run-all --parallel ${otherWorkspaces.map((w) => `"build -w ${w}"`).join(' ')}`,
      { stdio: 'inherit', cwd: root },
    );
  }
}

// Ensure vendor ripgrep is available for local development.
// Runtime resolves it at packages/core/vendor/ripgrep/${arch}-${platform}/rg
// CI environments don't need vendor ripgrep – skip the download to save time
// and avoid potential network failures.
if (!process.env.CI && !process.env.SKIP_VENDOR_RG) {
  const archDir = `${process.arch}-${process.platform}`;
  const rgBinaryName = process.platform === 'win32' ? 'rg.exe' : 'rg';
  const vendorRgDir = join(
    root,
    'packages',
    'core',
    'dist',
    'vendor',
    'ripgrep',
    archDir,
  );
  const vendorRgPath = join(vendorRgDir, rgBinaryName);

  if (!existsSync(vendorRgPath)) {
    console.log('Downloading vendor ripgrep for local development...');
    try {
      await downloadRipGrep(vendorRgDir);
      console.log(`Vendor ripgrep installed at ${vendorRgDir}`);
    } catch (e) {
      console.warn('Warning: Failed to download vendor ripgrep:', e.message);
      console.warn('The CLI will fall back to system rg if available.');
    }
  } else {
    console.log('Vendor ripgrep already present, skipping download.');
  }
} else {
  console.log('CI environment detected, skipping vendor ripgrep download.');
}
