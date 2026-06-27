/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import path from 'node:path';

export function isContainerPathWithinWorkdir(
  containerWorkdir: string,
  containerPath: string,
): boolean {
  const normalize = (value: string) => {
    const normalized = path.posix
      .normalize(value.replace(/\\/g, '/'))
      .replace(/\/+$/, '')
      .toLowerCase();
    return normalized || '/';
  };

  const normalizedWorkdir = normalize(containerWorkdir);
  const normalizedPath = normalize(containerPath);

  if (normalizedWorkdir === '/') {
    return normalizedPath.startsWith('/');
  }

  return (
    normalizedPath === normalizedWorkdir ||
    normalizedPath.startsWith(`${normalizedWorkdir}/`)
  );
}
