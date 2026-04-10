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

// npm install if node_modules was removed (e.g. via npm run clean or scripts/clean.js)
if (!existsSync(join(root, 'node_modules'))) {
  execSync('bun install', { stdio: 'inherit', cwd: root });
}

// build all workspaces/packages in dependency order
execSync('bun run generate', { stdio: 'inherit', cwd: root });

// Build Rust file search module first (before core, which depends on it)
const fileSearchRsDir = join(root, 'packages', 'file-search-rs');
let rustFileSearchIntegrated = false;

if (existsSync(join(fileSearchRsDir, 'Cargo.toml'))) {
  console.log('');
  console.log('━'.repeat(60));
  console.log('Building Rust file search module...');
  console.log('━'.repeat(60));
  try {
    execSync('npm run build', {
      stdio: 'inherit',
      cwd: fileSearchRsDir,
    });

    // Copy the .node file to core's dist directory
    const { readdirSync, copyFileSync, mkdirSync } = await import('node:fs');
    const { join: pathJoin } = await import('node:path');
    const coreDistDir = join(
      root,
      'packages',
      'core',
      'dist',
      'src',
      'utils',
      'filesearch',
    );
    mkdirSync(coreDistDir, { recursive: true });

    const nodeFiles = readdirSync(fileSearchRsDir).filter((f) =>
      f.endsWith('.node'),
    );
    if (nodeFiles.length > 0) {
      const { statSync } = await import('node:fs');
      for (const nodeFile of nodeFiles) {
        const src = pathJoin(fileSearchRsDir, nodeFile);
        const dest = pathJoin(coreDistDir, nodeFile);
        copyFileSync(src, dest);
        const size = statSync(dest).size;
        console.log(
          `  ✓ Copied ${nodeFile} (${(size / 1024 / 1024).toFixed(1)} MB)`,
        );
      }
      rustFileSearchIntegrated = true;
    }

    console.log('━'.repeat(60));
    if (rustFileSearchIntegrated) {
      console.log(
        '✅ Rust file search module compiled and integrated successfully.',
      );
    } else {
      console.log(
        '⚠️  Rust file search module compiled but .node file not found. Will use JavaScript fallback.',
      );
    }
    console.log('━'.repeat(60));
    console.log('');
  } catch (e) {
    console.log('━'.repeat(60));
    console.log(
      '❌ Failed to build Rust file search module. Falling back to JavaScript.',
    );
    console.log('━'.repeat(60));
    console.log('');
    console.warn('Error details:', e.message);
    console.log('');
  }
} else {
  console.log('');
  console.log(
    'ℹ️  Rust file search module not found (packages/file-search-rs/Cargo.toml missing). Using JavaScript fallback.',
  );
  console.log('');
}

// Build in dependency order:
// 1. test-utils (no internal dependencies)
// 2. core (foundation package)
// 3. web-templates (embeddable web templates - used by cli)
// 4. channel-base (base channel infrastructure - used by channel adapters and cli)
// 5. channel adapters (depend on channel-base)
// 6. cli (depends on core, test-utils, web-templates, channel packages)
// 6. webui (shared UI components - used by vscode companion)
// 7. sdk (no internal dependencies)
// 8. vscode-ide-companion (depends on webui)
const buildOrder = [
  'packages/test-utils',
  'packages/core',
  'packages/web-templates',
  'packages/channels/base',
  'packages/channels/telegram',
  'packages/channels/weixin',
  'packages/channels/dingtalk',
  'packages/channels/plugin-example',
  'packages/cli',
  'packages/webui',
  'packages/sdk-typescript',
  'packages/vscode-ide-companion',
];

for (const workspace of buildOrder) {
  execSync(`bun run --filter=./${workspace} build`, {
    stdio: 'inherit',
    cwd: root,
  });

  // After cli is built, generate the JSON Schema for settings
  // so the vscode-ide-companion extension can provide IntelliSense
  if (workspace === 'packages/cli') {
    execSync('bun run generate:settings-schema', {
      stdio: 'inherit',
      cwd: root,
    });
  }
}

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
