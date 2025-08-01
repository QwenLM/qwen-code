/**
 * @license
 * Copyright 2025 Google LLC
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

import { copyFileSync, existsSync, mkdirSync } from 'fs';
import { dirname, join, basename } from 'path';
import { fileURLToPath } from 'url';
import { glob } from 'glob';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const bundleDir = join(root, 'bundle');

// Create the bundle directory if it doesn't exist
if (!existsSync(bundleDir)) {
  mkdirSync(bundleDir);
}

// Find and copy all .sb files from packages to the root of the bundle directory
const sbFiles = glob.sync('packages/**/*.sb', { cwd: root });
for (const file of sbFiles) {
  copyFileSync(join(root, file), join(bundleDir, basename(file)));
}

// Copy tiktoken WASM files to bundle directory
// We prioritize the main tiktoken WASM file over the lite version
const tiktokenWasmFile = 'node_modules/tiktoken/tiktoken_bg.wasm';
const sourcePath = join(root, tiktokenWasmFile);

if (existsSync(sourcePath)) {
  const targetPath = join(bundleDir, 'tiktoken_bg.wasm');
  copyFileSync(sourcePath, targetPath);
  console.log(`Copied ${tiktokenWasmFile} to bundle/`);
} else {
  // Fallback to lite version if main version doesn't exist
  const liteWasmFile = 'node_modules/tiktoken/lite/tiktoken_bg.wasm';
  const liteSourcePath = join(root, liteWasmFile);
  if (existsSync(liteSourcePath)) {
    const targetPath = join(bundleDir, 'tiktoken_bg.wasm');
    copyFileSync(liteSourcePath, targetPath);
    console.log(`Copied ${liteWasmFile} to bundle/ (fallback)`);
  } else {
    console.warn('Warning: No tiktoken WASM files found');
  }
}

console.log('Assets copied to bundle/');
