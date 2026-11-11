/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export const runtimeAssetManifest = [
  {
    id: 'builtin-skills',
    repoRel: 'packages/core/src/skills/builtin',
    sidecarRel: 'builtin',
    recursive: true,
  },
];

export const workerRuntimeExtraAssetDirs = ['vendor', 'node_modules'];

export const workerRuntimeAssetDirs = [
  ...runtimeAssetManifest
    .map((entry) => entry.sidecarRel)
    .filter((sidecarRel) => sidecarRel !== '.'),
  ...workerRuntimeExtraAssetDirs,
];

export function isRuntimeAssetRepoPathCovered(repoRelPath) {
  return runtimeAssetManifest.some((entry) => {
    if (repoRelPath === entry.repoRel) return true;
    if (!repoRelPath.startsWith(`${entry.repoRel}/`)) return false;
    const name = repoRelPath
      .slice(entry.repoRel.length + 1)
      .split('/')
      .at(-1);
    return !entry.include || entry.include(name ?? '');
  });
}
