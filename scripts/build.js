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
  execSync('npm install', { stdio: 'inherit', cwd: root });
}

// build all workspaces/packages in dependency order
execSync('npm run generate', { stdio: 'inherit', cwd: root });

// --cli-only: skip packages not needed by the CLI bundle
// (webui, web-shell, vscode-ide-companion are for IDE/web use only)
const cliOnly = process.argv.includes('--cli-only');

// Build in dependency order:
// 1. core (foundation package, includes test-utils)
// 2. web-templates (embeddable web templates - used by cli)
// 3. channel-base (base channel infrastructure - used by channel adapters and cli)
// 4. channel adapters (depend on channel-base)
// 5. audio-capture (native microphone backend used by cli)
// 6. acp-bridge (depends on core - used by cli)
// 7. sdk (build-time devDep on acp-bridge for shared constants, used by cli channel worker)
// 8. cli (depends on core, acp-bridge, web-templates, channel packages, sdk)
// 9. webui (shared UI components - used by vscode companion)
// 10. web-shell (depends on webui and sdk)
// 11. vscode-ide-companion (depends on webui)
const buildOrder = [
  'packages/core',
  'packages/web-templates',
  'packages/channels/base',
  'packages/channels/telegram',
  'packages/channels/weixin',
  'packages/channels/dingtalk',
  'packages/channels/wecom',
  'packages/channels/feishu',
  'packages/channels/qqbot',
  'packages/channels/github',
  'packages/channels/gitlab',
  'packages/channels/gitea',
  'packages/channels/plugin-example',
  'packages/audio-capture',
  'packages/acp-bridge',
  'packages/sdk-typescript',
  'packages/cli',
  ...(cliOnly
    ? []
    : [
        'packages/webui',
        'packages/web-shell',
        'packages/vscode-ide-companion',
        'packages/chrome-extension',
      ]),
];

for (const workspace of buildOrder) {
  const command =
    workspace === 'packages/audio-capture'
      ? `npm run build:ts --workspace=${workspace}`
      : `npm run build --workspace=${workspace}`;
  execSync(command, { stdio: 'inherit', cwd: root });

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
