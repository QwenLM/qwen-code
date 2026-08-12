/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createDebugLogger } from '../utils/debugLogger.js';
import { stripAnsiAndControl } from '../utils/textUtils.js';

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

/**
 * Reads a package-relative JSON manifest. Returns null when the file is
 * absent; throws a precise error when it exists but is unparseable, is not a
 * JSON object, or resolves through a symlink outside the package. Callers use
 * null to mean "no such manifest" and rely on the throw to surface a defective
 * one instead of silently treating it as absent.
 * @param extensionDir The extension package directory
 * @param filename The manifest filename relative to the package
 * @returns The parsed manifest object, or null when absent
 */
export function readExtensionManifest(
  extensionDir: string,
  filename: string,
): Record<string, unknown> | null {
  const filePath = path.join(extensionDir, filename);
  if (!fs.existsSync(filePath)) {
    return null;
  }
  if (!realPathWithin(filePath, extensionDir)) {
    throw new Error(
      `${stripAnsiAndControl(filename)} at ${stripAnsiAndControl(filePath)} resolves through a symlink outside the package`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch (error) {
    throw new Error(
      `Invalid ${stripAnsiAndControl(filename)} at ${stripAnsiAndControl(filePath)}: ${stripAnsiAndControl(error instanceof Error ? error.message : String(error))}`,
    );
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(
      `Invalid ${stripAnsiAndControl(filename)} at ${stripAnsiAndControl(filePath)}: expected a JSON object`,
    );
  }
  return parsed as Record<string, unknown>;
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

/**
 * Leniently reads a subsidiary JSON file (hooks/mcp/lsp) inside an extension
 * dir. `fileRef` may be absolute (must stay within `extensionDir`) or relative;
 * a missing file returns null; an unparseable body, a non-object body, or a
 * path escaping the extension logs a warning and returns null. Core manifests
 * use the strict {@link readExtensionManifest} (defects throw).
 */
export function readExtraJsonFile(
  extensionDir: string,
  fileRef: string,
): Record<string, unknown> | null {
  let filePath: string;
  if (path.isAbsolute(fileRef)) {
    // Absolute path: only an existing file can escape via symlink; a missing
    // one is ignored by the existsSync below.
    if (fs.existsSync(fileRef) && !realPathWithin(fileRef, extensionDir)) {
      debugLogger.warn(
        `Ignoring "${fileRef}"; it resolves through a symlink outside the extension.`,
      );
      return null;
    }
    filePath = fileRef;
  } else {
    try {
      filePath = resolvePathWithin(extensionDir, fileRef, (kind) => {
        if (kind === 'escapes') {
          return `Ignoring path "${fileRef}"; it escapes the extension directory.`;
        }
        return `Ignoring path "${fileRef}"; it resolves through a symlink outside the extension directory.`;
      });
    } catch (error) {
      debugLogger.warn(
        `${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }
  if (!fs.existsSync(filePath)) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch (error) {
    debugLogger.warn(
      `Failed to parse ${stripAnsiAndControl(fileRef)}: ${stripAnsiAndControl(error instanceof Error ? error.message : String(error))}`,
    );
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    debugLogger.warn(
      `Invalid ${stripAnsiAndControl(fileRef)}: expected a JSON object`,
    );
    return null;
  }
  return parsed as Record<string, unknown>;
}
