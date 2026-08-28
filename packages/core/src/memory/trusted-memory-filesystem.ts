/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(comparable(root), comparable(candidate));
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== '..' &&
      !path.isAbsolute(relative))
  );
}

function comparable(filePath: string): string {
  const normalized = path.normalize(filePath);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

export async function resolveTrustedMemoryRoot(
  root: string,
  trustedAnchor: string,
): Promise<string | undefined> {
  const stats = await fs.lstat(root).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  });
  if (!stats) return undefined;
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error(`Refusing symlinked memory root or non-directory: ${root}`);
  }

  const relative = path.relative(trustedAnchor, root);
  if (!isWithin(path.resolve(trustedAnchor), path.resolve(root))) {
    throw new Error(`Memory root is outside its trusted anchor: ${root}`);
  }
  const expected = path.join(await fs.realpath(trustedAnchor), relative);
  const resolved = await fs.realpath(root);
  if (comparable(resolved) !== comparable(expected)) {
    throw new Error(
      `Memory root resolves outside its trusted boundary: ${root}`,
    );
  }
  return resolved;
}

export interface TrustedMemoryFile {
  relativePath: string;
  resolvedPath: string;
}

export async function listTrustedMemoryMarkdownFiles(
  root: string,
  trustedAnchor: string,
  excludedFilename: string,
): Promise<TrustedMemoryFile[]> {
  const resolvedRoot = await resolveTrustedMemoryRoot(root, trustedAnchor);
  if (!resolvedRoot) return [];
  const files: TrustedMemoryFile[] = [];

  const visit = async (
    directory: string,
    relativeDir: string,
  ): Promise<void> => {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const relativePath = relativeDir
        ? path.join(relativeDir, entry.name)
        : entry.name;
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(absolutePath, relativePath);
      } else if (
        entry.isFile() &&
        entry.name.endsWith('.md') &&
        entry.name !== excludedFilename
      ) {
        const resolvedPath = await fs.realpath(absolutePath);
        if (isWithin(resolvedRoot, resolvedPath)) {
          files.push({
            relativePath: relativePath.replaceAll('\\', '/'),
            resolvedPath,
          });
        }
      }
    }
  };

  await visit(root, '');
  return files.sort((a, b) =>
    a.relativePath < b.relativePath
      ? -1
      : a.relativePath > b.relativePath
        ? 1
        : 0,
  );
}

export async function resolveTrustedMemoryFile(
  root: string,
  trustedAnchor: string,
  relativePath: string,
): Promise<string | undefined> {
  const resolvedRoot = await resolveTrustedMemoryRoot(root, trustedAnchor);
  if (!resolvedRoot) return undefined;
  const candidate = path.join(root, relativePath);
  const stats = await fs.lstat(candidate).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  });
  if (!stats?.isFile() || stats.isSymbolicLink()) return undefined;
  const resolved = await fs.realpath(candidate);
  return isWithin(resolvedRoot, resolved) ? resolved : undefined;
}
