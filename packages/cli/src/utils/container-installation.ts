/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { access, lstat, readdir, readlink, realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  normalize,
  relative,
  resolve,
  sep,
} from 'node:path';

function contains(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return (
    path === '' ||
    (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path))
  );
}

async function canonicalDirectory(path: string): Promise<string> {
  if (dirname(path) === path) return realpath(path);
  const canonical = join(
    await canonicalDirectory(dirname(path)),
    basename(path),
  );
  const entry = await lstat(canonical).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
    return undefined;
  });
  if (entry?.isSymbolicLink()) {
    throw new Error(
      `Container execution does not support symlinked installation or dependency search paths: ${canonical}. Use an independent CLI installation.`,
    );
  }
  // Missing lookup directories still matter: a later import can search them.
  return entry ? realpath(canonical) : canonical;
}

export async function containerTrustedDirectories(
  bundleDirectory: string,
  signal: AbortSignal,
): Promise<string[]> {
  signal.throwIfAborted();
  const bundle = await canonicalDirectory(bundleDirectory);
  try {
    await access(join(bundle, 'cli.js'));
    await access(join(bundle, 'execution-worker.js'));
  } catch (cause) {
    throw new Error(
      'Container execution requires a complete bundled CLI installation; source and tsc launches are unsupported.',
      { cause },
    );
  }
  const roots = [bundle];
  // Close over canonical lookup roots, including Node's global search paths.
  for (const root of roots) {
    signal.throwIfAborted();
    const lookup = createRequire(join(root, 'cli.js')).resolve.paths(
      '__qwen_container_boundary__',
    );
    for (const path of lookup ?? []) {
      const canonical = await canonicalDirectory(path);
      if (!roots.some((parent) => contains(parent, canonical)))
        roots.push(canonical);
    }
  }
  const scanRoots = roots.filter(
    (root) => !roots.some((other) => other !== root && contains(other, root)),
  );
  const pending = [...scanRoots];
  while (pending.length) {
    signal.throwIfAborted();
    const directory = pending.pop()!;
    const entries = await readdir(directory, { withFileTypes: true }).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT' || !scanRoots.includes(directory))
          throw error;
        return [];
      },
    );
    for (const entry of entries) {
      signal.throwIfAborted();
      const path = join(directory, entry.name);
      if (entry.isDirectory()) pending.push(path);
      if (entry.isFile() && (await lstat(path)).nlink > 1) {
        throw new Error(
          `Container execution does not support hard-linked installation files: ${path}. Use an independent CLI installation.`,
        );
      }
      if (entry.isSymbolicLink()) {
        const link = await readlink(path);
        if (link !== normalize(link)) {
          throw new Error(
            `Container execution requires normalized package links; non-normalized symlink target at ${path}.`,
          );
        }
        const directTarget = resolve(directory, link);
        const target = await realpath(path);
        if (
          ![directTarget, target].every((target) =>
            roots.some((root) => contains(root, target)),
          )
        ) {
          throw new Error(
            `Container execution requires an independent CLI installation without links outside its protected dependency directories: ${path}.`,
          );
        }
      }
    }
  }
  return roots;
}
