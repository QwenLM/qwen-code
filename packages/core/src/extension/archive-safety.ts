/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as tar from 'tar';
import { stripAnsiAndControl } from '../utils/textUtils.js';

const MAX_REPORTED_ENTRY_PATH_LENGTH = 200;

function formatEntryPath(entryPath: string): string {
  const sanitized = stripAnsiAndControl(entryPath);
  if (sanitized.length <= MAX_REPORTED_ENTRY_PATH_LENGTH) return sanitized;
  return `${sanitized.slice(0, MAX_REPORTED_ENTRY_PATH_LENGTH - 3)}...`;
}

export async function assertTarArchiveHasNoLinks(file: string): Promise<void> {
  const unsupportedLinkPaths: string[] = [];
  await tar.t({
    file,
    onReadEntry: (entry) => {
      if (entry.type === 'SymbolicLink' || entry.type === 'Link') {
        const unsupportedLinkPath =
          formatEntryPath(entry.path) || '<sanitized empty path>';
        unsupportedLinkPaths.push(unsupportedLinkPath);
      }
    },
  });
  if (unsupportedLinkPaths.length > 0) {
    const entryLabel =
      unsupportedLinkPaths.length === 1
        ? 'unsupported link entry'
        : `${unsupportedLinkPaths.length} unsupported link entries`;
    throw new Error(
      `Tar archive contains ${entryLabel}: ${unsupportedLinkPaths.join(', ')}`,
    );
  }
}
