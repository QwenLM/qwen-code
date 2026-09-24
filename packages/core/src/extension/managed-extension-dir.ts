/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createDebugLogger } from '../utils/debugLogger.js';

const debugLogger = createDebugLogger('Extension:managedDir');

// The alreadyResolved branch runs on every Config/ExtensionManager
// construction (a daemon constructs one per request), so an unavailable
// root is reported on stderr once per root per process, not per request.
const warnedUnavailableRoots = new Set<string>();

export function resolveManagedExtensionsDir(
  value: string | undefined,
  cwd?: string,
  options?: { alreadyResolved?: boolean },
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(
      'Invalid --managed-extensions: specify one non-empty directory.',
    );
  }
  const directory = path.resolve(cwd ?? '', value);
  // A value that crossed the process boundary (argv coercion, serve option
  // setup) was already validated there. Re-throwing from a later Config or
  // ExtensionManager construction would hard-fail every new session and
  // extension route of a healthy process when a deployment-owned root
  // flickers, so construction degrades to "no managed packages" instead —
  // loadExtensionsFromExtensionsDir lists an unreadable root as empty.
  if (options?.alreadyResolved) {
    try {
      if (!fs.statSync(directory).isDirectory()) {
        throw new Error('not a directory');
      }
      fs.accessSync(directory, fs.constants.R_OK | fs.constants.X_OK);
    } catch (error) {
      const message = `Managed extensions root "${directory}" is unavailable: ${
        error instanceof Error ? error.message : String(error)
      }. Continuing without managed packages.`;
      debugLogger.warn(message);
      // debugLogger is silent without an active debug session; without this
      // line a dropped root releases every managed name to a same-name user
      // extension with no signal anywhere.
      if (!warnedUnavailableRoots.has(directory)) {
        warnedUnavailableRoots.add(directory);
        process.stderr.write(
          `Warning: ${message} Same-name user extensions are no longer shadowed.\n`,
        );
      }
    }
    return directory;
  }
  let failure: unknown;
  try {
    // A root that is itself a link would let whoever can replace the link
    // relocate every consumer's boundary (the no-prompt read roots among
    // them); links in the path ABOVE the root are canonicalized instead.
    if (fs.lstatSync(directory).isSymbolicLink()) {
      throw new Error('must be a real directory, not a symbolic link');
    }
    // Pin the canonical path so later re-resolution (a relinked parent
    // component) cannot move the root between validation and use.
    const pinned = canonicalDirectory(directory);
    if (!fs.statSync(pinned).isDirectory()) {
      throw new Error('not a directory');
    }
    fs.accessSync(pinned, fs.constants.R_OK | fs.constants.X_OK);
    fs.readdirSync(pinned);
    return pinned;
  } catch (error) {
    failure = error;
  }
  // A container sandbox (docker/podman) forwards the flag verbatim, so its
  // Linux child receives the host spelling of a Windows path, which cannot
  // exist in the container; the mount placed the root at the translated
  // path. Accept that spelling only when the value as given failed every
  // check — a genuine root named "C:\..." next to the cwd keeps winning,
  // and a bad root keeps failing with the user's own spelling.
  const translated = windowsContainerPath(value);
  if (translated !== undefined) {
    try {
      return resolveManagedExtensionsDir(translated);
    } catch {
      // Fall through and report the spelling the user actually gave.
    }
  }
  throw new Error(
    `Invalid --managed-extensions "${directory}": ${failure instanceof Error ? failure.message : String(failure)}`,
    { cause: failure },
  );
}

// Mirror of the translation a container sandbox applies to host paths
// (getContainerPath in packages/cli/src/serve/sandbox.ts): inside the Linux
// container a Windows drive-letter root lands at /<drive>/<rest>.
function windowsContainerPath(value: string): string | undefined {
  if (process.platform === 'win32') return undefined;
  const match = value.match(/^([a-zA-Z]):[\\/](.*)$/);
  if (!match) return undefined;
  return `/${match[1]!.toLowerCase()}/${match[2]!.replace(/\\/g, '/')}`;
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

// Win32 and darwin default volumes equate names differing only in case, and
// realpath preserves the spelling it was given — so one physical directory
// can reach the comparison under two spellings. Fold case there, or a
// case-variant spelling slips past the containment guard (the same failure
// config/storage.ts folds for).
function platformFoldsCase(): boolean {
  return process.platform === 'win32' || process.platform === 'darwin';
}

export function assertManagedExtensionStateSeparation(
  managedDirectory: string | undefined,
  writableDirectories: string[],
): void {
  if (!managedDirectory) return;
  const managed = canonicalDirectory(managedDirectory);
  const contains = (parent: string, child: string) => {
    const fold = platformFoldsCase();
    const relative = path.relative(
      fold ? parent.toLowerCase() : parent,
      fold ? child.toLowerCase() : child,
    );
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
