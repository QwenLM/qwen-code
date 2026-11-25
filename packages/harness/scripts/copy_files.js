#!/usr/bin/env node

/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Copyright 2025 Google LLC
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

import fs from 'node:fs';
import path from 'node:path';

const packageName = path.basename(process.cwd());
const sourceDir = packageName === 'qoder' ? 'skills' : 'src';
const targetDir = path.join('dist', sourceDir);

const extensionsToCopy = ['.md', '.json', '.toml', '.cs', '.exe', '.node'];

function copyFilesRecursive(source, target) {
  if (!fs.existsSync(target)) {
    fs.mkdirSync(target, { recursive: true });
  }

  const items = fs.readdirSync(source, { withFileTypes: true });

  for (const item of items) {
    const sourcePath = path.join(source, item.name);
    const targetPath = path.join(target, item.name);

    if (item.isDirectory()) {
      copyFilesRecursive(sourcePath, targetPath);
    } else if (extensionsToCopy.includes(path.extname(item.name))) {
      fs.copyFileSync(sourcePath, targetPath);
    }
  }
}

if (!fs.existsSync(sourceDir)) {
  console.error(`Source directory ${sourceDir} not found.`);
  process.exit(1);
}

copyFilesRecursive(sourceDir, targetDir);

// Copy example extensions into the bundle.
if (packageName === 'cli') {
  const examplesSource = path.join(
    sourceDir,
    'commands',
    'extensions',
    'examples',
  );
  const examplesTarget = path.join(
    targetDir,
    'commands',
    'extensions',
    'examples',
  );
  if (fs.existsSync(examplesSource)) {
    fs.cpSync(examplesSource, examplesTarget, { recursive: true });
  }
}

// Copy Core's test template and built-in skills.
if (packageName === 'core') {
  // The shared test rig also runs from dist and loads this ESM template by path.
  fs.copyFileSync(
    path.join(sourceDir, 'test-utils', 'test-mcp-server-template.mjs'),
    path.join(targetDir, 'test-utils', 'test-mcp-server-template.mjs'),
  );

  const builtinSkillsSource = path.join(sourceDir, 'skills', 'builtin');
  const builtinSkillsTarget = path.join(targetDir, 'skills', 'builtin');
  if (fs.existsSync(builtinSkillsSource)) {
    fs.cpSync(builtinSkillsSource, builtinSkillsTarget, { recursive: true });
  }
}

console.log('Successfully copied files.');
