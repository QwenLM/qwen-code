/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import { pipeline } from 'node:stream/promises';
import * as tar from 'tar';
import { stripAnsiAndControl } from '../utils/textUtils.js';

const MAX_REPORTED_ENTRY_PATH_LENGTH = 200;
const MAX_REPORTED_LINK_ENTRIES = 10;
const MAX_LINK_ENTRIES = 100;
const MAX_ARCHIVE_ENTRIES = 100_000;
const MAX_ARCHIVE_EXPANDED_BYTES = 1024 * 1024 * 1024;

function formatEntryPath(entryPath: string): string {
  const sanitized = stripAnsiAndControl(entryPath);
  if (sanitized.length <= MAX_REPORTED_ENTRY_PATH_LENGTH) return sanitized;
  return `${sanitized.slice(0, MAX_REPORTED_ENTRY_PATH_LENGTH - 3)}...`;
}

export async function assertTarArchiveHasNoLinks(
  file: string,
  signal?: AbortSignal,
): Promise<void> {
  const unsupportedLinkPaths: string[] = [];
  let unsupportedLinkCount = 0;
  let entryCount = 0;
  let expandedBytes = 0;
  let validationError: Error | undefined;
  const onReadEntry = (entry: tar.ReadEntry) => {
    entryCount += 1;
    expandedBytes += entry.size;
    if (entryCount > MAX_ARCHIVE_ENTRIES) {
      validationError ??= new Error(
        `Tar archive contains more than ${MAX_ARCHIVE_ENTRIES} entries.`,
      );
    } else if (expandedBytes > MAX_ARCHIVE_EXPANDED_BYTES) {
      validationError ??= new Error(
        `Tar archive expands beyond ${MAX_ARCHIVE_EXPANDED_BYTES} bytes.`,
      );
    }
    if (entry.type === 'SymbolicLink' || entry.type === 'Link') {
      unsupportedLinkCount += 1;
      const unsupportedLinkPath =
        formatEntryPath(entry.path) || '<sanitized empty path>';
      if (unsupportedLinkPaths.length < MAX_REPORTED_LINK_ENTRIES) {
        unsupportedLinkPaths.push(unsupportedLinkPath);
      }
      if (unsupportedLinkCount > MAX_LINK_ENTRIES) {
        validationError ??= new Error(
          `Tar archive contains more than ${MAX_LINK_ENTRIES} unsupported link entries: ${unsupportedLinkPaths.join(', ')}`,
        );
      }
    }
  };
  signal?.throwIfAborted();
  if (signal) {
    try {
      await pipeline(fs.createReadStream(file), tar.t({ onReadEntry }), {
        signal,
      });
    } catch (error) {
      signal.throwIfAborted();
      throw error;
    }
    signal.throwIfAborted();
  } else {
    await tar.t({ file, onReadEntry });
  }
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
