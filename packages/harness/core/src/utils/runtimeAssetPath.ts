/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EMBEDDED_ASSETS } from '../generated/embedded-assets-bun.js';
import { BRAND_NPM_PACKAGE } from '../config/brand.js';

// In a plain Bun bundle (non-compile mode), `with { type: 'file' }` imports
// produce sidecar files next to the bundle and the import values become relative
// path strings (e.g. "./default-policy-hsamzg57.toml").  These must be resolved
// against the bundle's own directory, not process.cwd().
// In a Bun-compiled binary the paths are already absolute (/$bunfs/...).
const _thisModuleDir = path.dirname(fileURLToPath(import.meta.url));

function resolveEmbeddedAssetPath(p: string): string {
  return path.isAbsolute(p) ? p : path.resolve(_thisModuleDir, p);
}

function isCliRepoRoot(dir: string): boolean {
  const packageJsonPath = path.join(dir, 'package.json');

  try {
    const raw = fs.readFileSync(packageJsonPath, 'utf8');
    const pkg = JSON.parse(raw) as {
      name?: string;
      workspaces?: string[];
    };

    return (
      pkg.name === BRAND_NPM_PACKAGE &&
      Array.isArray(pkg.workspaces) &&
      pkg.workspaces.includes('packages/*')
    );
  } catch {
    return false;
  }
}

function findRepoRootFrom(startDir: string): string | null {
  let currentDir = path.resolve(startDir);

  while (true) {
    if (isCliRepoRoot(currentDir)) {
      return currentDir;
    }

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      return null;
    }

    currentDir = parentDir;
  }
}

export function findCliRepoRoot(startDirs: string[] = []): string | null {
  for (const startDir of startDirs) {
    const repoRoot = findRepoRootFrom(startDir);
    if (repoRoot) {
      return repoRoot;
    }
  }

  return null;
}

/**
 * When callers ask for a directory (e.g. the whole `builtin/` tree), find any
 * embedded child under it and walk `path.dirname` back up to the directory's
 * /$bunfs/ path. Relies on Bun preserving the relative structure of embedded
 * files, which matches the layout we generate in embedded-assets-bun.ts.
 */
function resolveEmbeddedDirectory(repoRelativePath: string): string | null {
  const prefix = `${repoRelativePath}/`;
  for (const key of Object.keys(EMBEDDED_ASSETS)) {
    if (key.startsWith(prefix)) {
      const depth = key.slice(prefix.length).split('/').length;
      let dir = EMBEDDED_ASSETS[key];
      for (let i = 0; i < depth; i++) {
        dir = path.dirname(dir);
      }
      return dir;
    }
  }
  return null;
}

/**
 * Lists all embedded assets whose repo-relative key sits under `repoPrefix`.
 * Bun's /$bunfs/ doesn't support `fs.readdir` on embedded directories, so any
 * caller that needs to enumerate a tree of bundled files (e.g. builtin skills)
 * must consult `EMBEDDED_ASSETS` directly via this helper.
 *
 * The prefix is matched as a directory (a trailing `/` is added if missing).
 * Returns an empty array when running outside a Bun-compiled binary.
 */
export function listEmbeddedAssetsUnder(
  repoPrefix: string,
): Array<{ key: string; absPath: string }> {
  const prefix = repoPrefix.endsWith('/') ? repoPrefix : `${repoPrefix}/`;
  const out: Array<{ key: string; absPath: string }> = [];
  for (const key of Object.keys(EMBEDDED_ASSETS)) {
    if (key.startsWith(prefix)) {
      out.push({
        key,
        absPath: resolveEmbeddedAssetPath(EMBEDDED_ASSETS[key]),
      });
    }
  }
  return out;
}

export function resolveRuntimeAssetPath(
  moduleUrl: string,
  colocatedRelativePath: string,
  repoRelativePath: string,
): string {
  // In a Bun-compiled binary, EMBEDDED_ASSETS maps repo-relative paths to
  // /$bunfs/... paths for files baked in by generate-embedded-assets.ts.
  // Check this first so embedded files always win over stale sidecars.
  const embedded = EMBEDDED_ASSETS[repoRelativePath] as string | undefined;
  if (embedded) {
    return resolveEmbeddedAssetPath(embedded);
  }
  const embeddedDir = resolveEmbeddedDirectory(repoRelativePath);
  if (embeddedDir) {
    return resolveEmbeddedAssetPath(embeddedDir);
  }

  const moduleDir = path.dirname(fileURLToPath(moduleUrl));
  const colocatedPath = path.resolve(moduleDir, colocatedRelativePath);

  if (fs.existsSync(colocatedPath)) {
    return colocatedPath;
  }

  const executableDir = path.dirname(process.execPath);
  const executablePath = path.resolve(executableDir, colocatedRelativePath);
  if (fs.existsSync(executablePath)) {
    return executablePath;
  }

  const repoRoot = findCliRepoRoot([moduleDir, process.cwd()]);
  if (repoRoot) {
    const repoPath = path.resolve(repoRoot, repoRelativePath);
    if (fs.existsSync(repoPath)) {
      return repoPath;
    }
  }

  return colocatedPath;
}
