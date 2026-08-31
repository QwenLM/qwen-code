/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { pipeline } from 'node:stream/promises';
import * as tar from 'tar';
import { isSubpath } from '../utils/paths.js';
import { stripAnsiAndControl } from '../utils/textUtils.js';

const MAX_REPORTED_ENTRY_PATH_LENGTH = 200;
const MAX_REPORTED_LINK_ENTRIES = 10;
const MAX_LINK_ENTRIES = 100;
export const MAX_ARCHIVE_ENTRIES = 100_000;
export const MAX_ARCHIVE_EXPANDED_BYTES = 1024 * 1024 * 1024;
export const MAX_ARCHIVE_PATH_BYTES = 8 * 1024 * 1024;

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
  type: string;
}

function normalizeArchiveEntryPath(entryPath: string): string {
  const normalized = path.posix.normalize(
    process.platform === 'win32' ? entryPath.replaceAll('\\', '/') : entryPath,
  );
  return normalized.length > 1 ? normalized.replace(/\/+$/, '') : normalized;
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
  if (!linkPath || linkPath.includes('\\')) return undefined;
  const normalizedEntry = normalizeArchiveEntryPath(entryPath);
  if (
    normalizedEntry === '.' ||
    normalizedEntry === '..' ||
    normalizedEntry.startsWith('../') ||
    path.posix.isAbsolute(normalizedEntry) ||
    WINDOWS_ABSOLUTE_PATH.test(entryPath) ||
    path.posix.isAbsolute(linkPath) ||
    WINDOWS_ABSOLUTE_PATH.test(linkPath)
  ) {
    return undefined;
  }
  // Resolve the target against the directory holding the link, so that
  // `docs/link.md -> ../real.md` stays inside while a root-level
  // `link.md -> ../real.md` does not.
  const containingDirectory = path.posix.dirname(normalizedEntry);
  const resolved = path.posix.normalize(
    path.posix.join(containingDirectory, linkPath),
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
  return isSubpath(root, candidate) && path.relative(root, candidate) !== '';
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
  let retainedPathBytes = 0;
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
  // Shared by both the entry-path and the accepted-link-target accounting
  // below, so the two stay under one budget instead of silently drifting.
  const exceedsRetainedPathBudget = (value: string): boolean => {
    retainedPathBytes += Buffer.byteLength(value);
    if (retainedPathBytes > MAX_ARCHIVE_PATH_BYTES) {
      failValidation(
        new Error(
          `Tar archive path metadata exceeds ${MAX_ARCHIVE_PATH_BYTES} bytes.`,
        ),
      );
      return true;
    }
    return false;
  };
  const onReadEntry = (entry: tar.ReadEntry) => {
    if (validationError) return;
    const entryPath = normalizeArchiveEntryPath(entry.path);
    if (allowContainedSymlinks) {
      if (archiveEntries.has(entryPath)) {
        failValidation(
          new Error(
            `Tar archive contains duplicate entry path: ${formatEntryPath(entry.path)}`,
          ),
        );
        return;
      }
      if (exceedsRetainedPathBudget(entryPath)) return;
      archiveEntries.set(entryPath, { type: entry.type });
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
          if (exceedsRetainedPathBudget(targetPath)) return;
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
  const archiveEntryPaths = [...archiveEntries.keys()].sort();
  const hasArchiveDescendant = (entryPath: string) => {
    const prefix = `${entryPath}/`;
    let low = 0;
    let high = archiveEntryPaths.length;
    while (low < high) {
      signal?.throwIfAborted();
      const middle = Math.floor((low + high) / 2);
      if (archiveEntryPaths[middle]! < prefix) {
        low = middle + 1;
      } else {
        high = middle;
      }
    }
    return archiveEntryPaths[low]?.startsWith(prefix) === true;
  };
  for (const link of acceptedSymlinks) {
    signal?.throwIfAborted();
    const target = archiveEntries.get(link.targetPath);
    if (
      hasArchiveDescendant(link.entryPath) ||
      !target ||
      !REGULAR_FILE_TYPES.has(target.type)
    ) {
      recordUnsupportedLink(link.entryPath);
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
  signal?: AbortSignal,
  options: { maxExpandedBytes?: number; excludePath?: string } = {},
): Promise<void> {
  signal?.throwIfAborted();
  const resolvedRoot = path.resolve(root);
  const realRoot = await fs.promises.realpath(root);
  const excludedPath = options.excludePath
    ? path.resolve(options.excludePath)
    : undefined;
  let expandedBytes = 0;
  const accountForMaterializedFile = (size: number) => {
    if (options.maxExpandedBytes === undefined) return;
    expandedBytes += size;
    if (expandedBytes > options.maxExpandedBytes) {
      throw new Error(
        `Tar archive expands beyond ${options.maxExpandedBytes} bytes.`,
      );
    }
  };
  const visit = async (directory: string): Promise<void> => {
    for (const entryName of await fs.promises.readdir(directory)) {
      signal?.throwIfAborted();
      const entryPath = path.join(directory, entryName);
      if (entryPath === excludedPath) continue;
      const entryStat = await fs.promises.lstat(entryPath);
      if (entryStat.isDirectory()) {
        await visit(entryPath);
        continue;
      }
      if (entryStat.isFile()) {
        accountForMaterializedFile(entryStat.size);
        continue;
      }
      if (!entryStat.isSymbolicLink()) {
        throw new Error(
          `Extracted directory tree contains unsupported entry: ${formatEntryPath(path.relative(resolvedRoot, entryPath))}`,
        );
      }
      const linkPath = await fs.promises.readlink(entryPath);
      const targetPath = path.resolve(path.dirname(entryPath), linkPath);
      const rawTargetPath = `${path.dirname(entryPath)}${path.sep}${linkPath}`;
      let targetSize: number | undefined;
      let statError: unknown;
      try {
        if (
          !path.isAbsolute(linkPath) &&
          !WINDOWS_ABSOLUTE_PATH.test(linkPath) &&
          isContainedPath(resolvedRoot, targetPath)
        ) {
          const targetStat = await fs.promises.lstat(rawTargetPath);
          const realTarget = await fs.promises.realpath(entryPath);
          if (targetStat.isFile() && isContainedPath(realRoot, realTarget)) {
            targetSize = targetStat.size;
          }
        }
      } catch (error) {
        signal?.throwIfAborted();
        targetSize = undefined;
        // Not-contained is a normal rejection; anything else (EMFILE from fd
        // exhaustion, EACCES from a restrictive mount, a flaky-disk EIO) is a
        // local resource failure, not evidence of a hostile archive. Keep it
        // on the thrown error below so it doesn't get misdiagnosed as one.
        statError = error;
      }
      signal?.throwIfAborted();
      if (targetSize === undefined) {
        throw new Error(
          `Extracted directory tree contains unsupported link entry: ${formatEntryPath(path.relative(resolvedRoot, entryPath))}`,
          { cause: statError },
        );
      }
      accountForMaterializedFile(targetSize);
    }
  };
  await visit(resolvedRoot);
  signal?.throwIfAborted();
}
