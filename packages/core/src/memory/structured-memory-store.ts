/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview Structured storage operations for the auto-memory system.
 *
 * Provides read-only helpers for the memory directory. Write operations
 * are performed by the agent directly via Write/Edit tools.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { getConfigHomeDir } from '../utils/paths.js';
import { FRONTMATTER_REGEX } from '../utils/frontmatterParsers.js';
import type { MemoryEntry, MemoryType } from './types.js';
import type { Storage } from '../config/storage.js';
import type { Config } from '../config/config.js';

/**
 * Name of the per-root memory index file. Exported so consumers (e.g. the
 * background extraction counter) can exclude mechanical index touches from the
 * set of "saved memories" — the user-visible memory is the topic file, not the
 * MEMORY.md pointer update.
 */
export const MEMORY_INDEX_FILENAME = 'MEMORY.md';
const VALID_MEMORY_TYPES = new Set<MemoryType>([
  'user',
  'feedback',
  'project',
  'reference',
]);

/** The scope a memory root belongs to: cross-project (`user`) or per-project. */
export type MemoryScope = 'user' | 'project';

/** A resolved auto-memory root: its scope plus absolute directory path. */
export interface ScopedAutoMemoryDir {
  scope: MemoryScope;
  dir: string;
}

/**
 * Returns the PROJECT-scope auto-memory directory for the current project:
 * `~/.qwen/projects/{proj}/memory/` (flat, no `auto/` subdir). This root is
 * shared with the experimental skill-extraction service's artifacts
 * (`skills/`, `.extraction.lock`, `.extraction-state.json`); those never
 * collide with memory topic files because the listing helpers below only pick
 * up top-level `.md` files (excluding `MEMORY.md` and dotfiles). See
 * docs/design/cross-session-memory-dual-root.md §9.
 */
export function getAutoMemoryDir(storage: Storage): string {
  return storage.getProjectMemoryTempDir();
}

/**
 * Returns the USER-scope (cross-project) auto-memory directory:
 * `~/.qwen/memory/` (flat, no `auto/` subdir). Symmetric with the per-project
 * root so that topic-file resolution and staleness logic work identically
 * across scopes.
 */
export function getUserAutoMemoryDir(): string {
  return path.join(getConfigHomeDir(), 'memory');
}

/**
 * Returns the independently enabled auto-memory roots in injection order.
 * USER precedes PROJECT when both scopes are active.
 */
export function getScopedAutoMemoryDirs(config: Config): ScopedAutoMemoryDir[] {
  const dirs: ScopedAutoMemoryDir[] = [];
  if (config.isAutoMemoryUserScopeEnabled()) {
    dirs.push({ scope: 'user', dir: getUserAutoMemoryDir() });
  }
  if (config.isAutoMemoryProjectScopeEnabled?.() ?? true) {
    dirs.push({ scope: 'project', dir: getAutoMemoryDir(config.storage) });
  }
  return dirs;
}

/**
 * Returns every local auto-memory root the CLI knows how to recognize. Unlike
 * getScopedAutoMemoryDirs(), this is for classifying file operations and deltas,
 * not for deciding which scopes are active for injection or generation.
 */
export function getKnownAutoMemoryDirs(config: Config): ScopedAutoMemoryDir[] {
  return [
    { scope: 'user', dir: getUserAutoMemoryDir() },
    { scope: 'project', dir: getAutoMemoryDir(config.storage) },
  ];
}

/**
 * Returns true if `absolutePath` is inside any active auto-memory root.
 * Used by the Read tool to attach staleness notes and by the Write tool to
 * scope-validate memory writes. Honors USER scope when enabled.
 */
export function isAutoMemoryFile(
  absolutePath: string,
  config: Config,
): boolean {
  const normalized = path.normalize(absolutePath);
  return getScopedAutoMemoryDirs(config).some(({ dir }) => {
    const rel = path.relative(dir, normalized);
    return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
  });
}

/**
 * Extracts the literal `type:` value from a memory file's frontmatter, or
 * undefined when there is no frontmatter / no `type` line. Unlike
 * {@link parseMemoryFileContent}, this does NOT coerce a missing or invalid
 * type to `'project'` — scope validation must treat "no declared type" as a
 * floating memory the model is free to route, not a pinned project memory.
 */
export function getFrontmatterMemoryType(content: string): string | undefined {
  const match = content.match(FRONTMATTER_REGEX);
  if (!match) return undefined;
  const frontmatterBlock = match[1] ?? '';
  for (const line of frontmatterBlock.split('\n')) {
    const colonIdx = line.indexOf(':');
    if (colonIdx <= 0) continue;
    if (line.slice(0, colonIdx).trim() !== 'type') continue;
    const value = line.slice(colonIdx + 1).trim();
    return value || undefined;
  }
  return undefined;
}

/**
 * Layer-two hard guard for auto-memory writes (see Phase B scope routing).
 *
 * Returns a corrective error string when a write is misrouted, or null when it
 * is allowed. Only the two PINNED types are enforced:
 *   - `type: user` must land in the USER root,
 *   - `type: project` must land in the PROJECT root.
 * Floating types (`feedback`/`reference`) and content with no declared type are
 * always allowed — their USER/PROJECT placement is a semantic judgment left to
 * the model (the layer-one prompt routing).
 *
 * A pinned type whose matching scope is disabled is rejected rather than being
 * written into the remaining active root. Paths outside active roots are not
 * handled here.
 */
export function validateAutoMemoryWriteScope(
  absolutePath: string,
  content: string,
  config: Config,
): string | null {
  const activeDirs = getScopedAutoMemoryDirs(config);
  const knownDirs = getKnownAutoMemoryDirs(config);
  const normalized = path.normalize(absolutePath);
  const target = knownDirs.find(({ dir }) => {
    const rel = path.relative(dir, normalized);
    return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
  });
  if (!target) return null; // not an auto-memory file

  if (!activeDirs.some(({ scope }) => scope === target.scope)) {
    return `The ${target.scope}-scope auto-memory directory is disabled.`;
  }

  const pinnedType = getFrontmatterMemoryType(content);
  if (pinnedType !== 'user' && pinnedType !== 'project') return null; // floating
  if (pinnedType === target.scope) return null; // correctly routed

  const correctDir = activeDirs.find((d) => d.scope === pinnedType)?.dir;
  return (
    `Memory of \`type: ${pinnedType}\` must be saved in the ${pinnedType}-scope ` +
    `auto-memory directory, not the ${target.scope}-scope one. ` +
    (correctDir
      ? `Write it under \`${correctDir}/\` instead.`
      : `The ${pinnedType}-scope directory is not active.`)
  );
}

/**
 * Ensures the auto-memory directory exists.
 */
export async function ensureAutoMemoryDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

/**
 * Parses a memory file's frontmatter and body into a MemoryEntry.
 */
export async function readMemoryFile(filePath: string): Promise<MemoryEntry> {
  const raw = await fs.readFile(filePath, 'utf8');
  return parseMemoryFileContent(raw, filePath);
}

/**
 * Parses raw file content into a MemoryEntry.
 */
export function parseMemoryFileContent(
  raw: string,
  filePath?: string,
): MemoryEntry {
  const match = raw.match(FRONTMATTER_REGEX);
  if (!match) {
    return {
      name: filePath ? path.basename(filePath, '.md') : 'unknown',
      description: '',
      type: 'project',
      filePath,
      content: raw.trim(),
    };
  }

  const frontmatterBlock = match[1] ?? '';
  const body = match[2] ?? '';

  // Simple YAML key-value parser (avoids js-yaml dependency for lightweight use)
  const fm: Record<string, string> = {};
  for (const line of frontmatterBlock.split('\n')) {
    const colonIdx = line.indexOf(':');
    if (colonIdx > 0) {
      const key = line.slice(0, colonIdx).trim();
      const value = line.slice(colonIdx + 1).trim();
      fm[key] = value;
    }
  }

  const parsedType = fm['type'] as MemoryType;

  return {
    name: fm['name'] || (filePath ? path.basename(filePath, '.md') : 'unknown'),
    description: fm['description'] || '',
    type: VALID_MEMORY_TYPES.has(parsedType) ? parsedType : 'project',
    filePath,
    content: body.trim(),
  };
}

/**
 * Lists all memory files in the auto-memory directory (excludes MEMORY.md).
 */
export async function listMemoryFiles(dir: string): Promise<MemoryEntry[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return [];
  }

  const mdFiles = entries.filter(
    (f) =>
      f.endsWith('.md') && f !== MEMORY_INDEX_FILENAME && !f.startsWith('.'),
  );

  const results = await Promise.all(
    mdFiles.map(async (filename) => {
      const filePath = path.join(dir, filename);
      try {
        return await readMemoryFile(filePath);
      } catch {
        return null;
      }
    }),
  );

  return results.filter((r): r is MemoryEntry => r !== null);
}

/**
 * Lists just the filenames in the auto-memory directory (no content parsing).
 * Use this when you only need names, not full MemoryEntry data.
 */
export async function listMemoryFileNames(dir: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return [];
  }
  return entries.filter(
    (f) =>
      f.endsWith('.md') && f !== MEMORY_INDEX_FILENAME && !f.startsWith('.'),
  );
}

/**
 * Deletes a memory file by path.
 */
export async function deleteMemoryFile(filePath: string): Promise<void> {
  await fs.unlink(filePath);
}

/**
 * Returns the path to the MEMORY.md index file.
 */
export function getMemoryIndexPath(dir: string): string {
  return path.join(dir, MEMORY_INDEX_FILENAME);
}
