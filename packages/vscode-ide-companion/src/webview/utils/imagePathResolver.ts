/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'fs';
import * as path from 'path';
import { Storage } from '@qwen-code/qwen-code-core';

export function resolveImagePathsForWebview({
  paths,
  workspaceRoots,
  globalTempDir,
  existsSync,
  toWebviewUri,
}: {
  paths: string[];
  workspaceRoots: string[];
  globalTempDir: string;
  existsSync: (path: string) => boolean;
  toWebviewUri: (path: string) => string;
}): Array<{ path: string; src: string | null }> {
  const allowedRoots = [...workspaceRoots, globalTempDir].filter(Boolean);
  const root = workspaceRoots[0];

  return paths.map((imagePath) => {
    if (!imagePath || typeof imagePath !== 'string') {
      return { path: imagePath, src: null };
    }

    const resolvedPath = path.isAbsolute(imagePath)
      ? path.normalize(imagePath)
      : root
        ? path.normalize(path.resolve(root, imagePath))
        : null;

    if (!resolvedPath) {
      return { path: imagePath, src: null };
    }

    const isAllowed = allowedRoots.some((allowedRoot) => {
      const normalizedRoot = path.normalize(allowedRoot);
      return (
        resolvedPath === normalizedRoot ||
        resolvedPath.startsWith(normalizedRoot + path.sep)
      );
    });

    if (!isAllowed || !existsSync(resolvedPath)) {
      return { path: imagePath, src: null };
    }

    return { path: imagePath, src: toWebviewUri(resolvedPath) };
  });
}

/**
 * Create image path resolution handler for WebView
 */
export function createImagePathResolver({
  workspaceRoots,
  toWebviewUri,
}: {
  workspaceRoots: string[];
  toWebviewUri: (filePath: string) => string;
}) {
  return function resolveImagePaths(
    paths: string[],
  ): Array<{ path: string; src: string | null }> {
    return resolveImagePathsForWebview({
      paths,
      workspaceRoots,
      globalTempDir: Storage.getGlobalTempDir(),
      existsSync: fs.existsSync,
      toWebviewUri,
    });
  };
}
