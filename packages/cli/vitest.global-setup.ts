/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

// Workspace package name — keep in sync with packages/cli/package.json
const CLI_NPM_PACKAGE = '@qwen-code/qwen-code';

// Derive repo root from this file's location (packages/cli/vitest.global-setup.ts)
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');

function latestModifiedTimeMs(targetPath: string): number {
  const stat = fs.statSync(targetPath);
  if (!stat.isDirectory()) {
    return stat.mtimeMs;
  }

  let latest = stat.mtimeMs;
  for (const entry of fs.readdirSync(targetPath, { withFileTypes: true })) {
    latest = Math.max(
      latest,
      latestModifiedTimeMs(path.join(targetPath, entry.name)),
    );
  }
  return latest;
}

export default function ensureCliDistForInkShim() {
  const distEntry = path.resolve(
    REPO_ROOT,
    'packages/cli/dist/src/ink/index.js',
  );
  const inkSourceRoot = path.resolve(REPO_ROOT, 'packages/cli/src/ink');
  const inkShimEntry = path.resolve(REPO_ROOT, 'packages/ink-shim/index.js');

  const distIsFresh =
    fs.existsSync(distEntry) &&
    fs.statSync(distEntry).mtimeMs >=
      Math.max(
        latestModifiedTimeMs(inkSourceRoot),
        latestModifiedTimeMs(inkShimEntry),
      );
  if (distIsFresh) {
    return;
  }

  execFileSync('npm', ['run', 'build', `--workspace=${CLI_NPM_PACKAGE}`], {
    cwd: REPO_ROOT,
    stdio: 'inherit',
  });
}
