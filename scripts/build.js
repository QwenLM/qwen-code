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
import {
  existsSync,
  lstatSync,
  symlinkSync,
  mkdirSync,
  rmSync,
  realpathSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

// npm install if node_modules was removed (e.g. via npm run clean or scripts/clean.js)
if (!existsSync(join(root, 'node_modules'))) {
  execSync('npm install', { stdio: 'inherit', cwd: root });
}

// Ensure workspace package symlinks exist in node_modules.
// When npm resolves `npm:@alife/...@*` aliases, it may install a stale
// registry version instead of symlinking to the local workspace.  This
// check fixes those links so that TypeScript project references (which
// rely on node_modules resolution) always see the local source.
const workspaceLinks = [
  ['@qwen-code/qwen-code-core', 'packages/core'],
  ['@qwen-code/channel-base', 'packages/channels/base'],
  ['@qwen-code/channel-telegram', 'packages/channels/telegram'],
  ['@qwen-code/channel-weixin', 'packages/channels/weixin'],
  ['@qwen-code/channel-dingtalk', 'packages/channels/dingtalk'],
  ['@qwen-code/web-templates', 'packages/web-templates'],
];

for (const [pkg, localPath] of workspaceLinks) {
  const linkPath = join(root, 'node_modules', ...pkg.split('/'));
  const targetPath = resolve(root, localPath);
  let needsLink = false;

  if (!existsSync(linkPath)) {
    needsLink = true;
  } else {
    try {
      const stat = lstatSync(linkPath);
      if (stat.isSymbolicLink()) {
        const resolved = realpathSync(linkPath);
        if (resolved !== targetPath) {
          needsLink = true;
        }
      } else {
        // It's a real directory (installed from registry), replace it
        needsLink = true;
      }
    } catch {
      needsLink = true;
    }
  }

  if (needsLink) {
    console.log(`Fixing workspace link: ${pkg} -> ${localPath}`);
    try {
      rmSync(linkPath, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    const parentDir = dirname(linkPath);
    mkdirSync(parentDir, { recursive: true });
    symlinkSync(targetPath, linkPath);
  }
}

// build all workspaces/packages in dependency order
execSync('npm run generate', { stdio: 'inherit', cwd: root });

// Build in dependency order:
// 1. core (foundation package, includes test-utils)
// 2. web-templates (embeddable web templates - used by cli)
// 3. channel-base (base channel infrastructure - used by channel adapters and cli)
// 4. channel adapters (depend on channel-base)
// 5. cli (depends on core, web-templates, channel packages)
// 6. webui (shared UI components - used by vscode companion)
// 7. sdk (no internal dependencies)
// 8. vscode-ide-companion (depends on webui)
const buildOrder = [
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
  execSync(`npm run build --workspace=${workspace}`, {
    stdio: 'inherit',
    cwd: root,
  });

  // After cli is built, generate the JSON Schema for settings
  // so the vscode-ide-companion extension can provide IntelliSense
  if (workspace === 'packages/cli') {
    execSync('node --import tsx/esm scripts/generate-settings-schema.ts', {
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
