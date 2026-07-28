/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { getWorkspacePackageJsonPaths } from './workspaces.js';

const DEP_SECTIONS = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
];

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf-8'));
}

function writeJson(filePath, data) {
  writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n');
}

/**
 * Bump every workspace package to `newVersion` (except `exclude`d names) and
 * rewrite inter-workspace ^/~ dependency ranges to `^newVersion`.
 *
 * Editing package.json directly (instead of `npm version --workspace`) keeps
 * npm from reifying intermediate states where the bumped version no longer
 * satisfies sibling ranges like ^0.21.0 — npm "fixes" those by installing
 * the stale registry build into packages/*\/node_modules, which shadows the
 * workspace symlinks, breaks the release build, and leaks into
 * package-lock.json.
 *
 * @returns the names of the packages whose package.json was updated
 */
export function bumpWorkspaceVersions(root, newVersion, { exclude = [] } = {}) {
  const { workspaces: workspacePatterns } = readJson(
    path.join(root, 'package.json'),
  );
  const workspaces = getWorkspacePackageJsonPaths(root, workspacePatterns).map(
    (relativePath) => {
      const pkgPath = path.join(root, relativePath);
      return { pkgPath, pkg: readJson(pkgPath) };
    },
  );
  const versionedNames = new Set(
    workspaces
      .filter(({ pkg }) => !exclude.includes(pkg.name))
      .map(({ pkg }) => pkg.name),
  );

  const updated = [];
  for (const { pkgPath, pkg } of workspaces) {
    let changed = false;
    if (versionedNames.has(pkg.name)) {
      pkg.version = newVersion;
      changed = true;
    }
    for (const section of DEP_SECTIONS) {
      for (const [dep, range] of Object.entries(pkg[section] ?? {})) {
        if (
          versionedNames.has(dep) &&
          (range.startsWith('^') || range.startsWith('~'))
        ) {
          pkg[section][dep] = `^${newVersion}`;
          changed = true;
        }
      }
    }
    if (changed) {
      writeJson(pkgPath, pkg);
      updated.push(pkg.name);
    }
  }
  return updated;
}
