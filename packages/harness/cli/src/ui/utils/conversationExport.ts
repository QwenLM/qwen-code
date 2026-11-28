/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import path from 'node:path';
import type { Message } from '@qwen-code/core';
import { extractFirstUserMessage } from '../../utils/sessionUtils.js';

const MAX_EXPORT_FILENAME_CHARS = 255;
const EXPORT_FILE_EXTENSION = '.txt';

function truncateExportSlug(
  slug: string,
  timestamp: string,
  extension: string = EXPORT_FILE_EXTENSION,
): string {
  const reserved = timestamp.length + 1 + extension.length;
  const maxSlugLength = Math.max(MAX_EXPORT_FILENAME_CHARS - reserved, 0);
  return slug.slice(0, maxSlugLength).replace(/-+$/u, '');
}

// Re-export the React-based renderer as the primary renderMessagesToPlainText
export { renderMessagesToPlainText } from './exportRenderer.js';

export function formatExportTimestamp(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const seconds = String(date.getSeconds()).padStart(2, '0');
  return `${year}-${month}-${day}-${hours}${minutes}${seconds}`;
}

export function sanitizeExportFilename(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/[\s-]+/g, '-')
    .replace(/^-|-$/g, '');
}

export function normalizeExportFilename(filename: string): string {
  const trimmed = filename.trim();
  if (!trimmed) {
    return 'conversation.txt';
  }

  const ext = path.extname(trimmed);
  if (!ext) {
    return `${trimmed}.txt`;
  }

  return `${trimmed.slice(0, -ext.length)}.txt`;
}

export function buildDefaultExportFilename(
  messages: readonly Message[],
  now: Date = new Date(),
): string {
  const firstPrompt = extractFirstUserMessage(messages);
  const timestamp = formatExportTimestamp(now);
  const sanitized = truncateExportSlug(
    sanitizeExportFilename(firstPrompt),
    timestamp,
  );
  if (sanitized) {
    return `${timestamp}-${sanitized}${EXPORT_FILE_EXTENSION}`;
  }
  return `conversation-${timestamp}.txt`;
}
