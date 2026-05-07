/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

const STANDALONE_ARCHIVE_PREFIX = 'qwen-code-';
const STANDALONE_ARCHIVE_EXTENSIONS = ['.tar.gz', '.zip'];

function isStandaloneArchiveName(fileName) {
  return (
    fileName.startsWith(STANDALONE_ARCHIVE_PREFIX) &&
    STANDALONE_ARCHIVE_EXTENSIONS.some((extension) =>
      fileName.endsWith(extension),
    )
  );
}

export { isStandaloneArchiveName };
