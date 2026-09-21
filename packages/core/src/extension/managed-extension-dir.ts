/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export function resolveManagedExtensionsDir(
  value: string | undefined,
  cwd?: string,
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(
      'Invalid --managed-extensions: specify one non-empty directory.',
    );
  }
  const directory = path.resolve(cwd ?? '', value);
  try {
    if (!fs.statSync(directory).isDirectory()) {
      throw new Error('not a directory');
    }
    fs.accessSync(directory, fs.constants.R_OK | fs.constants.X_OK);
    fs.readdirSync(directory);
  } catch (error) {
    throw new Error(
      `Invalid --managed-extensions "${directory}": ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  return directory;
}

function canonicalDirectory(directory: string): string {
  let current = path.resolve(directory);
  const missing: string[] = [];
  // Bound symlink chasing like the kernel's MAXSYMLINKS: a link loop falls
  // back to its literal path, which nothing can be written through anyway.
  let symlinkHops = 40;
  for (;;) {
    let stats: fs.Stats | undefined;
    try {
      stats = fs.lstatSync(current);
    } catch {
      stats = undefined;
    }
    if (stats?.isSymbolicLink()) {
      // existsSync follows links, so a dangling link would otherwise look
      // like a missing component and its target would escape the overlap
      // check. Resolve the link — existent or not — against its parent.
      const target = fs.readlinkSync(current);
      current = path.resolve(path.dirname(current), target);
      if (--symlinkHops < 0) return path.join(current, ...missing);
      continue;
    }
    if (stats) {
      return path.join(fs.realpathSync.native(current), ...missing);
    }
    const parent = path.dirname(current);
    if (parent === current) {
      throw new Error(
        `Invalid --managed-extensions: cannot resolve directory "${directory}" because filesystem root "${current}" is unavailable.`,
      );
    }
    missing.unshift(path.basename(current));
    current = parent;
  }
}

export function assertManagedExtensionStateSeparation(
  managedDirectory: string | undefined,
  writableDirectories: string[],
): void {
  if (!managedDirectory) return;
  const managed = canonicalDirectory(managedDirectory);
  const contains = (parent: string, child: string) => {
    const relative = path.relative(parent, child);
    return (
      relative === '' ||
      (!relative.startsWith(`..${path.sep}`) &&
        relative !== '..' &&
        !path.isAbsolute(relative))
    );
  };
  for (const directory of writableDirectories) {
    const writable = canonicalDirectory(directory);
    if (contains(managed, writable) || contains(writable, managed)) {
      throw new Error(
        `Invalid --managed-extensions "${managedDirectory}": managed extensions must not overlap writable extension state at "${directory}".`,
      );
    }
  }
}
