#!/usr/bin/env node
/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = join(__dirname, '..');
const RMRF_OPTIONS = { recursive: true, force: true };
const CLI_BUILD_PACKAGE_PATHS = [
  'packages/core',
  'packages/web-templates',
  'packages/channels/base',
  'packages/channels/telegram',
  'packages/channels/weixin',
  'packages/channels/dingtalk',
  'packages/channels/wecom',
  'packages/channels/feishu',
  'packages/channels/qqbot',
  'packages/channels/plugin-example',
  'packages/audio-capture',
  'packages/acp-bridge',
  'packages/sdk-typescript',
  'packages/cli',
];

export function cleanPackageBuildArtifacts({
  root = DEFAULT_ROOT,
  packagePaths = CLI_BUILD_PACKAGE_PATHS,
} = {}) {
  for (const pkgPath of packagePaths) {
    const pkgDir = join(root, pkgPath);
    rmSync(join(pkgDir, 'dist'), RMRF_OPTIONS);
    rmSync(join(pkgDir, 'tsconfig.tsbuildinfo'), { force: true });
  }
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1])
) {
  cleanPackageBuildArtifacts();
}
