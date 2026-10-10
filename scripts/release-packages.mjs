/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getWorkspacePackageJsonPaths } from './workspaces.js';

export const INDEPENDENT_PACKAGES = [
  '@qwen-code/sdk',
  '@qwen-code/mobile-mcp',
  '@qwen-code/node-repl-mcp',
  '@qwen-code/qwen-live',
];

// Resolve beside this script, not cwd: the push guard uses workflow-pinned
// manifests even when the release source comes from a different ref.
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { workspaces } = JSON.parse(
  readFileSync(join(root, 'package.json'), 'utf8'),
);

export const RELEASE_WORKSPACES = getWorkspacePackageJsonPaths(root, workspaces)
  .map((path) => JSON.parse(readFileSync(join(root, path), 'utf8')))
  .filter((pkg) => !pkg.private && !INDEPENDENT_PACKAGES.includes(pkg.name))
  .map((pkg) => pkg.name);

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  for (const name of RELEASE_WORKSPACES) {
    if (
      name === '@qwen-code/audio-capture' &&
      process.env.PUBLISH_AUDIO_CAPTURE !== 'true'
    )
      continue;
    if (
      name === '@qwen-code/external-context-mem0' &&
      process.env.PUBLISH_EXTERNAL_CONTEXT_MEM0 !== 'true'
    )
      continue;
    console.log(name);
  }
}
