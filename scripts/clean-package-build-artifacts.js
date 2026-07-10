#!/usr/bin/env node
/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getWorkspacePackageJsonPaths } from './workspaces.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = join(__dirname, '..');
const RMRF_OPTIONS = { recursive: true, force: true };

export function cleanPackageBuildArtifacts({ root = DEFAULT_ROOT } = {}) {
  const rootPackageJson = JSON.parse(
    readFileSync(join(root, 'package.json'), 'utf-8'),
  );

  for (const pkgPath of getWorkspacePackageJsonPaths(
    root,
    rootPackageJson.workspaces,
  )) {
    const pkgDir = dirname(join(root, pkgPath));
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
