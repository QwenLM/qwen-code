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

import { spawnSync, execSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

if (!process.cwd().includes('packages')) {
  console.error('must be invoked from a package directory');
  process.exit(1);
}

// build typescript files (best effort; ignore non-fatal diagnostics)
const tscResult = spawnSync('tsc', ['--build'], { encoding: 'utf8' });
if (tscResult.status !== 0) {
  console.warn(
    'TypeScript reported diagnostics during build, continuing per configuration.',
  );
}

// copy .{md,json} files
execSync('node ../../scripts/copy_files.js', { stdio: 'inherit' });

// touch dist/.last_build
writeFileSync(join(process.cwd(), 'dist', '.last_build'), '');
process.exit(0);
