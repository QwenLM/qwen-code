/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const BUNDLE_CHUNK_DIR = 'chunks';

function resolveBundleDirFastPath(importMetaUrl: string): string {
  const moduleDir = path.dirname(fileURLToPath(importMetaUrl));
  return path.basename(moduleDir) === BUNDLE_CHUNK_DIR
    ? path.dirname(moduleDir)
    : moduleDir;
}

/**
 * Locate the built Web Shell assets directory (the one containing
 * `index.html` + `assets/`). Returns `undefined` when the assets are not
 * present so serve can degrade to API-only instead of crashing.
 */
export function resolveWebShellDir(): string | undefined {
  const selfDir = path.dirname(fileURLToPath(import.meta.url));
  const hasShell = (dir: string): boolean =>
    existsSync(path.join(dir, 'index.html')) &&
    existsSync(path.join(dir, 'assets'));

  const bundled = path.join(
    resolveBundleDirFastPath(import.meta.url),
    'web-shell',
  );
  if (hasShell(bundled)) return bundled;

  let dir = selfDir;
  for (let i = 0; i < 10; i++) {
    const candidate = path.join(dir, 'packages', 'web-shell', 'dist');
    if (hasShell(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}
