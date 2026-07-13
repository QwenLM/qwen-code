/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

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

export async function assertTarArchiveHasNoLinks(file: string): Promise<void> {
  const unsupportedLinkPaths: string[] = [];
  let unsupportedLinkCount = 0;
  await tar.t({
    file,
    onReadEntry: (entry) => {
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
    },
  });
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
