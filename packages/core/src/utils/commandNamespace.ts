/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import nodePath from 'node:path';

const SEGMENT_RE = /[/\\]+/;

/**
 * Minimal `path` surface used by namespace derivation. Injectable so tests can
 * substitute `path.posix` or `path.win32` regardless of the host OS.
 */
export interface PathImpl {
  relative(from: string, to: string): string;
  isAbsolute(p: string): boolean;
  dirname(p: string): string;
  basename(p: string, ext?: string): string;
}

export interface DeriveCommandNameInput {
  /** Absolute path of the markdown file backing the command. */
  filePath: string;
  /** Absolute path of the command search root (the `commands` directory). */
  baseDir: string;
  /** Whether `filePath` points at a `SKILL.md` (case-insensitive caller check). */
  isSkillFile: boolean;
  /** Optional plugin name; when provided, becomes the identity prefix. */
  pluginName?: string;
  /** Override path implementation (default: `node:path`). */
  path?: PathImpl;
}

export interface DerivedCommandName {
  /** Stable identity used for command registration / lookup. */
  identity: string;
  /** Display base (without plugin prefix), suitable as a UI fallback. */
  displayBase: string;
  /** The `:` joined namespace segments, or `''` when the file sits at baseDir. */
  namespace: string;
  /** Leaf segment after sanitization. */
  leaf: string;
}

/**
 * Derive a stable command identity from a file path relative to its search
 * root. Returns `null` when the file cannot be turned into a usable command
 * (empty leaf, sanitized plugin prefix collapses to empty, or the input is a
 * `baseDir/SKILL.md` at the root with no namespace context).
 */
export function deriveCommandName(
  opts: DeriveCommandNameInput,
): DerivedCommandName | null {
  const p: PathImpl = opts.path ?? nodePath;
  const { filePath, baseDir, isSkillFile, pluginName } = opts;

  const targetDir = isSkillFile
    ? p.dirname(p.dirname(filePath))
    : p.dirname(filePath);

  const namespace = pathToNamespace(targetDir, baseDir, p);
  const leaf = isSkillFile
    ? p.basename(p.dirname(filePath))
    : p.basename(filePath, '.md');
  if (!leaf) return null;

  // Root-level `commands/SKILL.md` is ambiguous (no namespace and the leaf
  // would just be the baseDir's own name).
  if (
    isSkillFile &&
    namespace === '' &&
    p.dirname(filePath) === stripTrailingSep(baseDir)
  ) {
    return null;
  }

  const displayBase = namespace ? `${namespace}:${leaf}` : leaf;

  let identity: string;
  if (pluginName !== undefined) {
    if (!pluginName) return null;
    identity = `${pluginName}:${displayBase}`;
  } else {
    identity = displayBase;
  }
  return { identity, displayBase, namespace, leaf };
}

/**
 * Convert a directory path relative to `baseDir` into a `:` joined namespace
 * string. Returns `''` when `targetDir === baseDir`, when the relative path
 * escapes the base, or when the relative path is absolute (Windows different
 * drive / UNC).
 */
export function pathToNamespace(
  targetDir: string,
  baseDir: string,
  p: PathImpl = nodePath,
): string {
  const normTarget = stripTrailingSep(targetDir);
  const normBase = stripTrailingSep(baseDir);
  if (normTarget === normBase) return '';

  const rel = p.relative(normBase, normTarget);
  if (
    rel === '' ||
    rel === '..' ||
    rel.startsWith('../') ||
    rel.startsWith('..\\') ||
    p.isAbsolute(rel)
  ) {
    return '';
  }
  return rel.split(SEGMENT_RE).filter(Boolean).join(':');
}

function stripTrailingSep(s: string): string {
  return s.replace(/[/\\]+$/, '');
}
