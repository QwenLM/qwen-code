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
 * True when `filePath` exists and is a regular file (not a directory).
 * Single source of truth so a directory-valued path can't slip through a
 * `fs.existsSync` check at one site and be caught at another.
 */
export function isRegularFile(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile();
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
  trustSymlinks = false,
): Record<string, unknown> | null {
  const filePath = path.join(extensionDir, filename);
  if (!fs.existsSync(filePath)) {
    return null;
  }
  if (!isRegularFile(filePath)) {
    throw new Error(
      `Invalid ${stripAnsiAndControl(filename)} at ${stripAnsiAndControl(filePath)}: not a regular file`,
    );
  }
  if (!trustSymlinks && !realPathWithin(filePath, extensionDir)) {
    // A symlinked manifest is only valid for a trusted install (link mode,
    // where the user owns the dev tree); untrusted content must stay confined.
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
        return `Ignoring absolute path "${stripAnsiAndControl(relativePath)}" in plugin config; only paths inside the plugin are allowed.`;
      }
      if (kind === 'escapes') {
        return `Ignoring path "${stripAnsiAndControl(relativePath)}" in plugin config; it escapes the plugin directory.`;
      }
      return `Ignoring path "${stripAnsiAndControl(relativePath)}" in plugin config; it resolves through a symlink outside the plugin directory.`;
    });
  } catch (error) {
    debugLogger.warn(
      stripAnsiAndControl(
        error instanceof Error ? error.message : String(error),
      ),
    );
    return null;
  }
}

/**
 * Why each null path produces what kind of failure. Used by the onNull
 * callback so callers can pick a precise throw/warn message instead of
 * the generic "file could not be read" fallback.
 */
export type ExtraJsonNullReason =
  /** Absolute path resolves through a symlink outside the extension. */
  | 'absolute-symlink-escape'
  /** Absolute path resolves to a file outside the extension. */
  | 'absolute-outside'
  /** Relative `..` traversal: link-mode honors it (falls through to
   * `missing`); strict mode funnels through resolvePathWithin → throws
   * → caught here. No `relative-dotdot` reason exists. */
  | 'confinement-threw'
  /** File does not exist at the resolved path. */
  | 'missing'
  /** Resolved path is a directory, not a regular file. Without this
   * classification the EISDIR from `readFileSync` surfaces as a misleading
   * `parse-error`; `isRegularFile` rejects the same slip for hooks. */
  | 'directory'
  /** `JSON.parse` threw on the file body. */
  | 'parse-error'
  /** File parsed to a non-object (null / array / scalar). */
  | 'non-object-body';

export interface ExtraJsonNullContext {
  /** The original fileRef passed in (sanitized for embedding in messages). */
  readonly safeFileRef: string;
  /** Underlying throw, when applicable (parse error / confinement). */
  readonly cause?: unknown;
}

export type ExtraJsonNullHandler = (
  reason: ExtraJsonNullReason,
  context: ExtraJsonNullContext,
) => void;

export function readExtraJsonFile(
  extensionDir: string,
  fileRef: string,
  trustSymlinks = false,
  onNull: ExtraJsonNullHandler | null = null,
): Record<string, unknown> | null {
  // onNull is opt-in: callers that want to surface the specific rejection
  // reason (e.g. throw a precise message) provide one; default behavior
  // is unchanged — readExtraJsonFile itself emits the warn.
  const safeRef = stripAnsiAndControl(fileRef);
  const reportNull = (reason: ExtraJsonNullReason, cause?: unknown) => {
    if (onNull) {
      onNull(reason, { safeFileRef: safeRef, cause });
    } else {
      const msg = defaultNullMessage(reason, safeRef, cause);
      if (msg !== null) debugLogger.warn(msg);
    }
    return null;
  };
  let filePath: string;
  if (path.isAbsolute(fileRef)) {
    // Distinguish a genuine symlink escape from a plain absolute path
    // outside the extension, so the warning names the actual violation.
    // Trusted link-mode follows the user's own symlinks.
    if (
      !trustSymlinks &&
      fs.existsSync(fileRef) &&
      !realPathWithin(fileRef, extensionDir)
    ) {
      const isSymlink = (() => {
        try {
          return fs.lstatSync(fileRef).isSymbolicLink();
        } catch {
          return false;
        }
      })();
      return reportNull(
        isSymlink ? 'absolute-symlink-escape' : 'absolute-outside',
      );
    }
    filePath = fileRef;
  } else {
    if (trustSymlinks) {
      // Link-mode honors `..` to a sibling monorepo file the same way it
      // honors an absolute path. !existsSync below surfaces missing as
      // `missing` (debug-only, no warn).
      const resolved = path.resolve(extensionDir, fileRef);
      filePath = resolved;
    } else {
      try {
        filePath = resolvePathWithin(extensionDir, fileRef, (kind) => {
          if (kind === 'escapes') {
            return `Ignoring path "${stripAnsiAndControl(fileRef)}"; it escapes the extension directory.`;
          }
          return `Ignoring path "${stripAnsiAndControl(fileRef)}"; it resolves through a symlink outside the extension directory.`;
        });
      } catch (error) {
        return reportNull('confinement-threw', error);
      }
    }
  }
  if (!fs.existsSync(filePath)) {
    return reportNull('missing');
  }
  if (!isRegularFile(filePath)) {
    return reportNull('directory');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch (error) {
    return reportNull('parse-error', error);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return reportNull('non-object-body');
  }
  return parsed as Record<string, unknown>;
}

/**
 * Default warn message per null reason. Returns null for `missing`
 * (silent under tolerant semantics — callers wanting it pass onNull).
 */
function defaultNullMessage(
  reason: ExtraJsonNullReason,
  safeFileRef: string,
  cause?: unknown,
): string | null {
  switch (reason) {
    case 'absolute-symlink-escape':
      return `Ignoring "${safeFileRef}"; it resolves through a symlink outside the extension.`;
    case 'absolute-outside':
      return `Ignoring "${safeFileRef}"; it is outside the extension directory.`;
    case 'confinement-threw':
      return stripAnsiAndControl(
        cause instanceof Error ? cause.message : String(cause),
      );
    case 'missing':
      return null;
    case 'directory':
      return `Ignoring "${safeFileRef}"; it is a directory, not a regular file.`;
    case 'parse-error':
      return `Failed to parse ${safeFileRef}: ${stripAnsiAndControl(cause instanceof Error ? cause.message : String(cause))}`;
    case 'non-object-body':
      return `Invalid ${safeFileRef}: expected a JSON object`;
    default: {
      const exhaustive: never = reason;
      return exhaustive;
    }
  }
}
