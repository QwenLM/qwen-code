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
   * Accept symbolic-link entries whose targets provably resolve inside the
   * archive root, instead of rejecting every link entry. Kept off by default
   * so local, npm, and release archives keep their pre-existing fail-closed
   * behavior; enable it only for the public GitHub archive fallback, which
   * has to install repositories that legitimately carry in-repo symlinks.
   *
   * Hard links stay unsupported either way: a hard-link entry names another
   * archive entry rather than a path on disk, so it needs a different
   * containment argument than the one made here.
   */
  allowContainedSymlinks?: boolean;
}

// A drive-qualified or backslash-rooted target is absolute on Windows even
// though `path.posix.isAbsolute` reads it as relative. Tar paths are always
// posix-separated, so this is checked explicitly rather than via `path`.
const WINDOWS_ABSOLUTE_LINK_TARGET = /^(?:[a-zA-Z]:|\\)/;

/**
 * Decide containment from the archive's own entry paths rather than from the
 * extracted tree. The judgement has to hold before anything is written, and
 * the destination directory may not exist yet, so no filesystem state is
 * consulted and no link is ever followed to make this call.
 */
function isContainedSymlinkTarget(
  entryPath: string,
  linkPath: string | undefined,
): boolean {
  if (!linkPath) return false;
  if (path.posix.isAbsolute(linkPath)) return false;
  if (WINDOWS_ABSOLUTE_LINK_TARGET.test(linkPath)) return false;
  // Resolve the target against the directory holding the link, so that
  // `docs/link.md -> ../real.md` stays inside while a root-level
  // `link.md -> ../real.md` does not.
  const containingDirectory = path.posix.dirname(entryPath);
  const resolved = path.posix.normalize(
    path.posix.join(containingDirectory, linkPath),
  );
  return resolved !== '..' && !resolved.startsWith('../');
}

function formatEntryPath(entryPath: string): string {
  const sanitized = stripAnsiAndControl(entryPath);
  if (sanitized.length <= MAX_REPORTED_ENTRY_PATH_LENGTH) return sanitized;
  return `${sanitized.slice(0, MAX_REPORTED_ENTRY_PATH_LENGTH - 3)}...`;
}

export async function assertTarArchiveLinksAreSafe(
  file: string,
  signal?: AbortSignal,
  options: TarArchiveSafetyOptions = {},
): Promise<void> {
  const enforceResourceLimits = options.enforceResourceLimits === true;
  const allowContainedSymlinks = options.allowContainedSymlinks === true;
  const unsupportedLinkPaths: string[] = [];
  let unsupportedLinkCount = 0;
  let entryCount = 0;
  let expandedBytes = 0;
  let validationError: Error | undefined;
  // Stop reading as soon as validation fails instead of walking the rest of
  // a potentially hostile archive.
  const failValidation = (error: Error) => {
    if (validationError) return;
    validationError = error;
    stream.destroy();
  };
  const onReadEntry = (entry: tar.ReadEntry) => {
    if (validationError) return;
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
      // Hard links stay unsupported even here: the entry names another
      // archive entry rather than a path on disk, which needs a different
      // containment argument than the one made for symlinks.
      if (
        allowContainedSymlinks &&
        entry.type === 'SymbolicLink' &&
        isContainedSymlinkTarget(entry.path, entry.linkpath)
      ) {
        return;
      }
      unsupportedLinkCount += 1;
      const unsupportedLinkPath =
        formatEntryPath(entry.path) || '<sanitized empty path>';
      if (unsupportedLinkPaths.length < MAX_REPORTED_LINK_ENTRIES) {
        unsupportedLinkPaths.push(unsupportedLinkPath);
      }
      if (unsupportedLinkCount > MAX_LINK_ENTRIES) {
        failValidation(
          new Error(
            `Tar archive contains more than ${MAX_LINK_ENTRIES} unsupported link entries: ${unsupportedLinkPaths.join(', ')}`,
          ),
        );
      }
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
