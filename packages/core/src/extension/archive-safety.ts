/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { pipeline } from 'node:stream/promises';
import * as tar from 'tar';
import { stripAnsiAndControl } from '../utils/textUtils.js';

const MAX_REPORTED_ENTRY_PATH_LENGTH = 200;
const MAX_REPORTED_LINK_ENTRIES = 10;
const MAX_LINK_ENTRIES = 100;
export const MAX_ARCHIVE_ENTRIES = 100_000;
export const MAX_ARCHIVE_EXPANDED_BYTES = 1024 * 1024 * 1024;

export interface TarArchiveSafetyOptions {
  /**
   * Enforce the entry-count and expanded-size ceilings. Kept off by default
   * so local, npm, and release archives keep their pre-existing behavior;
   * enable it only for untrusted network archives such as the older-Git
   * public GitHub archive fallback.
   */
  enforceResourceLimits?: boolean;
  /**
   * Accept symbolic-link entries that point directly to regular files in the
   * archive, instead of rejecting every link entry. Kept off by default so
   * local, npm, and release archives keep their pre-existing fail-closed
   * behavior; enable it only for the public GitHub archive fallback.
   * Callers that move or flatten the extracted tree must then run
   * `assertDirectorySymlinksAreSafe` against the final layout.
   *
   * Hard links stay unsupported either way: a hard-link entry names another
   * archive entry rather than a path on disk, so it needs a different
   * containment argument than the one made here.
   */
  allowContainedSymlinks?: boolean;
}

const WINDOWS_ABSOLUTE_PATH = /^(?:[a-zA-Z]:|\\)/;
const REGULAR_FILE_TYPES = new Set(['File', 'OldFile', 'ContiguousFile']);

interface AcceptedSymlink {
  entryPath: string;
  targetPath: string;
}

interface ArchiveEntry {
  size: number;
  type: string;
}

/**
 * Decide containment from the archive's own entry paths rather than from the
 * extracted tree. The judgement has to hold before anything is written, and
 * the destination directory may not exist yet, so no filesystem state is
 * consulted and no link is ever followed to make this call.
 */
function resolveContainedSymlinkTarget(
  entryPath: string,
  linkPath: string | undefined,
): string | undefined {
  if (!linkPath) return undefined;
  const normalizedEntryPath = entryPath.replaceAll('\\', '/');
  const normalizedLinkPath = linkPath.replaceAll('\\', '/');
  if (
    path.posix.isAbsolute(normalizedEntryPath) ||
    WINDOWS_ABSOLUTE_PATH.test(entryPath) ||
    path.posix.isAbsolute(normalizedLinkPath) ||
    WINDOWS_ABSOLUTE_PATH.test(linkPath)
  ) {
    return undefined;
  }
  // Resolve the target against the directory holding the link, so that
  // `docs/link.md -> ../real.md` stays inside while a root-level
  // `link.md -> ../real.md` does not.
  const normalizedEntry = path.posix.normalize(normalizedEntryPath);
  const containingDirectory = path.posix.dirname(normalizedEntry);
  const resolved = path.posix.normalize(
    path.posix.join(containingDirectory, normalizedLinkPath),
  );
  if (
    resolved === '.' ||
    resolved === '..' ||
    resolved.startsWith('../') ||
    normalizedEntry === resolved ||
    normalizedEntry.startsWith(`${resolved}/`)
  ) {
    return undefined;
  }
  return resolved;
}

function formatEntryPath(entryPath: string): string {
  const sanitized = stripAnsiAndControl(entryPath);
  if (sanitized.length <= MAX_REPORTED_ENTRY_PATH_LENGTH) return sanitized;
  return `${sanitized.slice(0, MAX_REPORTED_ENTRY_PATH_LENGTH - 3)}...`;
}

function isContainedPath(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative !== '' &&
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

export async function assertTarArchiveLinksAreSafe(
  file: string,
  signal?: AbortSignal,
  options: TarArchiveSafetyOptions = {},
): Promise<void> {
  const enforceResourceLimits = options.enforceResourceLimits === true;
  const allowContainedSymlinks = options.allowContainedSymlinks === true;
  const unsupportedLinkPaths: string[] = [];
  const acceptedSymlinks: AcceptedSymlink[] = [];
  const archiveEntries = new Map<string, ArchiveEntry>();
  let unsupportedLinkCount = 0;
  let linkCount = 0;
  let entryCount = 0;
  let expandedBytes = 0;
  let validationError: Error | undefined;
  const recordUnsupportedLink = (entryPath: string) => {
    unsupportedLinkCount += 1;
    if (unsupportedLinkPaths.length < MAX_REPORTED_LINK_ENTRIES) {
      unsupportedLinkPaths.push(
        formatEntryPath(entryPath) || '<sanitized empty path>',
      );
    }
  };
  // Stop reading as soon as validation fails instead of walking the rest of
  // a potentially hostile archive.
  const failValidation = (error: Error) => {
    if (validationError) return;
    validationError = error;
    stream.destroy();
  };
  const onReadEntry = (entry: tar.ReadEntry) => {
    if (validationError) return;
    const entryPath = path.posix.normalize(entry.path.replaceAll('\\', '/'));
    if (allowContainedSymlinks) {
      if (archiveEntries.has(entryPath)) {
        failValidation(
          new Error(
            `Tar archive contains duplicate entry path: ${formatEntryPath(entry.path)}`,
          ),
        );
        return;
      }
      archiveEntries.set(entryPath, { size: entry.size, type: entry.type });
    }
    if (enforceResourceLimits) {
      entryCount += 1;
      expandedBytes += entry.size;
      if (entryCount > MAX_ARCHIVE_ENTRIES) {
        failValidation(
          new Error(
            `Tar archive contains more than ${MAX_ARCHIVE_ENTRIES} entries.`,
          ),
        );
        return;
      }
      if (expandedBytes > MAX_ARCHIVE_EXPANDED_BYTES) {
        failValidation(
          new Error(
            `Tar archive expands beyond ${MAX_ARCHIVE_EXPANDED_BYTES} bytes.`,
          ),
        );
        return;
      }
    }
    if (entry.type === 'SymbolicLink' || entry.type === 'Link') {
      linkCount += 1;
      if (linkCount > MAX_LINK_ENTRIES) {
        const linkLabel = allowContainedSymlinks
          ? 'link entries.'
          : `unsupported link entries: ${unsupportedLinkPaths.join(', ')}`;
        failValidation(
          new Error(
            `Tar archive contains more than ${MAX_LINK_ENTRIES} ${linkLabel}`,
          ),
        );
        return;
      }
      // Hard links stay unsupported even here: the entry names another
      // archive entry rather than a path on disk, which needs a different
      // containment argument than the one made for symlinks.
      if (allowContainedSymlinks && entry.type === 'SymbolicLink') {
        const targetPath = resolveContainedSymlinkTarget(
          entry.path,
          entry.linkpath,
        );
        if (targetPath) {
          acceptedSymlinks.push({ entryPath, targetPath });
          return;
        }
      }
      recordUnsupportedLink(entry.path);
    }
  };
  signal?.throwIfAborted();
  // Open the stream only after the abort check: entering with a pre-aborted
  // signal must not leave a live ReadStream behind (an unhandled ENOENT
  // 'error' event for a missing file, or a leaked fd otherwise).
  const stream = fs.createReadStream(file);
  try {
    await pipeline(stream, tar.t({ onReadEntry }), { signal });
  } catch (error) {
    signal?.throwIfAborted();
    if (validationError) throw validationError;
    throw error;
  }
  signal?.throwIfAborted();
  if (validationError) throw validationError;
  const hasArchiveDescendant = (entryPath: string) => {
    for (const candidatePath of archiveEntries.keys()) {
      if (candidatePath.startsWith(`${entryPath}/`)) return true;
    }
    return false;
  };
  for (const link of acceptedSymlinks) {
    const target = archiveEntries.get(link.targetPath);
    if (
      hasArchiveDescendant(link.entryPath) ||
      !target ||
      !REGULAR_FILE_TYPES.has(target.type)
    ) {
      recordUnsupportedLink(link.entryPath);
      continue;
    }
    if (enforceResourceLimits) {
      // copyExtension dereferences links later, so each accepted link can
      // materialize another full copy of its target.
      expandedBytes += target.size;
      if (expandedBytes > MAX_ARCHIVE_EXPANDED_BYTES) {
        throw new Error(
          `Tar archive expands beyond ${MAX_ARCHIVE_EXPANDED_BYTES} bytes.`,
        );
      }
    }
  }
  if (unsupportedLinkCount > 0) {
    const entryLabel =
      unsupportedLinkCount === 1
        ? 'unsupported link entry'
        : `${unsupportedLinkCount} unsupported link entries`;
    throw new Error(
      `Tar archive contains ${entryLabel}: ${unsupportedLinkPaths.join(', ')}`,
    );
  }
}

export async function assertDirectorySymlinksAreSafe(
  root: string,
): Promise<void> {
  const resolvedRoot = path.resolve(root);
  const realRoot = await fs.promises.realpath(root);
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await fs.promises.readdir(directory, {
      withFileTypes: true,
    })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(entryPath);
        continue;
      }
      if (!entry.isSymbolicLink()) continue;
      const targetPath = path.resolve(
        path.dirname(entryPath),
        await fs.promises.readlink(entryPath),
      );
      let realTarget: string | undefined;
      try {
        realTarget = await fs.promises.realpath(targetPath);
      } catch {
        realTarget = undefined;
      }
      const targetStat =
        isContainedPath(resolvedRoot, targetPath) &&
        realTarget &&
        isContainedPath(realRoot, realTarget)
          ? await fs.promises.stat(realTarget)
          : undefined;
      if (!targetStat?.isFile()) {
        throw new Error(
          `Tar archive contains unsupported link entry: ${formatEntryPath(path.relative(resolvedRoot, entryPath))}`,
        );
      }
    }
  };
  await visit(resolvedRoot);
}
