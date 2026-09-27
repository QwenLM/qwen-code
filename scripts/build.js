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

import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

// Install if node_modules was removed (e.g. via npm run clean or scripts/clean.js)
if (!existsSync(join(root, 'node_modules'))) {
  execSync('corepack pnpm install --frozen-lockfile', {
    stdio: 'inherit',
    cwd: root,
  });
}

// build all workspaces/packages in dependency order
execSync('npm run generate', { stdio: 'inherit', cwd: root });

// Select the CLI by path: the repository root has the same package name.
const cliOnly = process.argv.includes('--cli-only');
// Mobile MCP has an independent build and was never part of the root build.
const filter = cliOnly
  ? '--filter "{./packages/cli}..." --filter @qwen-code/node-repl-mcp --filter @qwen-code/channel-plugin-example'
  : '--filter "!@qwen-code/mobile-mcp"';
execSync(`corepack pnpm -r ${filter} run build`, {
  stdio: 'inherit',
  cwd: root,
});

execSync('node --import tsx/esm scripts/generate-settings-schema.ts', {
  stdio: 'inherit',
  cwd: root,
});

// also build container image if sandboxing is enabled
// skip (-s) npm install + build since we did that above
try {
  execSync('node scripts/sandbox_command.js -q', {
    stdio: 'inherit',
    cwd: root,
  });
  if (
    process.env.BUILD_SANDBOX === '1' ||
    process.env.BUILD_SANDBOX === 'true'
  ) {
    execSync('node scripts/build_sandbox.js -s', {
      stdio: 'inherit',
      cwd: root,
    });
  }
} catch {
  // ignore
}
