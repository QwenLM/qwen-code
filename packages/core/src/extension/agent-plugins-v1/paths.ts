/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export function isPathWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== '..' &&
      !path.isAbsolute(relative))
  );
}

export function resolveContainedExistingPath(
  root: string,
  candidate: string,
): string {
  const resolvedRoot = fs.realpathSync.native(root);
  const resolvedCandidate = fs.realpathSync.native(candidate);
  if (!isPathWithin(resolvedRoot, resolvedCandidate)) {
    throw new Error(
      `Path "${candidate}" resolves outside plugin root "${root}".`,
    );
  }
  return resolvedCandidate;
}

export function resolveContainedPotentialPath(
  root: string,
  candidate: string,
): string {
  const resolvedRoot = fs.realpathSync.native(root);
  const resolvedCandidate = resolveExistingPathPrefix(path.resolve(candidate));
  if (!isPathWithin(resolvedRoot, resolvedCandidate)) {
    throw new Error(
      `Path "${candidate}" resolves outside plugin root "${root}".`,
    );
  }
  return resolvedCandidate;
}

export function resolveExistingPathPrefix(candidate: string): string {
  let current = path.resolve(candidate);
  const missingSegments: string[] = [];

  while (true) {
    try {
      const resolved = fs.realpathSync.native(current);
      return path.join(resolved, ...missingSegments);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      missingSegments.unshift(path.basename(current));
      current = parent;
    }
  }
}
