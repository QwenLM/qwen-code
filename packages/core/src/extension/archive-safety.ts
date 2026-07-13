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
const MAX_LINK_ENTRIES_BEFORE_ABORT = 100;

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
  const onReadEntry = (entry: tar.ReadEntry) => {
    if (entry.type === 'SymbolicLink' || entry.type === 'Link') {
      unsupportedLinkCount += 1;
      const unsupportedLinkPath =
        formatEntryPath(entry.path) || '<sanitized empty path>';
      if (unsupportedLinkPaths.length < MAX_REPORTED_LINK_ENTRIES) {
        unsupportedLinkPaths.push(unsupportedLinkPath);
      }
      if (unsupportedLinkCount > MAX_LINK_ENTRIES_BEFORE_ABORT) {
        throw new Error(
          `Tar archive contains more than ${MAX_LINK_ENTRIES_BEFORE_ABORT} unsupported link entries: ${unsupportedLinkPaths.join(', ')}`,
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
