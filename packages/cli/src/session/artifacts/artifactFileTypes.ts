/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as path from 'node:path';

/**
 * CLI artifact eligibility policy for automatic discovery. Explicit
 * present_files calls carry an authoritative delivery intent and may register
 * other regular files with an unspecified MIME type.
 */
const DISCOVERABLE_MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  '.md': 'text/markdown',
  '.markdown': 'text/markdown',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.html': 'text/html',
  '.doc': 'application/msword',
  '.docx':
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx':
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx':
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

export function artifactMimeForPath(pathname: string): string | undefined {
  return DISCOVERABLE_MIME_BY_EXTENSION[
    path.extname(pathname).toLowerCase()
  ];
}
