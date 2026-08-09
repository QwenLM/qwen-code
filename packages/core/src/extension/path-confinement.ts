/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createDebugLogger } from '../utils/debugLogger.js';

const debugLogger = createDebugLogger('Extension:path-confinement');

/**
 * True when `child` equals or is nested under `parent`. Both must already be
 * absolute, resolved paths. Shared containment primitive for the symlink
 * confinement guards (kept in one place so the rule can't drift between files).
 */
export function isPathWithin(child: string, parent: string): boolean {
  return child === parent || child.startsWith(parent + path.sep);
}

/**
 * True when `target` exists and its real (symlink-resolved) path stays within
 * `root`'s real path. Both sides are resolved with `fs.realpathSync` so a
 * symlink in an untrusted source cannot point a read/copy at a file outside
 * the package. Returns false for missing or broken paths.
 */
export function realPathWithin(target: string, root: string): boolean {
  try {
    return isPathWithin(fs.realpathSync(target), fs.realpathSync(root));
  } catch {
    return false;
  }
}

/** Reads a package-relative JSON manifest, or null when absent/unparseable/escaping. */
export function readExtensionManifest(
  extensionDir: string,
  filename: string,
): Record<string, unknown> | null {
  const filePath = path.join(extensionDir, filename);
  if (!fs.existsSync(filePath) || !realPathWithin(filePath, extensionDir)) {
    return null;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    return typeof parsed === 'object' &&
      parsed !== null &&
      !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * Categories of path-confinement violation reported by {@link resolvePathWithin}.
 * Each kind maps to a distinct error message (and a distinct test case).
 */
export type PathViolationKind = 'absolute' | 'escapes' | 'symlink-escape';

/**
 * Resolves `candidate` relative to `root`, confined to `root`: rejects an
 * absolute path, a `..`-laden value that escapes `root`, and a symlink whose
 * real target escapes `root`. Throws an Error whose message is produced by
 * `describe` (keyed by the violation kind) so callers keep precise, contextual
 * errors. Returns the resolved absolute path when the reference is safe.
 */
export function resolvePathWithin(
  root: string,
  candidate: string,
  describe: (kind: PathViolationKind) => string,
): string {
  if (path.isAbsolute(candidate)) {
    throw new Error(describe('absolute'));
  }
  const resolved = path.resolve(root, candidate);
  if (!isPathWithin(resolved, path.resolve(root))) {
    throw new Error(describe('escapes'));
  }
  if (fs.existsSync(resolved) && !realPathWithin(resolved, root)) {
    throw new Error(describe('symlink-escape'));
  }
  return resolved;
}

/**
 * Resolves a plugin-relative file reference, refusing absolute paths or any
 * path that escapes `pluginSource`. Plugin configs come from untrusted sources
 * (arbitrary git repos / marketplaces), so an absolute or `../`-laden value
 * could otherwise make the converter read sensitive files outside the plugin.
 * Returns the confined absolute path, or null when the reference is unsafe.
 */
export function resolvePluginRelativeFile(
  pluginSource: string,
  relativePath: string,
): string | null {
  try {
    return resolvePathWithin(pluginSource, relativePath, (kind) => {
      if (kind === 'absolute') {
        return `Ignoring absolute path "${relativePath}" in plugin config; only paths inside the plugin are allowed.`;
      }
      if (kind === 'escapes') {
        return `Ignoring path "${relativePath}" in plugin config; it escapes the plugin directory.`;
      }
      return `Ignoring path "${relativePath}" in plugin config; it resolves through a symlink outside the plugin directory.`;
    });
  } catch (error) {
    debugLogger.warn(
      `${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
}
